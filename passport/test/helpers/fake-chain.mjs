// A fake BNB Smart Chain for the live layer, in process: a fetch that answers JSON-RPC (single and batch) for each
// operator of a tap-agent-passport-snapshot/1 from that operator's recorded answers, so the draft's vectors can be
// replayed through liveReads and the SDK's strict-agreement rpc client. No network.
// 进程内的假 BNB 链：按快照里每个运营方记录的回答应答 JSON-RPC（单个与批量），让草案向量经 liveReads 与 SDK 的严格共识 rpc 客户端
// 再跑一遍。不联网。
import { createRpc } from '@tapeapi/sdk/rpc'
import { keccak_256 } from '@noble/hashes/sha3'

const hex = (b) => '0x' + Buffer.from(b).toString('hex')
const sel = (sig) => hex(keccak_256(new TextEncoder().encode(sig)).subarray(0, 4))
const SIGS = {
  isCPU: ['address'], ownerOf: ['uint256'], accountOf: ['address', 'uint256'], isOpened: ['address', 'uint256'], cpuAt: ['uint256'],
  fileInfo: ['address', 'string'], read: ['address', 'string'], getMetadata: ['uint256', 'string'], getAgentWallet: ['uint256'], tokenURI: ['uint256'],
}
const BY_SELECTOR = Object.fromEntries(Object.entries(SIGS).map(([fn, types]) => [sel(`${fn}(${types.join(',')})`), [fn, types]]))
const topic = (s) => hex(keccak_256(new TextEncoder().encode(s)))
const T_TRANSFER = topic('Transfer(address,address,uint256)'), T_OPSET = topic('OperatorSet(address,address,address,uint40)')
const pad = (v) => BigInt(v).toString(16).padStart(64, '0')
const CPU_COUNT = sel('cpuCount()')

/** The read key of an eth_call, as the snapshot writes it. / eth_call 对应的快照读取键。 */
export function keyOfCall(to, data) {
  const [fn, types] = BY_SELECTOR[data.slice(0, 10)] ?? []
  if (!fn) return null
  const b = Buffer.from(data.slice(10), 'hex')
  const w = (i) => b.subarray(32 * i, 32 * i + 32)
  const args = types.map((t, i) => {
    if (t === 'address') return '0x' + w(i).subarray(12).toString('hex')
    if (t === 'uint256') return BigInt('0x' + w(i).toString('hex')).toString()
    const off = Number(BigInt('0x' + w(i).toString('hex'))); const n = Number(BigInt('0x' + b.subarray(off, off + 32).toString('hex')))
    return b.subarray(off + 32, off + 32 + n).toString('utf8')
  })
  return `${to.toLowerCase()}.${fn}(${args.join(',')})`
}

/**
 * fetch + urls for `snap`: one https URL per operator (distinct operators), heads chosen so that rpc.tap10Block pins
 * exactly snap.pinnedBlock while the lag of the highest operator head is the snapshot's own. opts.calls collects every
 * method asked (for budget assertions); opts.override(op, method, params) may answer first.
 * 为快照生成 fetch 与 urls：每个运营方一个 https 地址；头块的选择使 tap10Block 恰好钉在 snap.pinnedBlock，最高头块的滞后与快照相同。
 */
export function fakeChain(snap, opts = {}) {
  const names = Object.keys(snap.operators).sort()
  const P = snap.pinnedBlock
  const byHead = [...names].sort((a, b) => snap.operators[b].head - snap.operators[a].head)
  const heads = Object.fromEntries(names.map((n) => [n, names.length === 1 ? P + 2 : n === byHead[0] ? snap.operators[n].head : Math.min(snap.operators[n].head, P + 2)]))
  const urls = names.map((n) => `https://${n}.passport-fake.example/`)
  const opOf = Object.fromEntries(names.map((n, i) => [urls[i], n]))
  const calls = opts.calls ?? []
  const answerOf = (op, key) => { const own = snap.operators[op].answers || {}; const a = Object.hasOwn(own, key) ? own[key] : snap.answers?.[key]; return a === undefined ? null : a }
  const block = snap.answers?.block
  function one(op, { id, method, params }) {
    calls.push({ op, method, params })
    const r = opts.override?.(op, method, params)
    if (r !== undefined) return { jsonrpc: '2.0', id, ...r }
    const ok = (result) => ({ jsonrpc: '2.0', id, result })
    const fail = (code, message, data) => ({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } })
    const fromKey = (key) => {
      const a = answerOf(op, key)
      if (a === null) return fail(-32000, 'missing trie node')
      if (a && typeof a === 'object' && 'revert' in a) return fail(3, 'execution reverted', a.revert)
      return ok(a)
    }
    if (method === 'eth_blockNumber') return ok('0x' + heads[op].toString(16))
    if (method === 'eth_chainId') return fromKey('eth_chainId')
    if (method === 'eth_getBlockByNumber') {
      const n = Number(BigInt(params[0]))
      if (n !== P || !block) return fail(-32000, 'header not found')
      return ok({ number: params[0], hash: block.hash, timestamp: '0x' + Number(block.timestamp).toString(16), parentHash: '0x' + '00'.repeat(32) })
    }
    if (method === 'eth_getStorageAt') return fromKey('implSlot:' + String(params[0]).toLowerCase())
    if (method === 'eth_call') {
      // cpuCount() for the SDK's processor table: the processors the snapshot records before the first revert.
      // SDK 处理器表要用的 cpuCount()：快照里第一次回滚之前记录的处理器数。
      if (params[0].data === CPU_COUNT && params[0].to.toLowerCase() === String(snap.config.factory).toLowerCase()) {
        let n = 0; while (typeof answerOf(op, `${snap.config.factory}.cpuAt(${n})`) === 'string') n++
        return ok('0x' + pad(n))
      }
      const key = keyOfCall(params[0].to, params[0].data)
      if (!key) return fail(-32601, 'unknown call')
      // cpuAt past the processors the snapshot records reverts, as on the chain (the SDK table reads its snapshot's last).
      // 快照未记录的 cpuAt 与链上一样回滚（SDK 的处理器表会读它自带快照的最后一项）。
      if (/\.cpuAt\(\d+\)$/.test(key) && answerOf(op, key) === null) return fail(3, 'execution reverted', '0x')
      return fromKey(key)
    }
    if (method === 'eth_getLogs') {
      const f = params[0]; const lo = Number(BigInt(f.fromBlock)), hi = Number(BigInt(f.toBlock)); const t = f.topics
      let key, enc
      if (t[0] === T_OPSET) {
        key = `logs.OperatorSet(0x${t[1].slice(26)})`
        enc = (r, i) => ({ address: f.address, topics: [T_OPSET, t[1]], data: '0x' + pad(r.operator) + pad(r.setBy) + pad(r.until), blockNumber: '0x' + r.block.toString(16), logIndex: '0x' + i.toString(16), blockTimestamp: '0x1' })
      } else if (t[0] === T_TRANSFER) {
        const tokenId = BigInt(t[3]).toString()
        key = f.address.toLowerCase() === String(snap.config.identityRegistry).toLowerCase() ? `logs.Transfer.identity(${tokenId})` : `logs.Transfer.circuit(${f.address.toLowerCase()},${tokenId})`
        enc = (r, i) => ({ address: f.address, topics: [T_TRANSFER, '0x' + pad(r.from), '0x' + pad(r.to), t[3]], data: '0x', blockNumber: '0x' + r.block.toString(16), logIndex: '0x' + i.toString(16) })
      } else return fail(-32602, 'unknown filter')
      const a = answerOf(op, key)
      if (a === null) return fail(-32000, 'missing')
      if (!Array.isArray(a)) return fail(-32005, 'limit exceeded')
      return ok(a.map(enc).filter((l) => { const n = Number(BigInt(l.blockNumber)); return n >= lo && n <= hi }))
    }
    return fail(-32601, `method ${method} not served by the fake`)
  }
  const fetch = async (url, init) => {
    const op = opOf[url]
    if (!op) throw new Error(`fake: unknown url ${url}`)
    const body = JSON.parse(init.body)
    const out = Array.isArray(body) ? body.map((b) => one(op, b)) : one(op, body)
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return { urls, fetch, heads, calls, rpc: () => createRpc({ urls, quorum: Math.min(2, names.length), fetch, quiet: true, disagreeRetryMs: 0, rpcRetries: 0 }) }
}
