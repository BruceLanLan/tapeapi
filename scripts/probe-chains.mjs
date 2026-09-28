#!/usr/bin/env node
// Read-only live check of every contract address in sdk/src/chains.js, on BNB Smart Chain, X Layer and Base, through
// the SDK's default nodes with the operator quorum (rpc-defaults.js). Sends no transactions. Not part of `npm test`
// (it needs the network); sdk/test/chains.test.mjs pins the same facts from a recorded answer.
// 只读在线核对 sdk/src/chains.js 里的每个合约地址（BNB、X Layer、Base），走 SDK 默认节点与按运营方的法定数。不发送任何交易。
// 不在 npm test 里（要联网）；sdk/test/chains.test.mjs 用录下的回答钉住同样的事实。
//
//   node scripts/probe-chains.mjs              check; exit 1 on any mismatch / 核对，有不符则退出码 1
//   node scripts/probe-chains.mjs --record     also rewrite sdk/test/fixtures/chains-onchain.json / 同时重写录制文件
//   node scripts/probe-chains.mjs --chain 196  one chain only / 只查一条链
//
// Per chain: eth_chainId; for each contract, code present and (for a proxy) the ERC-1967 implementation slot in
// expectedImpl; processor 0 (factory.cpuAt(0)) is a TapeOut processor; DeWebHub's accountOf equals the opener's for
// (processor 0, #1), and the hub's immutables name this chain's factory, the ERC-6551 registry and the account
// implementation. On X Layer it also reads a known site (1.2.230.tape, found by enumeration 2026-09-28).
// 每条链：eth_chainId；每个合约有代码，代理的 ERC-1967 实现槽在 expectedImpl 里；0 号处理器是 TapeOut 处理器；DeWebHub 与开通器
// 对 (0 号处理器, #1) 算出的容器相同，且中枢的不可变量指向本链工厂、ERC-6551 注册表与账户实现。X Layer 上另读一个已知网站。
import { writeFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRpc, CHAINS, CHAIN_IDS, IMPL_SLOT, rpcUrlsFor, formatTapeName } from '../sdk/src/index.js'
import { selector, encodeParams, decodeParams, bytesToHex, keccak256 } from '../sdk/src/abi.js'
// The checks themselves live beside the test that pins them (sdk/ ships with the public copy; this script does not).
// 核对逻辑放在钉住它的测试旁边（sdk/ 随公开副本发布，本脚本不发布）。
import { FIXTURE, L2_SITE, problemsOf } from '../sdk/test/helpers/chain-facts.mjs'
export { FIXTURE, L2_SITE, problemsOf }

const call = (sig, types = [], values = []) => selector(sig) + bytesToHex(encodeParams(types, values))
const word = (hex, i = 0) => '0x' + String(hex).slice(2 + i * 64, 2 + (i + 1) * 64)
const addrOf = (hex) => '0x' + word(hex).slice(-40)

/** Read the facts for one chain. / 读一条链的事实。 */
export async function readChain(chainId, { urls = rpcUrlsFor(chainId), timeoutMs = 15000 } = {}) {
  const c = CHAINS[chainId]
  const rpc = createRpc({ urls, quorum: 2, timeoutMs, quiet: true })
  const block = '0x' + (await rpc.blockNumber()).toString(16)
  const at = (to, data) => rpc.ethCall(to, data, block)
  const out = { chainId: Number(BigInt(await rpc.call('eth_chainId', []))), block: Number(block), operators: rpc.operators, contracts: {} }
  const named = { factory: c.factory, opener: c.opener, hub: c.hub, siteRegistry: c.siteRegistry, binding: c.binding, erc6551Registry: c.erc6551Registry, accountImplementation: c.accountImplementation }
  for (const [name, a] of Object.entries(named)) {
    const code = await rpc.call('eth_getCode', [a, block])
    const slot = await rpc.call('eth_getStorageAt', [a, IMPL_SLOT, block])
    out.contracts[name] = {
      address: a, codeBytes: (code.length - 2) / 2, codeKeccak: bytesToHex(keccak256(code)),
      implementation: /^0x0*$/.test(slot) ? null : addrOf(slot).toLowerCase(),
    }
  }
  const cpu0 = addrOf(await at(c.factory, call('cpuAt(uint256)', ['uint256'], [0n])))
  out.processor0 = cpu0.toLowerCase()
  out.isCPU0 = BigInt(await at(c.factory, call('isCPU(address)', ['address'], [cpu0]))) === 1n
  out.hubAccountOf = addrOf(await at(c.hub, call('accountOf(address,uint256)', ['address', 'uint256'], [cpu0, 1n]))).toLowerCase()
  out.openerAccountOf = addrOf(await at(c.opener, call('accountOf(address,uint256)', ['address', 'uint256'], [cpu0, 1n]))).toLowerCase()
  out.hubFactory = addrOf(await at(c.hub, call('factory()'))).toLowerCase()
  out.hubRegistry = addrOf(await at(c.hub, call('registry()'))).toLowerCase()
  out.hubAccountImplementation = addrOf(await at(c.hub, call('accountImplementation()'))).toLowerCase()
  out.hubOwner = addrOf(await at(c.hub, call('owner()'))).toLowerCase()
  if (chainId === L2_SITE.chainId) {
    const s = L2_SITE
    const circuits = addrOf(await at(c.factory, call('cpuAt(uint256)', ['uint256'], [BigInt(s.processor)])))
    const container = addrOf(await at(c.hub, call('accountOf(address,uint256)', ['address', 'uint256'], [circuits, BigInt(s.tokenId)])))
    const info = decodeParams(['uint32', 'string', 'bytes32', 'uint40', 'uint256'], await at(c.siteRegistry, call('fileInfo(address,string)', ['address', 'string'], [container, s.path])))
    const manifest = decodeParams(['uint32', 'string', 'bytes32', 'uint40', 'uint256'], await at(c.siteRegistry, call('fileInfo(address,string)', ['address', 'string'], [container, '.well-known/tapeapi.json'])))
    out.site = {
      name: formatTapeName({ tokenId: s.tokenId, processor: s.processor, chainId }), circuits: circuits.toLowerCase(), container: container.toLowerCase(),
      path: s.path, size: Number(info[0]), sha256Hash: String(info[2]).toLowerCase(), manifestSize: Number(manifest[0]),
    }
  }
  return out
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2)
  const only = args.includes('--chain') ? [Number(args[args.indexOf('--chain') + 1])] : CHAIN_IDS
  const record = args.includes('--record')
  const recorded = { recordedAt: new Date().toISOString().slice(0, 10), chains: {} }
  let bad = 0
  for (const id of only) {
    let facts
    try { facts = await readChain(id) } catch (e) { console.log(`chain ${id}: cannot read (${e.code || ''} ${e.message})`); bad++; continue }
    const problems = problemsOf(id, facts)
    console.log(`\n${CHAINS[id].name} (chain ${id}) at block ${facts.block}, operators ${facts.operators.join(', ')}`)
    for (const [name, f] of Object.entries(facts.contracts)) console.log(`  ${name.padEnd(22)} ${f.address}  ${String(f.codeBytes).padStart(5)} bytes${f.implementation ? `  implementation ${f.implementation}` : ''}`)
    console.log(`  processor 0 ${facts.processor0} isCPU ${facts.isCPU0}; accountOf(processor 0, #1): hub ${facts.hubAccountOf}, opener ${facts.openerAccountOf}; hub owner ${facts.hubOwner}`)
    if (facts.site) console.log(`  site ${facts.site.name}: container ${facts.site.container}, ${facts.site.path} ${facts.site.size} bytes, .well-known/tapeapi.json ${facts.site.manifestSize ? `${facts.site.manifestSize} bytes` : 'absent'}`)
    console.log(problems.length ? `  PROBLEMS:\n    ${problems.join('\n    ')}` : '  OK')
    bad += problems.length
    recorded.chains[id] = facts
  }
  if (record) {
    if (only.length !== CHAIN_IDS.length || bad) { console.log('\nnot recording: a partial or failing run'); process.exit(1) }
    writeFileSync(FIXTURE, JSON.stringify(recorded, null, 2) + '\n')
    console.log(`\nrecorded ${FIXTURE}`)
  } else if (!bad) {
    // Compare with the recorded answers: a change of code or implementation is worth knowing about. / 与录制的回答比较
    try {
      const old = JSON.parse(readFileSync(FIXTURE, 'utf8'))
      for (const id of only) for (const [name, f] of Object.entries(recorded.chains[id]?.contracts ?? {})) {
        const was = old.chains?.[id]?.contracts?.[name]
        if (was && (was.codeKeccak !== f.codeKeccak || was.implementation !== f.implementation)) console.log(`note: ${CHAINS[id].name} ${name} changed since ${old.recordedAt}`)
      }
    } catch { /* no recording yet / 尚无录制 */ }
  }
  process.exit(bad ? 1 : 0)
}
