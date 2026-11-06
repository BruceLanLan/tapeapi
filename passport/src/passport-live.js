// @tapeapi/passport, layer 2 (@experimental): the read keys of the pure layer answered from nodes. Every read of one
// resolution is made at ONE TAP-10 pinned block (rpc.tap10Block, pinned by hash, EIP-1898) and adopted under strict
// agreement (TAP-10 §5.2: every configured node agrees, from at least max(2, min(3, operators)) distinct operators;
// rpc.call(..., { answers: 'tap10', strict: true })). Chain first, files last, as §6.2 says. Read-only: no transaction,
// no signature, no key.
// Site operators (P-8) and holder epochs (§7) need eth_getLogs history, which public nodes do not serve over long ranges.
// Without log-capable nodes (`logs` not given, the default) both are reported as warnings, operators-not-checked and
// transfer-history-unavailable, and NEVER as an empty history: a CONFIRMED result then says "site operators not
// checked" and "holder history not checked". With `logs: { urls, fromBlock }` the history is scanned in chunks, under
// strict agreement among those nodes, within a request budget; any chunk that is refused or over budget makes the
// whole history "not obtained" again.
// 第 2 层（实验性）：用节点回答第 1 层的读取键。一次解析的全部读取钉在一个 TAP-10 钉块上（按哈希钉住），并按严格共识接受；先链后文件。
// 只读：不发交易、不签名、不要密钥。站点操作员（P-8）与持有人纪元（§7）需要 eth_getLogs 历史，公共节点不提供长区间。没有能查日志的
// 节点（默认）时两者都报警告，绝不当作空历史；给了 logs: { urls, fromBlock } 才分块扫描，在这些节点间同样严格共识、有请求预算，
// 任何一块被拒或超预算，整段历史都算"没拿到"。
import { TapeAPIError, createTapeAPI, rpcUrlsFor, operatorOf } from '@tapeapi/sdk'
import { createRpc } from '@tapeapi/sdk/rpc'
import { encodeParams, toHex, eqAddr } from '@tapeapi/sdk/abi'
import { IMPL_SLOT } from '@tapeapi/sdk/chains'
import { PASSPORT_CONFIG, SNAPSHOT_FORMAT, Unavailable, addr, selector, keccak256, normaliseInput, resolve, canonicalJson, isObj } from './passport-core.js'

const STRICT = Object.freeze({ answers: 'tap10', strict: true })
const SIGS = Object.freeze({
  isCPU: ['address'], ownerOf: ['uint256'], accountOf: ['address', 'uint256'], isOpened: ['address', 'uint256'], cpuAt: ['uint256'],
  fileInfo: ['address', 'string'], read: ['address', 'string'], getMetadata: ['uint256', 'string'], getAgentWallet: ['uint256'], tokenURI: ['uint256'],
})
const topicOf = (sig) => toHex(keccak256(new TextEncoder().encode(sig)))
/** The two events the live layer scans. / 实时层扫描的两种事件。 */
export const LOG_TOPICS = Object.freeze({
  Transfer: topicOf('Transfer(address,address,uint256)'),
  OperatorSet: topicOf('OperatorSet(address,address,address,uint40)'),
})
/** Defaults of the optional log scan. / 可选日志扫描的默认值。 */
export const LOG_DEFAULTS = Object.freeze({ chunk: 5000, maxRequests: 64, fromBlock: 0 })
/** At most this many cpuAt reads when no processor table (api) is given. / 没有处理器表（api）时最多读这么多次 cpuAt。 */
export const MAX_PROCESSOR_SCAN = 64
const pad32 = (h) => '0x' + h.slice(2).toLowerCase().padStart(64, '0')
const blockHex = (n) => '0x' + n.toString(16)

/** The calldata of a read key `<to>.<fn>(<args>)`, or null for another key. / 读取键对应的 calldata。 */
export function callOfKey(key) {
  const m = /^(0x[0-9a-f]{40})\.(\w+)\((.*)\)$/.exec(key)
  if (!m || !Object.hasOwn(SIGS, m[2])) return null
  const [, to, fn, argText] = m; const types = SIGS[fn]
  const args = types.length === 1 ? [argText] : [argText.slice(0, argText.indexOf(',')), argText.slice(argText.indexOf(',') + 1)]
  const vals = args.map((a, i) => (types[i] === 'uint256' ? BigInt(a) : a))
  return { to, data: selector(`${fn}(${types.join(',')})`) + toHex(encodeParams(types, vals)).slice(2) }
}

// A failed read: a disagreement is node-disagreement, anything else unavailable (P-6). / 分歧为 node-disagreement，其余为 unavailable。
const unavailableOf = (e, key) => new Unavailable(e?.code === 'RPC_DISAGREE' ? 'node-disagreement' : 'unavailable', key)
const revertOf = (e) => e?.code === 'RPC_ERROR' && (Number(e.data?.rpcCode) === 3 || e.data?.rpcRevert === true)

/**
 * The reads of one resolution, at one pinned block of `rpc` (an SDK createRpc client). opts: { config, logs (a logs
 * client and its settings, or null), processorNumber(processor, pin) (a hint, checked by cpuAt), maxProcessorScan }.
 * A pin that cannot be made gives reads whose every get() is UNAVAILABLE (stale-block or unavailable).
 * 一次解析的读取，钉在 rpc 的一个钉块上。钉不了块时，每次 get() 都是 UNAVAILABLE（stale-block 或 unavailable）。
 */
export async function liveReads(rpc, opts = {}) {
  const cfg = opts.config ?? PASSPORT_CONFIG
  const unreadable = (reason) => ({ pinnedBlock: null, heads: [], used: [], answers: {}, async get(key) { throw new Unavailable(reason, key === 'eth_chainId' ? 'pinnedBlock' : key) } })
  // A degraded client (allowSingleNode with fewer operators than its quorum) agrees with itself: that is never the
  // strict agreement of TAP-10 §5.2, which needs two operators at least (FIXED R30-P1).
  // 降级客户端（allowSingleNode，运营方少于法定数）只和自己一致，绝不是 TAP-10 §5.2 的严格共识（至少两家运营方）。
  if (rpc?.degraded === true) return unreadable('unavailable')
  let pin
  try { pin = await rpc.tap10Block({ maxLag: 400 }) } catch (e) {
    const reason = e?.code === 'RPC_STALE' || e?.data?.status === 'stale-block' ? 'stale-block' : e?.code === 'RPC_DISAGREE' ? 'node-disagreement' : 'unavailable'
    return unreadable(reason)
  }
  const at = { blockHash: pin.hash, requireCanonical: true }
  const used = []; const answers = {}; const hints = {}
  const logs = opts.logs ?? null
  const logState = { requests: 0, checked: null }
  const keep = (key, v) => { answers[key] = v; return v }
  const read = async (key, f) => {
    used.push(key)
    try { return keep(key, await f()) } catch (e) {
      if (e instanceof Unavailable) throw e
      if (revertOf(e)) return keep(key, { revert: typeof e.data?.rpcData === 'string' ? e.data.rpcData : '0x' })
      throw unavailableOf(e, key)
    }
  }
  const rd = {
    pinnedBlock: pin.number, heads: Object.values(pin.heads ?? {}), pin, used, answers, processorNumbers: hints,
    maxProcessorScan: Number.isSafeInteger(opts.maxProcessorScan) ? opts.maxProcessorScan : MAX_PROCESSOR_SCAN,
    async get(key) {
      if (key === 'eth_chainId') return read(key, () => rpc.call('eth_chainId', [], STRICT))
      if (key === 'block') { used.push(key); return keep(key, { hash: pin.hash, timestamp: pin.timestamp }) }
      if (key.startsWith('implSlot:')) return read(key, () => rpc.call('eth_getStorageAt', [key.slice(9), IMPL_SLOT, at], STRICT))
      if (key.startsWith('logs.')) { used.push(key); return keep(key, logs ? await logRead(logs, logState, cfg, pin, key) : { unavailable: true }) }
      const c = callOfKey(key)
      if (!c) throw new TapeAPIError('INVALID_ARGUMENT', `no live mapping for the read key ${key}`)
      return read(key, () => rpc.ethCall(c.to, c.data, at, STRICT))
    },
  }
  if (typeof opts.processorNumber === 'function') {
    rd.processorNumber = async (processor) => {
      let n
      try { n = await opts.processorNumber(processor, pin) } catch (e) { throw unavailableOf(e, `processor number of ${processor}`) }
      if (n !== null && n !== undefined) hints[processor] = Number(n)
      return n === null || n === undefined ? null : Number(n)
    }
  }
  return rd
}

// ── logs (optional) / 日志（可选）───────────────────────────────────────────
// The filter and the decoder of each log key. / 每个日志键的过滤条件与解码。
function logQuery(cfg, key) {
  let m = /^logs\.OperatorSet\((0x[0-9a-f]{40})\)$/.exec(key)
  if (m) return { kind: 'operators', address: addr(cfg.siteRegistry), topics: [LOG_TOPICS.OperatorSet, pad32(m[1])], decode: (l) => ({ operator: '0x' + l.data.slice(26, 66), setBy: '0x' + l.data.slice(90, 130), until: Number(BigInt('0x' + l.data.slice(130, 194))), block: l.block }) }
  m = /^logs\.Transfer\.identity\(([0-9]+)\)$/.exec(key)
  if (m) return { kind: 'identity', address: addr(cfg.identityRegistry), topics: [LOG_TOPICS.Transfer, null, null, pad32('0x' + BigInt(m[1]).toString(16))], decode: transfer }
  m = /^logs\.Transfer\.circuit\((0x[0-9a-f]{40}),([0-9]+)\)$/.exec(key)
  if (m) return { kind: 'circuit', address: m[1], topics: [LOG_TOPICS.Transfer, null, null, pad32('0x' + BigInt(m[2]).toString(16))], decode: transfer }
  return null
}
const transfer = (l) => ({ block: l.block, from: '0x' + l.topics[1].slice(26), to: '0x' + l.topics[2].slice(26) })
// The facts of a log, nothing a node decorates (blockTimestamp, ...). / 日志的事实字段，不含节点附加的字段。
function logFacts(list) {
  if (!Array.isArray(list)) throw new Error('eth_getLogs: not an array')
  return list.filter((l) => l && l.removed !== true).map((l) => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(l.address) || !Array.isArray(l.topics) || typeof l.data !== 'string') throw new Error('eth_getLogs: malformed log')
    return { address: l.address.toLowerCase(), topics: l.topics.map((t) => String(t).toLowerCase()), data: l.data.toLowerCase(), block: Number(BigInt(l.blockNumber)), index: Number(BigInt(l.logIndex)) }
  })
}
async function logRead(logs, state, cfg, pin, key) {
  const q = logQuery(cfg, key)
  if (!q) return { unavailable: true }
  const fromOpt = logs.fromBlock
  const from = typeof fromOpt === 'object' && fromOpt !== null ? (fromOpt[q.kind] ?? LOG_DEFAULTS.fromBlock) : (fromOpt ?? LOG_DEFAULTS.fromBlock)
  const chunk = logs.chunk ?? LOG_DEFAULTS.chunk; const max = logs.maxRequests ?? LOG_DEFAULTS.maxRequests
  if (!Number.isSafeInteger(from) || from < 0 || from > pin.number) return { unavailable: true }
  // Every log node must hold the pinned block, with the same hash: otherwise a node behind it would answer a shorter
  // history as if it were complete. / 每个日志节点都必须有这个钉块且哈希相同：否则落后的节点会把更短的历史当作完整的回答。
  if (state.checked === null) {
    state.requests++
    try {
      const b = await logs.rpc.call('eth_getBlockByNumber', [blockHex(pin.number), false], STRICT)
      state.checked = !!b && String(b.hash).toLowerCase() === String(pin.hash).toLowerCase()
    } catch (e) { if (e?.code === 'RPC_DISAGREE') throw new Unavailable('node-disagreement', key); state.checked = false }
  }
  if (!state.checked) return { unavailable: true }
  const need = Math.ceil((pin.number - from + 1) / chunk)
  if (state.requests + need > max) return { unavailable: true }   // over budget: nothing is sent / 超预算：一个请求都不发
  const out = []
  for (let lo = from; lo <= pin.number; lo += chunk) {
    const hi = Math.min(pin.number, lo + chunk - 1)
    state.requests++
    let got
    try {
      got = await logs.rpc.call('eth_getLogs', [{ address: q.address, topics: q.topics, fromBlock: blockHex(lo), toBlock: blockHex(hi) }], { ...STRICT, project: logFacts })
    } catch (e) {
      if (e?.code === 'RPC_DISAGREE') throw new Unavailable('node-disagreement', key)
      return { unavailable: true }   // refused, limited, timed out: the history is not obtained, never empty / 没拿到，绝不是空
    }
    for (const l of got) if (l.address === q.address && l.topics[0] === q.topics[0]) out.push(l)
  }
  out.sort((a, b) => a.block - b.block || a.index - b.index)
  try { return out.map(q.decode) } catch { return { unavailable: true } }
}

/**
 * The logs client of `opts.logs`: { urls } (nodes of at least 2 operators) or { rpc }, with chunk, maxRequests and
 * fromBlock (a number, or { operators, identity, circuit }). fromBlock defaults to 0: sound (no event is missed) but,
 * on BNB Smart Chain, far over the default budget, so give the block before the contracts were deployed.
 * opts.logs 的日志客户端。fromBlock 默认为 0：不会漏掉事件，但在 BNB 链上远超默认预算，所以请给出合约部署之前的块号。
 */
export function logsClient(logs, { fetch } = {}) {
  if (logs === undefined || logs === null || logs === 'off' || logs === false) return null
  if (!isObj(logs)) throw new TapeAPIError('INVALID_ARGUMENT', "logs: 'off' or { urls | rpc, fromBlock?, chunk?, maxRequests? }")
  for (const k of ['chunk', 'maxRequests']) if (logs[k] !== undefined && !(Number.isSafeInteger(logs[k]) && logs[k] > 0)) throw new TapeAPIError('INVALID_ARGUMENT', `logs.${k}: a positive whole number`)
  let rpc = logs.rpc
  if (rpc?.degraded === true) throw new TapeAPIError('INVALID_ARGUMENT', 'logs.rpc: a degraded client (allowSingleNode) is not strict agreement; give nodes of at least 2 distinct operators')
  if (!rpc) {
    if (!Array.isArray(logs.urls) || new Set(logs.urls.map(operatorOf)).size < 2) throw new TapeAPIError('INVALID_ARGUMENT', 'logs.urls: log-capable nodes of at least 2 distinct operators (strict agreement)')
    rpc = createRpc({ urls: logs.urls, quorum: 2, quiet: true, ...(fetch ? { fetch } : {}) })
  }
  return { rpc, fromBlock: logs.fromBlock, chunk: logs.chunk, maxRequests: logs.maxRequests }
}

/**
 * Resolve a passport on BNB Smart Chain, read-only. input: { agentId } | { circuit: { processor, tokenId } } |
 * { name: '4246.0.tape' }. opts: { api (a createTapeAPI() client of chain 56: its nodes and its processor table), or
 * rpc (a createRpc() client), or rpcUrls; logs; maxProcessorScan; recordSnapshot }. Without any, the SDK's default
 * public nodes. Never throws for a node, a timeout or a disagreement (UNAVAILABLE); only INVALID_ARGUMENT.
 * 在 BNB 链上只读地解析护照。节点、超时、分歧都不会抛错（UNAVAILABLE）；只有参数错误抛 INVALID_ARGUMENT。
 */
export async function resolvePassport(input, opts = {}) {
  normaliseInput(input)
  const cfg = opts.config ?? PASSPORT_CONFIG
  let api = opts.api ?? null
  if (api && Number(api.chainId) !== cfg.chainId && typeof api.forChain === 'function') api = api.forChain(cfg.chainId)
  if (api && Number(api.chainId) !== cfg.chainId) throw new TapeAPIError('INVALID_ARGUMENT', `api: a client of chain ${cfg.chainId}`)
  // Neither api nor rpc: a client of the SDK's default public nodes (or rpcUrls), whose processor table is used too.
  // 既没有 api 也没有 rpc：用 SDK 默认公共节点（或 rpcUrls）建一个客户端，同时用它的处理器表。
  if (!api && !opts.rpc) api = createTapeAPI({ rpcUrls: opts.rpcUrls ?? rpcUrlsFor(cfg.chainId), quorum: 2, quiet: true, ...(opts.fetch ? { fetch: opts.fetch } : {}) })
  const rpc = opts.rpc ?? api?.rpc
  if (!rpc || typeof rpc.tap10Block !== 'function') throw new TapeAPIError('INVALID_ARGUMENT', 'rpc: an SDK createRpc() client (or api: a createTapeAPI() client with rpcUrls)')
  const logs = logsClient(opts.logs, { fetch: opts.fetch })
  // The SDK's processor table (kept table, shipped snapshot, resumable scan) when the api is of this factory; the number it
  // gives is then checked by a strict cpuAt read. / api 属于同一工厂时用 SDK 的处理器表；它给出的编号再经严格的 cpuAt 读取核对。
  const table = api && typeof api.chain?.processorNumber === 'function' && eqAddr(api.addresses?.factory, cfg.factory) && (!opts.rpc || opts.rpc === api.rpc)
    ? async (processor, pin) => { const n = await api.chain.processorNumber(processor, { at: pin }); return n === null ? null : Number(n) } : null
  const rd = await liveReads(rpc, { config: cfg, logs, ...(table ? { processorNumber: table } : {}), maxProcessorScan: opts.maxProcessorScan })
  const res = await resolve(rd, input, cfg)
  res.reads = rd.used.length
  res.checked.logs = logs !== null
  if (opts.recordSnapshot) res.snapshot = snapshotOf(rd, input, cfg)
  return res
}

/**
 * The reads of a live resolution as a tap-agent-passport-snapshot/1 (the agreed answer per key, the operator heads),
 * replayable with resolveFromSnapshot for a bug report or an offline re-check. `processorNumbers` is a TapeAPI
 * extension: the hint the SDK's table gave (checked by the cpuAt read that is in `answers`).
 * 在线解析的读取导出为快照，可用 resolveFromSnapshot 离线重放。processorNumbers 是 TapeAPI 的扩展字段。
 */
export function snapshotOf(rd, input, cfg = PASSPORT_CONFIG) {
  const ops = Object.fromEntries(Object.entries(rd.pin?.heads ?? {}).map(([op, head]) => [op, { head, answers: {} }]))
  const plain = (v) => JSON.parse(canonicalJson(v))
  const inp = input.agentId !== undefined ? { agentId: String(input.agentId) } : input.circuit ? { circuit: { processor: addr(input.circuit.processor), tokenId: String(input.circuit.tokenId) } } : { name: String(input.name) }
  return { format: SNAPSHOT_FORMAT, source: 'live', config: plain(cfg), input: inp, pinnedBlock: rd.pinnedBlock, answers: plain(rd.answers), operators: ops, ...(Object.keys(rd.processorNumbers ?? {}).length ? { processorNumbers: { ...rd.processorNumbers } } : {}) }
}
