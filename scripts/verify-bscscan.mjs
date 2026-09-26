#!/usr/bin/env node
// Submit ServiceDirectory / TapeAPIEscrow source to BscScan via the Etherscan V2 multichain API.
// 通过 Etherscan V2 多链 API 在 BscScan 上验证两个合约的源码。
//
//   node scripts/verify-bscscan.mjs --directory 0x... --hub 0x... --factory 0x... --domain-binding 0x...
//   node scripts/verify-bscscan.mjs --escrow 0x... --bem 0x... --hub 0x... --treasury 0x...
//   node scripts/verify-bscscan.mjs --check 0x...        # just ask whether an address is verified
//   node scripts/verify-bscscan.mjs --dry-run ...        # build + self-check, submit nothing
//
// ETHERSCAN_API_KEY must be set for anything that submits. `--dry-run` and `--check` of an
// already-verified contract need no key for the local parts.
// 提交需要 ETHERSCAN_API_KEY；--dry-run 的本地部分不需要。
//
// WHY THIS IS NOT JUST "POST THE SOURCE":
// Verification only succeeds if the compiler input we submit reproduces the deployed bytes exactly.
// So before submitting, this script:
//   1. builds the standard-json input from the FORGE artifact's own metadata (solc version,
//      optimizer, evmVersion, metadata.bytecodeHash, remappings) -- i.e. from the settings that
//      produced the bytes that were deployed, not from a second source of truth;
//   2. recompiles that exact input locally with the same solc binary and byte-compares the result
//      to the artifact;
//   3. compares the artifact's runtime code to eth_getCode of the live address, masking the
//      immutable slots (immutables are baked into runtime code and legitimately differ).
// Only if all three pass does it submit. 三步自检全过才提交。
//
// NOTE ON contracts/out/*.json: `npm run compile` uses the floating npm `solc` (^0.8.28, currently
// 0.8.37) with metadata.bytecodeHash = "none". That is a DIFFERENT binary from the one the deploy
// script puts on chain. Verification must follow what was deployed, so this script reads
// contracts/out-forge/. 说明：npm 的 solc 是浮动版本且 bytecodeHash=none，与上链字节码不同；
// 验证必须跟随实际上链的那一份，因此本脚本读取 contracts/out-forge/。

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const CHAIN_ID = 56
const API = 'https://api.etherscan.io/v2/api'
const EXPLORER = 'https://bscscan.com'
const RPC = process.env.RPC_URL || 'https://bsc-dataseed.bnbchain.org'

const CONTRACTS = {
  directory: {
    name: 'ServiceDirectory',
    artifact: 'contracts/out-forge/ServiceDirectory.sol/ServiceDirectory.json',
    sourceName: 'src/ServiceDirectory.sol',
    ctor: ['hub', 'factory', 'domain-binding'],
  },
  escrow: {
    name: 'TapeAPIEscrow',
    artifact: 'contracts/out-forge/TapeAPIEscrow.sol/TapeAPIEscrow.json',
    sourceName: 'src/TapeAPIEscrow.sol',
    ctor: ['bem', 'hub', 'treasury'],
  },
}

// --------------------------------------------------------------------- cli ----

const argv = process.argv.slice(2)
const has = (n) => argv.includes(`--${n}`)
const flag = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined }
const DRY = has('dry-run')

const isAddress = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a)
const lower = (s) => (s ?? '').toLowerCase()
const strip0x = (s) => (s.startsWith('0x') ? s.slice(2) : s)

function die(msg) { console.error(`\x1b[31m${msg}\x1b[0m`); process.exit(1) }
const ok = (m) => console.log(`  \x1b[32mOK\x1b[0m    ${m}`)
const bad = (m) => console.log(`  \x1b[31mFAIL\x1b[0m  ${m}`)
const info = (m) => console.log(`        ${m}`)
const head = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`)

// --------------------------------------------------------------- solc lookup ----

/// Find the solc binary matching the artifact's compiler. Foundry keeps these under
/// ~/Library/Application Support/svm/<ver>/solc-<ver> (macOS) or ~/.svm/<ver>/solc-<ver>.
/// 找到与构建产物版本一致的 solc 可执行文件（foundry 的 svm 目录）。
function findSolc(version) {
  const v = version.split('+')[0]
  const candidates = [
    join(homedir(), 'Library', 'Application Support', 'svm', v, `solc-${v}`),
    join(homedir(), '.svm', v, `solc-${v}`),
  ]
  return candidates.find((p) => existsSync(p))
}

// --------------------------------------------------------- standard json ----

/// Build the Solidity standard-json input from the artifact's OWN metadata, so what we submit is
/// by construction the settings that produced the deployed bytes.
/// 直接用构建产物自带的 metadata 生成 standard-json，确保提交的设置就是产出上链字节码的设置。
function buildStandardJson(spec) {
  const p = join(root, spec.artifact)
  if (!existsSync(p)) die(`artifact missing: ${spec.artifact}\nRun \`cd contracts && forge build\` under the DEFAULT profile first.`)
  const art = JSON.parse(readFileSync(p, 'utf8'))
  const md = art.metadata
  if (!md) die(`${spec.artifact} has no metadata`)

  const sourceNames = Object.keys(md.sources)
  const sources = {}
  for (const sn of sourceNames) {
    // metadata keys sources relative to the foundry project root (contracts/)
    const disk = join(root, 'contracts', sn)
    if (!existsSync(disk)) die(`source file referenced by metadata not found on disk: ${disk}`)
    sources[sn] = { content: readFileSync(disk, 'utf8') }
  }

  const input = {
    language: md.language ?? 'Solidity',
    sources,
    settings: {
      optimizer: md.settings.optimizer,
      evmVersion: md.settings.evmVersion,
      metadata: md.settings.metadata,
      libraries: md.settings.libraries ?? {},
      remappings: md.settings.remappings ?? [],
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
    },
  }
  if (md.settings.viaIR) input.settings.viaIR = true

  return {
    input,
    artifact: art,
    compiler: md.compiler.version,
    contractPath: `${spec.sourceName}:${spec.name}`,
    sourceNames,
  }
}

/// Sanity-check the shape of the standard-json without any network access.
/// 纯本地校验 standard-json 的结构。
function validateShape(built, spec) {
  const i = built.input
  let bad_ = 0
  const need = (cond, msg) => { if (cond) ok(msg); else { bad(msg); bad_++ } }

  need(i.language === 'Solidity', `language == "Solidity"`)
  need(Object.keys(i.sources).length >= 1, `sources: ${Object.keys(i.sources).length} file(s) -- ${Object.keys(i.sources).join(', ')}`)
  need(!!i.sources[spec.sourceName], `sources contains the compilation target key "${spec.sourceName}"`)
  need(Object.values(i.sources).every((s) => typeof s.content === 'string' && s.content.length > 0), 'every source has non-empty content')
  need(i.settings.optimizer?.enabled === true && Number.isInteger(i.settings.optimizer?.runs), `optimizer enabled, runs=${i.settings.optimizer?.runs}`)
  need(typeof i.settings.evmVersion === 'string', `evmVersion = ${i.settings.evmVersion}`)
  need(typeof i.settings.metadata?.bytecodeHash === 'string', `metadata.bytecodeHash = ${i.settings.metadata?.bytecodeHash}`)
  need(/^\d+\.\d+\.\d+\+commit\.[0-9a-f]+$/.test(built.compiler), `compiler = ${built.compiler}`)
  // Every import in every source must resolve to another key in `sources` (after remappings), or
  // the compiler will fail on Etherscan's side with a confusing "File not found".
  // 每个 import 都必须能解析到 sources 里的另一个 key，否则会在对方侧报 File not found。
  let unresolved = []
  for (const [name, s] of Object.entries(i.sources)) {
    for (const m of s.content.matchAll(/import\s+(?:\{[^}]*\}\s+from\s+)?["']([^"']+)["']/g)) {
      const imp = m[1]
      const resolved = imp.startsWith('.')
        ? join(dirname(name), imp).replaceAll('\\', '/')
        : (i.settings.remappings.reduce((acc, r) => {
            const [from, to] = r.split('=')
            return acc.startsWith(from) ? to + acc.slice(from.length) : acc
          }, imp))
      if (!i.sources[resolved]) unresolved.push(`${name} -> ${imp} (${resolved})`)
    }
  }
  need(unresolved.length === 0, unresolved.length ? `unresolved imports: ${unresolved.join('; ')}` : 'every import resolves inside the submitted sources')
  return bad_ === 0
}

/// Recompile the standard-json locally with the same solc and byte-compare to the artifact.
/// This is the check that actually predicts whether BscScan will accept the submission.
/// 用同版本 solc 本地重编译并逐字节比对；这一步才真正预示对方会不会接受。
function localReproduce(built, spec) {
  const solc = findSolc(built.compiler)
  if (!solc) {
    bad(`solc ${built.compiler.split('+')[0]} binary not found under the svm directory -- cannot reproduce locally. Submitting blind is NOT recommended.`)
    return false
  }
  info(`recompiling with ${solc}`)
  let out
  try {
    out = JSON.parse(execFileSync(solc, ['--standard-json'], {
      input: JSON.stringify(built.input),
      maxBuffer: 256 * 1024 * 1024,
      cwd: join(root, 'contracts'),
    }).toString())
  } catch (e) {
    bad(`local solc run failed: ${e.message}`)
    return false
  }
  const errors = (out.errors ?? []).filter((e) => e.severity === 'error')
  if (errors.length) {
    bad(`local recompile produced ${errors.length} error(s):`)
    for (const e of errors) info(e.formattedMessage?.trim())
    return false
  }
  const got = out.contracts?.[spec.sourceName]?.[spec.name]
  if (!got) { bad(`local recompile produced no contract ${spec.sourceName}:${spec.name}`); return false }

  const mine = lower(strip0x(got.evm.deployedBytecode.object))
  const theirs = lower(strip0x(built.artifact.deployedBytecode.object))
  if (mine !== theirs) {
    bad(`local recompile does NOT reproduce the artifact runtime bytecode (${mine.length / 2} B vs ${theirs.length / 2} B)`)
    // Point at the first differing byte; almost always the metadata hash at the tail.
    let k = 0
    while (k < Math.min(mine.length, theirs.length) && mine[k] === theirs[k]) k++
    info(`first difference at byte ${Math.floor(k / 2)} of ${theirs.length / 2}`)
    return false
  }
  ok(`local recompile reproduces the artifact byte-for-byte (${theirs.length / 2} B runtime)`)
  return true
}

// -------------------------------------------------------------- chain check ----

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  })
  const j = await res.json()
  if (j.error) throw new Error(`${j.error.code}: ${j.error.message}`)
  return j.result
}

/// Compare the artifact's runtime code to the code actually on chain, masking immutable slots.
/// Immutables are written into the runtime code at construction, so those byte ranges MUST differ.
/// 比对构建产物与链上运行时代码，屏蔽 immutable 槽位（这些字节本就应该不同）。
async function matchOnChain(built, address) {
  let onchain
  try { onchain = lower(strip0x(await rpc('eth_getCode', [address, 'latest']))) }
  catch (e) { bad(`eth_getCode failed: ${e.message}`); return false }
  if (onchain.length === 0) { bad(`${address} has no code on chain ${CHAIN_ID}`); return false }

  const local = lower(strip0x(built.artifact.deployedBytecode.object))
  if (onchain.length !== local.length) {
    bad(`on-chain code is ${onchain.length / 2} B but the artifact runtime is ${local.length / 2} B -- this address is NOT this contract`)
    return false
  }
  const refs = built.artifact.deployedBytecode.immutableReferences ?? {}
  const masked = new Set()
  let slots = 0
  for (const rs of Object.values(refs)) for (const r of rs) {
    slots++
    for (let b = r.start; b < r.start + r.length; b++) { masked.add(b * 2); masked.add(b * 2 + 1) }
  }
  let diff = 0
  for (let k = 0; k < local.length; k++) if (!masked.has(k) && local[k] !== onchain[k]) diff++
  if (diff) { bad(`${diff} nibble(s) differ outside the ${slots} immutable slot(s) -- wrong bytecode at ${address}`); return false }
  ok(`on-chain code at ${address} matches the artifact (${local.length / 2} B, ${slots} immutable slot(s) masked)`)
  return true
}

// ----------------------------------------------------------------- etherscan ----

function apiKey(required = true) {
  const k = process.env.ETHERSCAN_API_KEY
  if (!k && required) die('ETHERSCAN_API_KEY is not set.\nGet a free key at https://etherscan.io/myapikey -- the V2 API is multichain, one key covers BscScan (chainid=56).')
  return k
}

async function apiGet(params, key) {
  const u = new URL(API)
  u.searchParams.set('chainid', String(CHAIN_ID))
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
  if (key) u.searchParams.set('apikey', key)
  const res = await fetch(u, { signal: AbortSignal.timeout(30_000) })
  const text = await res.text()
  try { return { http: res.status, json: JSON.parse(text) } }
  catch { return { http: res.status, raw: text } }
}

async function apiPost(params, key) {
  const u = new URL(API)
  u.searchParams.set('chainid', String(CHAIN_ID))
  const body = new URLSearchParams({ ...params, apikey: key })
  const res = await fetch(u, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(60_000),
  })
  const text = await res.text()
  try { return { http: res.status, json: JSON.parse(text) } }
  catch { return { http: res.status, raw: text } }
}

/// Ask whether an address is already verified. Doubles as an endpoint smoke test: an unverified
/// TapeOut contract must come back with a clear "not verified", which proves the endpoint works.
/// 查询某地址是否已验证；对未验证合约应返回明确的 "not verified"，可用来确认端点可用。
async function checkVerified(address) {
  const key = apiKey(false)
  const r = await apiGet({ module: 'contract', action: 'getsourcecode', address }, key)
  if (r.raw !== undefined) { info(`HTTP ${r.http}, non-JSON response: ${String(r.raw).slice(0, 300)}`); return undefined }
  const j = r.json
  if (j.status !== '1') {
    info(`HTTP ${r.http}  status=${j.status}  message=${j.message}  result=${JSON.stringify(j.result).slice(0, 300)}`)
    // The V2 endpoint requires a key even for read-only getsourcecode (confirmed 2026-09-21).
    // A clear "Missing/Invalid API Key" here means the endpoint itself is reachable and healthy.
    // V2 端点即使只读查询也要 key（2026-09-21 实测）；能拿到这条错误说明端点本身是通的。
    if (/API Key/i.test(String(j.result))) {
      info('-> the endpoint is reachable; it just needs ETHERSCAN_API_KEY. Free key: https://etherscan.io/myapikey')
    }
    return undefined
  }
  const entry = Array.isArray(j.result) ? j.result[0] : j.result
  const verified = !!(entry?.SourceCode && entry.SourceCode.length > 0)
  if (verified) ok(`${address} IS verified as "${entry.ContractName}" (compiler ${entry.CompilerVersion})`)
  else info(`${address} is NOT verified (ABI field: "${entry?.ABI}")`)
  return verified
}

async function submit(built, spec, address, ctorArgsHex) {
  const key = apiKey(true)
  const params = {
    module: 'contract',
    action: 'verifysourcecode',
    codeformat: 'solidity-standard-json-input',
    sourceCode: JSON.stringify(built.input),
    contractaddress: address,
    contractname: built.contractPath,
    compilerversion: `v${built.compiler}`,
    // Yes, the Etherscan parameter really is spelled "constructorArguements", and the value has no
    // 0x prefix. 这个参数名在 Etherscan 侧确实是拼错的，且值不带 0x。
    constructorArguements: strip0x(ctorArgsHex),
  }
  info(`POST ${API}?chainid=${CHAIN_ID}  action=verifysourcecode`)
  info(`  contractname        ${params.contractname}`)
  info(`  compilerversion     ${params.compilerversion}`)
  info(`  constructorArguements ${params.constructorArguements || '(none)'}`)
  const r = await apiPost(params, key)
  if (r.raw !== undefined) die(`non-JSON response (HTTP ${r.http}): ${String(r.raw).slice(0, 500)}`)
  if (r.json.status !== '1') die(`submission rejected: status=${r.json.status} message=${r.json.message} result=${r.json.result}`)
  const guid = r.json.result
  ok(`submitted, guid ${guid}`)

  for (let attempt = 1; attempt <= 30; attempt++) {
    await new Promise((res) => setTimeout(res, 5000))
    const p = await apiGet({ module: 'contract', action: 'checkverifystatus', guid }, key)
    if (p.raw !== undefined) { info(`poll ${attempt}: non-JSON (HTTP ${p.http})`); continue }
    const msg = `${p.json.status} / ${p.json.result}`
    if (String(p.json.result).startsWith('Pending')) { info(`poll ${attempt}: ${msg}`); continue }
    if (p.json.status === '1') {
      ok(`VERIFIED: ${msg}`)
      console.log(`\n  ${EXPLORER}/address/${address}#code\n`)
      return true
    }
    bad(`verification FAILED: ${msg}`)
    info('Common causes: wrong constructorArguements, the artifact was rebuilt after deploy, or the')
    info('address holds a different build. Re-run with --dry-run to see the local self-checks.')
    return false
  }
  bad('timed out waiting for the verification result; re-check with --check <address>')
  return false
}

// ---------------------------------------------------------------------- main ----

async function verifyOne(which, address) {
  const spec = CONTRACTS[which]
  head(`${spec.name} @ ${address}`)
  if (!isAddress(address)) die(`--${which} is not an address: ${address}`)

  const built = buildStandardJson(spec)
  info(`artifact  ${spec.artifact}`)
  info(`compiler  v${built.compiler}   evm ${built.input.settings.evmVersion}   optimizer ${built.input.settings.optimizer.runs} runs   bytecodeHash ${built.input.settings.metadata.bytecodeHash}`)

  // Write the exact payload next to the artifacts so a human can re-submit it by hand from the
  // BscScan web form if the API is having a bad day. 同时落盘，以便必要时手工提交。
  const outDir = join(root, 'contracts', 'verify')
  mkdirSync(outDir, { recursive: true })
  const jsonPath = join(outDir, `${spec.name}.standard-input.json`)
  writeFileSync(jsonPath, JSON.stringify(built.input, null, 2))
  info(`standard-json written to contracts/verify/${spec.name}.standard-input.json`)

  head('  Local self-checks / 本地自检')
  const shapeOk = validateShape(built, spec)
  const reproOk = localReproduce(built, spec)

  const ctorArgs = spec.ctor.map((n) => {
    const v = flag(n) ?? process.env[n.toUpperCase().replaceAll('-', '_')]
    if (!isAddress(v)) die(`constructor arg --${n} is missing or not an address (got ${v})`)
    return lower(v).slice(2).padStart(64, '0')
  }).join('')
  info(`constructor args (${spec.ctor.join(', ')}): ${ctorArgs}`)

  const chainOk = await matchOnChain(built, address)

  if (!shapeOk || !reproOk || !chainOk) {
    bad('self-checks did not pass -- not submitting. Fix the above first.')
    return false
  }

  const already = await checkVerified(address)
  if (already) { info('already verified; nothing to do'); return true }

  if (DRY) { info('--dry-run: everything checked, nothing submitted'); return true }
  head('  Submitting / 提交')
  return submit(built, spec, address, ctorArgs)
}

async function main() {
  console.log('\x1b[1m=========================================================\x1b[0m')
  console.log('\x1b[1m  BscScan source verification (Etherscan V2, chainid=56)\x1b[0m')
  console.log('\x1b[1m=========================================================\x1b[0m')

  if (has('check')) {
    const a = flag('check')
    head(`getsourcecode ${a}`)
    const r = await checkVerified(a)
    process.exit(r === undefined ? 1 : 0)
  }

  const targets = ['directory', 'escrow'].filter((k) => flag(k))
  if (targets.length === 0) {
    die('nothing to do. Pass --directory <addr> and/or --escrow <addr>, or --check <addr>.\n'
      + 'ServiceDirectory needs --hub --factory --domain-binding; TapeAPIEscrow needs --bem --hub --treasury.')
  }

  let allOk = true
  for (const t of targets) allOk = (await verifyOne(t, flag(t))) && allOk

  console.log('\n\x1b[1m=========================================================\x1b[0m')
  if (allOk) console.log('\x1b[32m\x1b[1m  DONE\x1b[0m')
  else console.log('\x1b[31m\x1b[1m  NOT ALL CONTRACTS VERIFIED\x1b[0m')
  process.exit(allOk ? 0 : 1)
}

main().catch((e) => { console.error(`\n\x1b[31mverify crashed: ${e?.stack || e}\x1b[0m`); process.exit(1) })
