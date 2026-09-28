#!/usr/bin/env node
// Record the TAP-20 §6.1 mainnet vector: the live manifest of 11.1013.tape (api.tapeapi.fun), read-only, pinned to one
// block. Sends no transactions.
//
// How: the SDK's own resolve('11.1013.tape') runs against the SDK's default BSC nodes (rpcUrlsFor(56)) with quorum 2
// counted by operator, exactly as a client would; a wrapping fetch pins every eth_call to one agreed block (EIP-1898
// { blockHash }) and records each node's answer. A call is written to the fixture only when every node that answered
// returned the same bytes, and at least two operators answered. The fixture is then replayed offline by
// sdk/test/mainnet-manifest.test.mjs and checked independently by spec/vectors/verify.py.
//
// The manifest changes whenever its delegation is renewed (due before 2026-12-10): re-running this script then
// records a different, equally valid state. The fixture pins the state at the recorded block, not "the" manifest.
//
// Usage: node scripts/record-mainnet-manifest.mjs [--write]      (without --write it only prints)
//
// 记录 TAP-20 §6.1 的主网向量：11.1013.tape（api.tapeapi.fun）的线上清单，只读、钉在一个区块上，不发任何交易。
// 做法：用 SDK 自己的 resolve('11.1013.tape')，走 SDK 默认的 BSC 节点、按运营方计的法定数 2；外层 fetch 把每个 eth_call
// 钉到一个各节点一致的区块（EIP-1898 { blockHash }），并记下每个节点的回答。只有所有作答节点字节一致、且至少两家运营方
// 作答的调用才写入 fixture。委托续期（12 月 10 日前）后清单会变，重跑会记下另一个同样有效的状态：fixture 钉的是那个区块上的状态。
import { writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createTapeAPI, createRpc, rpcUrlsFor, operatorOf, MANIFEST_KEY, abi } from '../sdk/src/index.js'

const NAME = '11.1013.tape'
const urls = rpcUrlsFor(56)
const QUORUM = 2
const rpc = createRpc({ urls, quorum: QUORUM, timeoutMs: 25000 })

// 1. One block every operator has, well inside BSC finality: the lowest head minus 40, and its hash under quorum.
// 1. 各运营方都有、且远在最终性之内的区块：最低块高减 40，其哈希须法定数一致。
const head = await rpc.blockNumber()
const number = head - 40
const project = (b) => ({ number: Number(BigInt(b.number)), hash: b.hash.toLowerCase(), parentHash: b.parentHash.toLowerCase(), timestamp: Number(BigInt(b.timestamp)), stateRoot: b.stateRoot.toLowerCase() })
const block = await rpc.call('eth_getBlockByNumber', ['0x' + number.toString(16), false], { project })
if (block.number !== number) throw new Error(`asked for block ${number}, nodes agreed on ${block.number}`)

// 2. resolve through the SDK, every eth_call pinned to that block; record what each node said.
// 2. 经 SDK 解析，每个 eth_call 都钉在该区块；记下每个节点的回答。
const seen = new Map()   // `${to}:${data}` -> { to, data, answers: Map(operator -> json) }
// The SDK sends concurrent eth_calls to one node as a JSON-RPC batch (an array): every call in it is pinned and recorded,
// its answer matched by id. A batch the node refuses (HTTP error) is recorded as nothing; the SDK then asks call by call.
// SDK 把发往同一节点的并发 eth_call 合并为 JSON-RPC 批量（数组）：其中每个调用都钉块并记录，回答按 id 对应。节点拒绝的批量
// （HTTP 错误）不记录任何东西；SDK 随后逐个再问。
const pinningFetch = async (url, init) => {
  const body = JSON.parse(init.body)
  const reqs = Array.isArray(body) ? body : [body]
  for (const req of reqs) if (req.method === 'eth_call') req.params[1] = { blockHash: block.hash }
  const res = await fetch(url, { ...init, body: JSON.stringify(body) })
  const text = await res.text()
  if (res.ok) {
    let answers = null
    try { const j = JSON.parse(text); answers = Array.isArray(j) ? j : [j] } catch { /* not JSON: a transport failure, not an answer / 不是 JSON：传输失败，不算回答 */ }
    for (const req of reqs) {
      if (req.method !== 'eth_call') continue
      const k = `${req.params[0].to.toLowerCase()}:${req.params[0].data.toLowerCase()}`
      const e = seen.get(k) || { to: req.params[0].to, data: req.params[0].data.toLowerCase(), answers: new Map() }
      const j = answers && (Array.isArray(body) ? answers.find((a) => a && a.id === req.id) : answers[0])
      if (j && typeof j === 'object') e.answers.set(url, 'result' in j ? { result: j.result } : { error: j.error })
      seen.set(k, e)
    }
  }
  return new Response(text, { status: res.status, headers: res.headers })
}
const api = createTapeAPI({ rpcUrls: urls, quorum: QUORUM, rpcTimeoutMs: 25000, fetch: pinningFetch })
const svc = await api.resolve(NAME)

// 3. Each recorded call: one result, agreed by every answering node, from at least QUORUM operators.
// 3. 每个调用：唯一结果，所有作答节点一致，至少来自 QUORUM 家运营方。
const calls = {}
for (const e of seen.values()) {
  const outs = [...e.answers.values()].map((a) => JSON.stringify(a))
  if (new Set(outs).size !== 1) throw new Error(`nodes disagree on ${e.to} ${e.data.slice(0, 10)}: ${outs.join(' | ')}`)
  const answer = [...e.answers.values()][0]
  if (!answer.result) throw new Error(`${e.to} ${e.data.slice(0, 10)} did not return a result: ${outs[0]}`)
  const operators = [...new Set([...e.answers.keys()].map(operatorOf))].sort()
  if (operators.length < QUORUM) throw new Error(`${e.data.slice(0, 10)}: only ${operators.join(', ')} answered`)
  const fn = abi.functionBySelector(e.data)
  // bigint -> decimal, address as is, any other string quoted / 整数写十进制，地址原样，其它字符串加引号
  const args = abi.decodeCall(fn, e.data).map((v) => (typeof v === 'bigint' ? v.toString() : abi.isAddress(v) ? v : JSON.stringify(v)))
  const label = `${fn}(${args.join(',')})`
  calls[label] = { to: e.to, data: e.data, result: answer.result.toLowerCase(), operators }
}

const m = svc.manifest
const file = svc.file
const rawHex = Object.values(calls).find((c) => c.data.startsWith(abi.selector('read')))?.result
const bytes = abi.decodeReturn('read', rawHex)
const raw = Buffer.from(bytes.slice(2), 'hex')
const out = {
  recordedAt: new Date().toISOString().slice(0, 10),
  chainId: 56,
  source: `${NAME} (https://api.tapeapi.fun), TAP-20 §6.1; recorded by scripts/record-mainnet-manifest.mjs`,
  note: 'Read-only. Every eth_call was sent with the EIP-1898 block parameter { blockHash } of `block`, to the SDK default BSC nodes, and kept only when every answering node returned the same bytes and at least `rpc.quorum` operators answered. The manifest changes when its delegation is renewed (due before 2026-12-10); this fixture pins the state at `block`, not the current manifest. / 只读。每个 eth_call 都以 `block` 的 EIP-1898 { blockHash } 发往 SDK 默认 BSC 节点，只有所有作答节点字节一致且至少 `rpc.quorum` 家运营方作答才保留。委托续期（12 月 10 日前）后清单会变；本 fixture 钉的是 `block` 上的状态。',
  rpc: { urls, operators: rpc.operators, quorum: QUORUM, blockParam: 'EIP-1898 { blockHash }' },
  block,
  name: NAME,
  processor: 1013,
  circuits: m.circuits,
  tokenId: m.tokenId,
  container: svc.container,
  holder: svc.verified.holder,
  manifest: {
    key: MANIFEST_KEY,
    size: file.size,
    contentType: 'application/json',
    sha256Hash: file.sha256Hash,
    bytesSha256: '0x' + createHash('sha256').update(raw).digest('hex'),
    updatedAt: Number(file.updatedAt),
    signer: m.signer,
    delegation: { expires: m.delegation.expires, sig: m.delegation.sig },
  },
  calls,
}
if (out.manifest.bytesSha256 !== out.manifest.sha256Hash.toLowerCase()) throw new Error('manifest bytes do not hash to fileInfo.sha256Hash')
console.log(JSON.stringify({ ...out, calls: Object.fromEntries(Object.entries(calls).map(([k, v]) => [k, { ...v, result: v.result.length > 140 ? v.result.slice(0, 140) + '…' : v.result }])) }, null, 2))
if (process.argv.includes('--write')) {
  writeFileSync(new URL('../sdk/test/fixtures/mainnet-11-1013-manifest.json', import.meta.url), JSON.stringify(out, null, 2) + '\n')
  console.log('wrote sdk/test/fixtures/mainnet-11-1013-manifest.json')
}
