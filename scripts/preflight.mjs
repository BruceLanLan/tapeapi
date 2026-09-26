#!/usr/bin/env node
// Read-only pre-deploy check for BNB Smart Chain. Runs every question we can answer WITHOUT
// spending anything, against two independent RPCs, and exits non-zero if anything is off.
// 部署前只读检查：在两个独立 RPC 上做多数一致校验，任何一项不对即以非零码退出。不发送任何交易。
//
//   node scripts/preflight.mjs                       # reads env / 读环境变量
//   node scripts/preflight.mjs --deployer 0xabc...   # or flags / 或命令行参数
//
// Env / flags (flags win / 命令行优先):
//   DEPLOYER        the address that will sign the deploy (required) / 将要签名部署的地址（必填）
//   HUB FACTORY DOMAIN_BINDING           ServiceDirectory constructor args
//   BEM TREASURY                         TapeAPIEscrow constructor args (only with DEPLOY_ESCROW)
//   DEPLOY_ESCROW   "true" to also check the escrow / 同时检查托管合约
//   RPC_URLS        comma-separated, >= 2 / 逗号分隔，至少两个
//   QUORUM          how many RPCs must agree (default = number of RPCs) / 需一致的 RPC 数
//   EXPECT_SAMPLE_LIVE  expected isContainerLive(sample) from a non-zero DOMAIN_BINDING, default true
//                       非零 DOMAIN_BINDING 对样本容器的预期激活状态，默认 true
//   ALLOW_OTHER_HUB "true" to accept a HUB other than the canonical one (testnet / fork only)
//                   接受非规范 HUB，仅用于测试网与分叉
//
// It NEVER needs a private key: pass the deployer's ADDRESS only.
// 它永远不需要私钥，只需要部署者地址。

import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// ---------------------------------------------------------------- constants ----

const CHAIN_ID = 56
const EIP170_LIMIT = 24576

// Known-good sample, verified live on chainId 56 on 2026-09-21: circuit 4246 on the factory's
// processor #0 derives this container. Same probe as contracts/script/Deploy.s.sol.
// 已知样本（2026-09-21 主网核实），与 Deploy.s.sol 使用同一探针。
const PROBE_TOKEN_ID = 4246n
const PROBE_CONTAINER = '0x86ddaef00401e3f10418398d67d7189fc458ea95'

// The canonical DeWebHub on chain 56. A wrong hub is the most expensive mistake available here: it
// breaks the container primary key AND the delegation signing domain, and it is immutable.
// chain 56 上的规范 DeWebHub。hub 填错是这里代价最高的错误：同时破坏容器主键与委托签名域，且不可更改。
const CANONICAL_HUB = '0xe61a9c7213a6aa616c246a2b569e555b417b25ee'

const DEFAULT_RPCS = [
  'https://bsc-dataseed.bnbchain.org',
  'https://bsc-rpc.publicnode.com',
  'https://bsc-dataseed1.defibit.io',
]

// The build that script/Deploy.s.sol actually deploys. / 部署脚本真正上链的那一份构建产物。
const FORGE_ARTIFACTS = {
  ServiceDirectory: 'contracts/out-forge/ServiceDirectory.sol/ServiceDirectory.json',
  TapeAPIEscrow: 'contracts/out-forge/TapeAPIEscrow.sol/TapeAPIEscrow.json',
}
// The solc-js build (npm run compile). Informational only -- see the note printed below.
// solc-js 构建，仅供参考。
const SOLCJS_ARTIFACTS = {
  ServiceDirectory: 'contracts/out/ServiceDirectory.json',
  TapeAPIEscrow: 'contracts/out/TapeAPIEscrow.json',
}
const EXPECTED_EVM_VERSION = 'paris'
const EXPECTED_COMPILER = '0.8.28+commit.7893614a'

// -------------------------------------------------------------------- utils ----

let keccak256 = null   // set once in main(); used for selectors and for artifact source hashes
let failures = 0
let warnings = 0
const ok = (msg) => console.log(`  \x1b[32mOK\x1b[0m    ${msg}`)
const warn = (msg) => { warnings++; console.log(`  \x1b[33mWARN\x1b[0m  ${msg}`) }
const fail = (msg) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m  ${msg}`) }
const info = (msg) => console.log(`        ${msg}`)
const head = (msg) => console.log(`\n\x1b[1m${msg}\x1b[0m`)

const argv = process.argv.slice(2)
function flag(name) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined
}
function cfg(name, envName = name.toUpperCase().replaceAll('-', '_')) {
  return flag(name) ?? process.env[envName]
}

const isAddress = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a)
const lower = (a) => (a ?? '').toLowerCase()
const ZERO = '0x0000000000000000000000000000000000000000'

const pad32 = (hexNo0x) => hexNo0x.padStart(64, '0')
const addrArg = (a) => pad32(lower(a).slice(2))
const uintArg = (n) => pad32(BigInt(n).toString(16))
const wordToAddress = (word) => '0x' + word.slice(-40)

function fmtBnb(wei) {
  const s = (BigInt(wei) * 10n ** 6n / 10n ** 18n).toString().padStart(7, '0')
  return `${s.slice(0, -6) || '0'}.${s.slice(-6)} BNB`
}
function fmtGwei(wei) {
  return `${Number(BigInt(wei)) / 1e9} gwei`
}

// ------------------------------------------------------------------ rpc ----

async function rpcCall(url, method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const j = await res.json()
  if (j.error) throw new Error(`${j.error.code}: ${j.error.message}`)
  return j.result
}

/// Ask every RPC and report agreement. Never throws: a dead RPC becomes `{ error }`.
/// 向每个 RPC 提问并统计一致性；单个 RPC 失败不抛异常。
async function askAll(urls, method, params) {
  const settled = await Promise.all(urls.map(async (u) => {
    try { return { url: u, value: await rpcCall(u, method, params) } }
    catch (e) { return { url: u, error: e.message } }
  }))
  const values = settled.filter((s) => !s.error)
  const distinct = [...new Set(values.map((v) => JSON.stringify(v.value)))]
  return { settled, values, distinct, agreed: distinct.length === 1 ? values[0]?.value : undefined }
}

/// A quorum read: the value must come back identical from at least `quorum` RPCs.
/// 多数一致读：至少 `quorum` 个 RPC 返回完全相同的值。
async function quorumRead(urls, quorum, label, method, params) {
  const r = await askAll(urls, method, params)
  for (const s of r.settled) if (s.error) warn(`${label}: ${new URL(s.url).host} unreachable (${s.error})`)
  if (r.values.length < quorum) {
    fail(`${label}: only ${r.values.length} of ${urls.length} RPCs answered, quorum is ${quorum}`)
    return undefined
  }
  if (r.distinct.length !== 1) {
    fail(`${label}: RPCs DISAGREE -- ${r.values.map((v) => `${new URL(v.url).host}=${JSON.stringify(v.value).slice(0, 40)}`).join(' | ')}`)
    return undefined
  }
  return r.agreed
}

const ethCall = (to, data) => [{ to, data }, 'latest']

// ------------------------------------------------------------- artifacts ----

function loadForgeArtifact(name) {
  const p = join(root, FORGE_ARTIFACTS[name])
  if (!existsSync(p)) {
    fail(`${name}: artifact missing at ${FORGE_ARTIFACTS[name]} -- run \`cd contracts && forge build\` (DEFAULT profile)`)
    return undefined
  }
  const a = JSON.parse(readFileSync(p, 'utf8'))
  const evmVersion = a.metadata?.settings?.evmVersion
  const compiler = a.metadata?.compiler?.version
  const creation = a.bytecode?.object
  const runtime = a.deployedBytecode?.object

  if (evmVersion !== EXPECTED_EVM_VERSION) {
    fail(`${name}: built with evmVersion '${evmVersion}', expected '${EXPECTED_EVM_VERSION}'. Rebuild with the DEFAULT profile (never FOUNDRY_PROFILE=deploy).`)
  }
  if (compiler !== EXPECTED_COMPILER) {
    fail(`${name}: built with solc ${compiler}, expected ${EXPECTED_COMPILER}`)
  }
  if (!creation || creation === '0x' || creation.length < 10) {
    fail(`${name}: artifact has no creation bytecode`)
    return undefined
  }

  // The artifact is what actually goes on chain, so it has to have been built from the source that
  // was audited and tested -- not from whatever the tree looked like the last time someone ran
  // `forge build`. solc records a keccak256 of every input file in the metadata, so this is exact:
  // rehash the files on disk and compare. Nothing else in the pipeline notices a stale artifact,
  // because a stale one still has the right compiler and the right evmVersion.
  // 产物就是上链的那份字节码，因此它必须由"被审计、被测试的那份源码"构建，而不是最后一次
  // `forge build` 时碰巧的工作树。solc 在 metadata 里记录了每个输入文件的 keccak256，所以这项
  // 检查是精确的：重新哈希磁盘上的文件并比对。管线里没有别的环节会发现产物过期——过期的产物
  // 编译器版本和 evmVersion 依然是对的。
  const sources = a.metadata?.settings ? a.metadata?.sources : undefined
  if (!sources || Object.keys(sources).length === 0) {
    fail(`${name}: artifact has no metadata.sources -- cannot prove it was built from the current source. Run \`cd contracts && forge clean && forge build\` (DEFAULT profile).`)
  } else if (!keccak256) {
    warn(`${name}: @noble/hashes unavailable, cannot verify the artifact was built from the current source`)
  } else {
    for (const [rel, meta] of Object.entries(sources)) {
      const sp2 = join(root, 'contracts', rel)
      if (!existsSync(sp2)) { fail(`${name}: artifact was built from ${rel}, which no longer exists`); continue }
      const onDisk = '0x' + Buffer.from(keccak256(readFileSync(sp2))).toString('hex')
      if (lower(onDisk) !== lower(meta.keccak256)) {
        fail(`${name}: STALE ARTIFACT -- contracts/${rel} has changed since this artifact was built (${meta.keccak256} != ${onDisk}). The bytecode about to be deployed is NOT the code that was audited and tested. Run \`cd contracts && forge clean && forge build\` (DEFAULT profile) and re-run \`forge test\`.`)
      } else {
        info(`${name}: ${rel} matches the artifact's recorded keccak256`)
      }
    }
  }
  const runtimeBytes = (runtime.length - 2) / 2
  if (runtimeBytes > EIP170_LIMIT) fail(`${name}: runtime ${runtimeBytes} bytes exceeds the EIP-170 limit of ${EIP170_LIMIT}`)
  else ok(`${name}: solc ${compiler}, evm ${evmVersion}, creation ${(creation.length - 2) / 2} B, runtime ${runtimeBytes} B (EIP-170 limit ${EIP170_LIMIT})`)

  // The npm `solc` dependency floats (^0.8.28 currently resolves to 0.8.37) and compile.mjs sets
  // metadata.bytecodeHash = none, so contracts/out/*.json is a DIFFERENT binary from the one that
  // deploys. That is expected and not an error -- it is just not what goes on chain.
  // npm 的 solc 是浮动版本，且 compile.mjs 设了 bytecodeHash=none，因此 contracts/out/*.json
  // 与上链字节码不同。这是预期的，不是错误，只是它不上链。
  const sp = join(root, SOLCJS_ARTIFACTS[name])
  if (existsSync(sp)) {
    const s = JSON.parse(readFileSync(sp, 'utf8'))
    if (lower(s.bytecode) !== lower(creation)) {
      info(`note: ${SOLCJS_ARTIFACTS[name]} (solc-js ${s.compiler?.version?.split('+')[0]}) differs from the deploying build -- informational, it is NOT deployed`)
    }
  }
  return { creation, runtime, runtimeBytes }
}

// -------------------------------------------------------------------- main ----

async function main() {
  console.log('\x1b[1m=========================================================\x1b[0m')
  console.log('\x1b[1m  TapeAPI deploy preflight / 部署前只读检查\x1b[0m')
  console.log(`  ${new Date().toISOString()}`)
  console.log('\x1b[1m=========================================================\x1b[0m')

  // keccak is needed for both the function selectors and the artifact source hashes, so it is
  // loaded once here rather than in the middle of a section.
  // keccak 同时用于函数选择器与产物源码哈希，故在此一次性加载。
  const noble = await import('@noble/hashes/sha3').catch(() => ({}))
  keccak256 = noble.keccak_256 ?? null
  if (!keccak256) warn('@noble/hashes not available; using hard-coded selectors and skipping the artifact source-hash check')

  // ---- config ----
  const deployer = cfg('deployer', 'DEPLOYER')
  const hub = cfg('hub', 'HUB')
  const factory = cfg('factory', 'FACTORY')
  const domainBinding = cfg('domain-binding', 'DOMAIN_BINDING')
  const bem = cfg('bem', 'BEM')
  const treasury = cfg('treasury', 'TREASURY')
  const deployEscrow = String(cfg('deploy-escrow', 'DEPLOY_ESCROW') ?? 'false') === 'true'
  const urls = (cfg('rpc-urls', 'RPC_URLS') ?? DEFAULT_RPCS.join(',')).split(',').map((s) => s.trim()).filter(Boolean)
  const quorum = Number(cfg('quorum', 'QUORUM') ?? urls.length)

  head('0. Inputs / 输入')
  for (const [label, v, required] of [
    ['DEPLOYER', deployer, true],
    ['HUB', hub, true],
    ['FACTORY', factory, true],
    ['DOMAIN_BINDING', domainBinding, true],
    ['BEM', bem, deployEscrow],
    ['TREASURY', treasury, deployEscrow],
  ]) {
    if (v === undefined || v === '') {
      if (required) fail(`${label} is not set`)
      continue
    }
    if (!isAddress(v)) { fail(`${label} is not a 20-byte address: ${v}`); continue }
    info(`${label.padEnd(15)} ${v}`)
  }
  info(`${'DEPLOY_ESCROW'.padEnd(15)} ${deployEscrow}`)
  // A hard equals sign on the hub, not just "it has code and it answers". The domain-separator
  // comparison in the deploy script only runs once the hub is already right, so it discriminates
  // nothing on its own. ALLOW_OTHER_HUB exists for testnets and forks; on chain 56 it should never
  // be set. / hub 的硬等号，而不只是"有代码且能应答"。部署脚本里的域分隔符比对以 hub 已正确为前提，
  // 本身没有判别力。ALLOW_OTHER_HUB 供测试网与分叉使用，主网上不应设置。
  const allowOtherHub = String(cfg('allow-other-hub', 'ALLOW_OTHER_HUB') ?? 'false') === 'true'
  if (isAddress(hub) && lower(hub) !== CANONICAL_HUB) {
    if (allowOtherHub) warn(`HUB ${hub} is not the canonical DeWebHub ${CANONICAL_HUB}; ALLOW_OTHER_HUB is set, so this is a testnet/fork run`)
    else fail(`HUB ${hub} is not the canonical DeWebHub ${CANONICAL_HUB} for chain ${CHAIN_ID}. A wrong hub breaks the container primary key AND the delegation signing domain, and it is immutable. Set ALLOW_OTHER_HUB=true only on a testnet or a fork.`)
  } else if (isAddress(hub)) {
    ok(`HUB is the canonical DeWebHub ${CANONICAL_HUB}`)
  }
  if (urls.length < 2) fail(`RPC_URLS has ${urls.length} entry; at least 2 independent RPCs are required`)
  if (quorum < 2) fail(`QUORUM is ${quorum}; at least 2 is required`)
  if (quorum > urls.length) fail(`QUORUM ${quorum} > ${urls.length} RPC URLs`)
  info(`${'RPCs'.padEnd(15)} ${urls.map((u) => new URL(u).host).join(', ')}  (quorum ${quorum})`)
  if (failures) return finish()

  // ---- 1. chain identity ----
  head('1. Chain identity / 链身份')
  const chainIds = await askAll(urls, 'eth_chainId', [])
  for (const s of chainIds.settled) {
    if (s.error) { warn(`${new URL(s.url).host}: unreachable (${s.error})`); continue }
    const id = Number(BigInt(s.value))
    if (id !== CHAIN_ID) fail(`${new URL(s.url).host}: chainId ${id}, expected ${CHAIN_ID} -- WRONG NETWORK`)
    else ok(`${new URL(s.url).host}: chainId ${id}`)
  }
  if (chainIds.values.length < quorum) fail(`only ${chainIds.values.length} of ${urls.length} RPCs reachable, quorum is ${quorum}`)
  const live = chainIds.values.map((v) => v.url)
  // Block heights legitimately differ by a block or two (BSC makes a block every ~0.75s), so this
  // is never an exact-match check -- only a "nobody is badly stale" check.
  // 各 RPC 高度本就会差一两个块（BSC 约 0.75 秒一块），这里只检查有没有节点严重落后。
  const heights = await askAll(live, 'eth_blockNumber', [])
  const hs = heights.values.map((v) => ({ host: new URL(v.url).host, n: BigInt(v.value) }))
  info(`heights: ${hs.map((h) => `${h.host}=${h.n}`).join(', ')}`)
  if (hs.length) {
    const max = hs.map((h) => h.n).reduce((a, b) => (a > b ? a : b))
    const stale = hs.filter((h) => max - h.n > 50n)
    if (stale.length) fail(`stale RPC(s): ${stale.map((h) => `${h.host} is ${max - h.n} blocks behind`).join(', ')}`)
    else ok(`all RPCs within 50 blocks of head (${max})`)
  }

  // ---- 2. constructor-arg addresses have code ----
  head('2. Constructor-arg addresses / 构造函数参数地址')
  const argAddrs = [
    ['HUB', hub, 'required'],
    ['FACTORY', factory, 'required'],
    ['DOMAIN_BINDING', domainBinding, 'zero-or-code'],
    ...(deployEscrow ? [['BEM', bem, 'required'], ['TREASURY', treasury, 'may-be-eoa']] : []),
  ]
  for (const [label, addr, kind] of argAddrs) {
    if (kind === 'zero-or-code' && lower(addr) === ZERO) {
      warn(`${label} is the zero address -- the ServiceDirectory activation gate will be PERMANENTLY DISABLED (immutable). Intended? / 激活门槛将永久关闭且不可更改，确认这是有意的`)
      continue
    }
    const codes = await askAll(live, 'eth_getCode', [addr, 'latest'])
    for (const s of codes.settled) if (s.error) warn(`${label}: ${new URL(s.url).host} getCode failed (${s.error})`)
    if (codes.values.length < quorum) { fail(`${label}: only ${codes.values.length} RPCs answered getCode, quorum ${quorum}`); continue }
    if (codes.distinct.length !== 1) {
      fail(`${label}: RPCs return DIFFERENT code for ${addr} -- ${codes.values.map((v) => `${new URL(v.url).host}=${((v.value.length - 2) / 2)}B`).join(' | ')}`)
      continue
    }
    const bytes = (codes.agreed.length - 2) / 2
    if (bytes === 0) {
      if (kind === 'may-be-eoa') warn(`${label} ${addr} has no code (EOA). A treasury EOA is allowed, but a multisig is safer. / 允许 EOA，但多签更稳妥`)
      else fail(`${label} ${addr} has NO CODE on chain ${CHAIN_ID} -- wrong address or wrong network`)
    } else {
      ok(`${label} ${addr}: ${bytes} bytes of code, identical on ${codes.values.length} RPCs`)
    }
  }

  // ---- 3. the hub and the factory actually work and agree ----
  head('3. Live probe: hub + factory / 链上探针')
  // Fallbacks, used only when @noble/hashes is missing. Every one of these is the real keccak
  // prefix of the signature beside it -- the previous values were not, so a preflight run without
  // @noble/hashes probed four selectors that exist on nothing.
  // 仅在缺少 @noble/hashes 时使用的回退值。以下每个都是右侧签名真实的 keccak 前缀——此前的值都不是，
  // 于是没有 @noble/hashes 的预检会去调用四个根本不存在的选择器。
  const SEL = {
    cpuCount: '0xa94da8a7',        // cpuCount()
    cpus: '0xd2c26963',            // cpus(uint256)
    isCPU: '0x5f5a364f',           // isCPU(address)
    accountOf: '0x0c1905e5',       // accountOf(address,uint256)
    isContainerLive: '0xdcca979e', // isContainerLive(address)
  }
  // Selectors are recomputed from the signatures at runtime so a typo above cannot pass silently.
  // 选择器在运行时由签名重算，避免手抄出错。
  if (keccak256) {
    const sel = (sig) => '0x' + Buffer.from(keccak256(new TextEncoder().encode(sig))).toString('hex').slice(0, 8)
    SEL.cpuCount = sel('cpuCount()')
    SEL.cpus = sel('cpus(uint256)')
    SEL.isCPU = sel('isCPU(address)')
    SEL.accountOf = sel('accountOf(address,uint256)')
    SEL.isContainerLive = sel('isContainerLive(address)')
  }

  let probeOk = false
  const cpuCount = await quorumRead(live, quorum, 'factory.cpuCount()', 'eth_call', ethCall(factory, SEL.cpuCount))
  if (cpuCount !== undefined) {
    const n = BigInt(cpuCount)
    if (n === 0n) fail('factory.cpuCount() == 0 -- is this really the circuits factory?')
    else ok(`factory.cpuCount() = ${n}`)

    const cpu0 = await quorumRead(live, quorum, 'factory.cpus(0)', 'eth_call', ethCall(factory, SEL.cpus + uintArg(0)))
    if (cpu0) {
      const processor = wordToAddress(cpu0)
      ok(`factory.cpus(0) = ${processor}`)

      const isCpu = await quorumRead(live, quorum, 'factory.isCPU(processor)', 'eth_call', ethCall(factory, SEL.isCPU + addrArg(processor)))
      if (isCpu !== undefined && BigInt(isCpu) === 1n) ok('factory.isCPU(cpus(0)) = true')
      else fail(`factory.isCPU(cpus(0)) is not true (${isCpu}) -- the isCPU gate is inconsistent`)

      const isCpuNeg = await quorumRead(live, quorum, 'factory.isCPU(hub)', 'eth_call', ethCall(factory, SEL.isCPU + addrArg(hub)))
      if (isCpuNeg !== undefined && BigInt(isCpuNeg) === 0n) ok('factory.isCPU(HUB) = false (the gate discriminates)')
      else fail(`factory.isCPU(HUB) is not false (${isCpuNeg}) -- the isCPU gate would not stop counterfeit ERC-721s`)

      const acc = await quorumRead(live, quorum, `hub.accountOf(processor, ${PROBE_TOKEN_ID})`, 'eth_call',
        ethCall(hub, SEL.accountOf + addrArg(processor) + uintArg(PROBE_TOKEN_ID)))
      if (acc) {
        const container = wordToAddress(acc)
        if (container === PROBE_CONTAINER) { ok(`hub.accountOf(cpus(0), ${PROBE_TOKEN_ID}) = ${container} == known sample`); probeOk = true }
        else fail(`hub.accountOf(cpus(0), ${PROBE_TOKEN_ID}) = ${container}, expected the known sample ${PROBE_CONTAINER} -- wrong HUB, wrong FACTORY or wrong chain`)
      }
    }
  }
  if (!probeOk) fail('the hub/factory probe did not complete -- do NOT deploy')

  // The activation gate gets the same two-sided treatment as isCPU: one check that it implements the
  // interface at all, one check that the ANSWER it gives is the one operations expects. `code.length
  // > 0` was the only check before, and a contract with code but no `isContainerLive(address)` makes
  // ServiceDirectory.isLive permanently false -- i.e. every label permanently unclaimable, on an
  // immutable contract, with a green preflight.
  // 激活门槛与 isCPU 一样做双向检查：一条确认它确实实现了该接口，一条确认它给出的**答案**符合运维预期。
  // 此前只有"有代码"一项，而一个有代码却没有 `isContainerLive(address)` 的合约会让
  // ServiceDirectory.isLive 恒假——在不可升级的合约上，所有标签永久无法占用，而预检全绿。
  if (isAddress(domainBinding) && lower(domainBinding) !== ZERO) {
    const expectSampleLive = String(cfg('expect-sample-live', 'EXPECT_SAMPLE_LIVE') ?? 'true') === 'true'
    const raw = await quorumRead(live, quorum, `domainBinding.isContainerLive(${PROBE_CONTAINER})`, 'eth_call',
      ethCall(domainBinding, SEL.isContainerLive + addrArg(PROBE_CONTAINER)))
    if (raw === undefined) {
      fail('DOMAIN_BINDING.isContainerLive(sample) did not answer -- it is not an IDomainBinding, or the RPCs disagree. Labels would be permanently unclaimable.')
    } else if ((raw.length - 2) / 2 !== 32) {
      fail(`DOMAIN_BINDING.isContainerLive(sample) returned ${(raw.length - 2) / 2} bytes, expected exactly 32 -- not an IDomainBinding, or hostile`)
    } else if (BigInt(raw) > 1n) {
      fail(`DOMAIN_BINDING.isContainerLive(sample) returned a non-boolean word (${raw})`)
    } else {
      const isLive = BigInt(raw) === 1n
      if (isLive !== expectSampleLive) {
        fail(`DOMAIN_BINDING.isContainerLive(${PROBE_CONTAINER}) = ${isLive}, but EXPECT_SAMPLE_LIVE = ${expectSampleLive}. Either DOMAIN_BINDING is not the gate you think it is, or the sample container was deactivated. With the gate on and this false, no label can ever be claimed through this directory.`)
      } else {
        ok(`domainBinding.isContainerLive(sample) = ${isLive} == EXPECT_SAMPLE_LIVE (exactly 32 bytes returned)`)
      }
    }
  }

  // ---- 4. artifacts ----
  head('4. Build artifacts / 构建产物')
  const names = ['ServiceDirectory', ...(deployEscrow ? ['TapeAPIEscrow'] : [])]
  const artifacts = {}
  for (const n of names) artifacts[n] = loadForgeArtifact(n)

  // ---- 5. deployer, gas price, cost ----
  head('5. Deployer, gas price and cost / 部署者、gas 价格与成本')
  const balHex = await quorumRead(live, quorum, 'deployer balance', 'eth_getBalance', [deployer, 'latest'])
  const nonceHex = await quorumRead(live, quorum, 'deployer nonce', 'eth_getTransactionCount', [deployer, 'latest'])
  const balance = balHex === undefined ? 0n : BigInt(balHex)
  if (balHex !== undefined) ok(`deployer ${deployer}: ${fmtBnb(balance)} (${balance} wei), nonce ${Number(BigInt(nonceHex ?? '0x0'))}`)
  const deployerCode = await quorumRead(live, quorum, 'deployer code', 'eth_getCode', [deployer, 'latest'])
  if (deployerCode && deployerCode !== '0x') {
    warn(`deployer ${deployer} HAS CODE -- it is a contract, not an EOA. Both constructors take owner from msg.sender.`)
  }

  const gasPrices = await askAll(live, 'eth_gasPrice', [])
  for (const v of gasPrices.values) info(`gasPrice ${new URL(v.url).host}: ${fmtGwei(BigInt(v.value))}`)
  if (gasPrices.values.length < quorum) fail(`only ${gasPrices.values.length} RPCs returned a gas price, quorum ${quorum}`)
  // Budget on the HIGHEST quoted price, never the average: the point is to not run out.
  // 用最高报价估算，而不是平均值：目的是不要中途没钱。
  const gasPrice = gasPrices.values.length ? gasPrices.values.map((v) => BigInt(v.value)).reduce((a, b) => (a > b ? a : b)) : 0n
  if (gasPrice > 0n) ok(`gas price used for the estimate: ${fmtGwei(gasPrice)} (highest of ${gasPrices.values.length} RPCs)`)

  let totalGas = 0n
  for (const n of names) {
    const a = artifacts[n]
    if (!a) continue
    const args = n === 'ServiceDirectory'
      ? addrArg(hub) + addrArg(factory) + addrArg(domainBinding)
      : addrArg(bem) + addrArg(hub) + addrArg(treasury)
    const initcode = a.creation + args

    // Real eth_estimateGas for a CREATE: `from` + `data`, no `to`.
    // 真实的创建交易 gas 估算：只给 from 与 data，不给 to。
    const est = await askAll(live, 'eth_estimateGas', [{ from: deployer, data: initcode }])
    const good = est.values.map((v) => BigInt(v.value))
    if (good.length === 0) {
      // Some RPCs refuse to estimate when `from` has a zero balance; fall back to the anvil-fork
      // measurement so the operator still gets a budget.
      // 部分 RPC 在 from 余额为 0 时拒绝估算，退回到 anvil 分叉实测值。
      const fallback = n === 'ServiceDirectory' ? 1_698_443n : 1_930_621n
      warn(`${n}: no RPC would eth_estimateGas (${est.settled.map((s) => s.error).filter(Boolean)[0]}); using the anvil-fork measurement ${fallback}`)
      totalGas += fallback
    } else {
      const max = good.reduce((a2, b) => (a2 > b ? a2 : b))
      const min = good.reduce((a2, b) => (a2 < b ? a2 : b))
      if (max !== min) warn(`${n}: RPCs estimate differently (${min}..${max}); budgeting on ${max}`)
      ok(`${n}: eth_estimateGas = ${max} gas (${good.length} RPCs)`)
      totalGas += max
    }
  }

  const cost = totalGas * gasPrice
  head('6. Budget / 预算')
  info(`total gas        ${totalGas}`)
  info(`gas price        ${fmtGwei(gasPrice)}`)
  info(`estimated cost   ${fmtBnb(cost)}`)
  info(`balance          ${fmtBnb(balance)}`)
  // A 10x headroom on a sub-cent deploy costs nothing and covers a gas-price spike between the
  // preflight and the broadcast. 10 倍余量：成本本来就极低，足以覆盖 gas 价格波动。
  const needed = cost * 10n
  if (balance < needed) {
    fail(`balance ${fmtBnb(balance)} is below 10x the estimate (${fmtBnb(needed)}). Top up before deploying.`)
  } else {
    ok(`balance covers 10x the estimate (${fmtBnb(needed)})`)
  }

  finish()
}

function finish() {
  console.log('\n\x1b[1m=========================================================\x1b[0m')
  if (failures > 0) {
    console.log(`\x1b[31m\x1b[1m  PREFLIGHT FAILED: ${failures} problem(s), ${warnings} warning(s)\x1b[0m`)
    console.log('\x1b[31m  预检未通过，请勿部署。\x1b[0m')
    console.log('\x1b[1m=========================================================\x1b[0m')
    process.exit(1)
  }
  console.log(`\x1b[32m\x1b[1m  PREFLIGHT PASSED\x1b[0m  (${warnings} warning(s) -- read them before continuing)`)
  console.log('\x1b[32m  预检通过；请先读完上面的 WARN 再继续。\x1b[0m')
  console.log('\x1b[1m=========================================================\x1b[0m')
  process.exit(0)
}

main().catch((e) => {
  console.error(`\n\x1b[31mpreflight crashed: ${e?.stack || e}\x1b[0m`)
  process.exit(1)
})
