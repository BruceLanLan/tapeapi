#!/usr/bin/env node
// Record the security 1.2 proof fixture: resolve('11.1013.tape') on BNB Smart Chain with createTapeAPI({ pin: true,
// proofs: 'strict' }) through the SDK's default nodes, read-only. Sends no transactions.
//
// A wrapping fetch records every JSON-RPC answer the resolution got: the pinned block (with its stateRoot), each eth_call
// and eth_getStorageAt (all at that block; the SDK accepted each only when every answering node agreed and two operators
// answered), and each eth_getProof (from whichever node served it: proofs need no quorum). The fixture is public chain
// data only. sdk/test/proof.test.mjs replays it offline; spec/vectors/tapi-20-proof.json carries its proofs for verify.py.
// It also prints what the run cost: requests per host, busy spans (stretches with a request in flight: proofs overlap the
// resolution's rounds, so this is not its number of serial rounds) and time.
//
// Usage: node scripts/record-mainnet-proof.mjs [--write] [--name 11.1013.tape] [--chain 56] [--proofs strict|true|off]
//        (without --write it only prints)
//
// 记录安全加固 1.2 的证明 fixture：以 createTapeAPI({ pin: true, proofs: 'strict' }) 经 SDK 默认节点在 BNB Smart Chain 上只读解析
// '11.1013.tape'，不发任何交易。外层 fetch 记下这次解析得到的每个 JSON-RPC 回答：钉住的区块（含 stateRoot）、每个 eth_call 与
// eth_getStorageAt（都在该区块上，SDK 只在全体作答节点一致且两家运营方作答时才接受），以及每个 eth_getProof（来自提供它的节点：证明不需要
// 法定数）。fixture 只含公开链上数据。同时打印这次运行的代价：每个主机的请求数、忙碌段数（证明与各轮重叠，不是串行轮数）与耗时。
import { writeFileSync } from 'node:fs'
import { createTapeAPI, rpcUrlsFor, operatorOf, canonicalJSON } from '../sdk/src/index.js'

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
const NAME = arg('--name', '11.1013.tape')
const CHAIN = Number(arg('--chain', '56'))
// --proofs off|true|strict: compare the cost with and without proofs (only 'strict' can be written) / 比较开关证明的代价
const PROOFS = { off: false, true: true, strict: 'strict' }[arg('--proofs', 'strict')]
const urls = rpcUrlsFor(CHAIN)
const perHost = new Map()
const answers = new Map()   // canonical (method, params) -> result / 规范化的 (方法, 参数) -> 结果
let inflight = 0, rounds = 0, requests = 0
const record = (method, params, result) => {
  const key = canonicalJSON({ method, params })
  if (answers.has(key) && canonicalJSON(answers.get(key).result) !== canonicalJSON(result)) {
    if (method === 'eth_getBlockByNumber' && typeof params[0] === 'string' && !/^0x/.test(params[0])) return   // a tag: nodes differ / 标签：各节点不同
    throw new Error(`two answers for ${method}`)
  }
  answers.set(key, { method, params, result })
}
const recordingFetch = async (url, init) => {
  const host = new URL(url).hostname
  perHost.set(host, (perHost.get(host) ?? 0) + 1)
  requests++
  if (inflight++ === 0) rounds++
  try {
    const res = await fetch(url, init)
    const text = await res.clone().text()
    let body = null
    try { body = JSON.parse(text) } catch { /* not JSON / 不是 JSON */ }
    const reqs = [].concat(JSON.parse(init.body))
    const outs = [].concat(body ?? [])
    for (const q of reqs) {
      const a = outs.find((o) => o && o.id === q.id)
      if (a && 'result' in a && a.result !== null && res.ok) record(q.method, q.params, a.result)
    }
    return res
  } finally { inflight-- }
}

const t0 = performance.now()
const warnings = []
const api = createTapeAPI({ chainId: CHAIN, rpcUrls: urls, quorum: 2, pin: true, proofs: PROOFS, fetch: recordingFetch, onWarning: (w) => warnings.push(w), rpcTimeoutMs: 15000 })
let svc, failure = null
try { svc = await api.resolve(NAME) } catch (e) { failure = e }
const ms = Math.round(performance.now() - t0)
console.log(`${NAME} on chain ${CHAIN}: ${failure ? `FAILED ${failure.code}: ${failure.message.slice(0, 400)}` : 'resolved'}`)
console.log(`requests ${requests}, busy spans ${rounds} (not serial rounds: proofs overlap them), ${ms} ms; per host ${JSON.stringify(Object.fromEntries(perHost))}`)
if (failure?.data) console.log('error data', JSON.stringify(failure.data).slice(0, 600))
if (warnings.length) console.log('warnings', warnings.map((w) => w.code))
if (!svc || PROOFS !== 'strict') process.exit(failure ? 1 : 0)
const cost = { requests, rounds, perHost: Object.fromEntries(perHost) }
console.log('pinned', svc.pinned, '\nproofs', JSON.stringify(svc.proofs, null, 1))

// Two absence proofs from the node that served the others, at the same block, for tests: an ownerOf slot of a token that
// does not exist (an empty storage slot) and an address with no account. / 两个"不存在"的证明，供测试：不存在的 token 的
// ownerOf 槽（空存储槽）与没有账户的地址。
const { STORAGE } = await import('../sdk/src/proof.js')
const prover = urls.find((u) => new URL(u).hostname === svc.proofs.verified[0]?.node)
const absentAsks = [
  { what: 'an empty storage slot: ownerOf(2^64) of the same circuits', address: svc.manifest.circuits, slots: ['0x' + STORAGE.ownerOf(2n ** 64n).toString(16).padStart(64, '0')] },
  { what: 'an address with no account', address: '0x' + 'de'.repeat(19) + 'ad', slots: ['0x' + '00'.repeat(32)] },
]
const absent = []
for (const a of absentAsks) {
  const r = await (await recordingFetch(prover, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getProof', params: [a.address, a.slots, '0x' + svc.pinned.number.toString(16)] }) })).json()
  if (r.result) absent.push({ what: a.what, address: a.address, slots: a.slots, block: '0x' + svc.pinned.number.toString(16), answer: r.result })
  else console.log('absence proof not served:', JSON.stringify(r.error))
}
const list = [...answers.values()].filter((a) => !absent.some((x) => x.address === a.params?.[0] && a.method === 'eth_getProof'))
const fixture = {
  recordedAt: new Date().toISOString().slice(0, 10),
  chainId: CHAIN,
  source: `${NAME}, resolved with createTapeAPI({ pin: true, proofs: 'strict' }) through rpcUrlsFor(${CHAIN}); recorded by scripts/record-mainnet-proof.mjs`,
  note: 'Read-only public chain data. Every eth_call and eth_getStorageAt was made at `block` (EIP-1898 blockHash) and accepted by the SDK only when every answering node returned the same bytes and two operators answered; each eth_getProof came from the one node that served it and was checked against block.stateRoot. / 只读的公开链上数据。',
  rpc: { urls, operators: [...new Set(urls.map(operatorOf))], quorum: 2 },
  block: { number: svc.pinned.number, hash: svc.pinned.hash, timestamp: svc.pinned.timestamp, stateRoot: svc.proofs.stateRoot },
  name: NAME,
  container: svc.container,
  holder: svc.verified.holder,
  proofs: svc.proofs,
  calls: list.filter((a) => a.method === 'eth_call').map((a) => ({ to: a.params[0].to, data: a.params[0].data, result: a.result })),
  storage: list.filter((a) => a.method === 'eth_getStorageAt').map((a) => ({ address: a.params[0], slot: a.params[1], result: a.result })),
  getProof: list.filter((a) => a.method === 'eth_getProof').map((a) => ({ address: a.params[0], slots: a.params[1], block: a.params[2], answer: a.result })),
  absent,
  cost: { note: 'This run on the network: HTTP requests, and busy spans (stretches with a request in flight; proofs overlap the resolution\'s rounds, so this is not its number of serial rounds, which sdk/test/proof.test.mjs PROOF-12 compares offline). / 这次在线运行的请求数与忙碌段数（证明与各轮重叠，所以不是串行轮数）。', requests: cost.requests, busySpans: cost.rounds, ms, perHost: cost.perHost },
}
if (process.argv.includes('--write')) {
  const out = new URL(`../sdk/test/fixtures/mainnet-${NAME.replace(/\.tape$/, '').replace(/\./g, '-')}-proof.json`, import.meta.url)
  writeFileSync(out, JSON.stringify(fixture, null, 2) + '\n')
  console.log('wrote', out.pathname)
}
