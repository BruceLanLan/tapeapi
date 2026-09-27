import { TapeAPIError } from './errors.js'
import { canonicalJSON, safeParseJSON } from './canon.js'

export const RPC_BODY_LIMIT = 4 * 1024 * 1024 // 4 MiB per JSON-RPC response / 单个 RPC 响应上限

// 只暴露主机名，绝不把带 key 的 URL 写进错误消息（M-13）/ Hostname only: never leak keyed URLs into error messages.
export function describeUrl(url, i) {
  try { return `node#${i}(${new URL(url).hostname})` } catch { return `node#${i}` }
}

// 有上限地读取响应体并安全解析 JSON（L-24 / M-08）/ Bounded body read + prototype-safe JSON parse.
export async function readJsonBounded(res, limit, { code = 'CANON_INVALID' } = {}) {
  const declared = Number(res.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > limit) throw new TapeAPIError(code, `response body ${declared} bytes exceeds limit ${limit}`, { tooLarge: true })
  let text
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader(); const chunks = []; let n = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      n += value.byteLength
      if (n > limit) { try { await reader.cancel() } catch { /* ignore */ } throw new TapeAPIError(code, `response body exceeds limit ${limit}`, { tooLarge: true }) }
      chunks.push(value)
    }
    const all = new Uint8Array(n); let o = 0
    for (const c of chunks) { all.set(c, o); o += c.byteLength }
    text = new TextDecoder().decode(all)
  } else if (typeof res.arrayBuffer === 'function') {
    // No stream: the limit is still in BYTES, as on the stream path (TAP-21 §3.2; spec review SD-6).
    // 没有流：上限仍按字节计，与流式路径相同。
    const all = new Uint8Array(await res.arrayBuffer())
    if (all.byteLength > limit) throw new TapeAPIError(code, `response body exceeds limit ${limit}`, { tooLarge: true })
    text = new TextDecoder().decode(all)
  } else {
    // String length counts UTF-16 units, which undercounts UTF-8 bytes up to 3x: measure the encoded bytes (SD-6).
    // 字符串长度数的是 UTF-16 单元，最多把 UTF-8 字节少算 3 倍：按编码后的字节计。
    text = await res.text()
    if (text.length > limit || new TextEncoder().encode(text).byteLength > limit) throw new TapeAPIError(code, `response body exceeds limit ${limit}`, { tooLarge: true })
  }
  return safeParseJSON(text, { code })
}

// 多节点 JSON-RPC：至少 quorum 个节点作答且全部一致才返回 / Multi-node JSON-RPC: at least `quorum` answers, all identical.
// urls.length < quorum 默认直接拒绝（M-11）；只有 allowSingleNode: true 才把 quorum 下调到节点数（开发用）。
// Fewer urls than quorum is an error by default (review M-11); only allowSingleNode: true clamps quorum to the
// node count (development setups). Duplicate urls are removed so one node cannot count twice.
// -32005 rate limited, -32601 method not found, and the range/limit refusals nodes return as -32000.
// -32005 限流、-32601 方法不存在，以及节点以 -32000 返回的区间/限额拒绝。
export function isNodeLimit(error) {
  const code = Number(error?.code)
  const msg = String(error?.message ?? '')
  if (code === -32005 || code === -32601) return true
  // Some clients also return -32000 for a revert, which IS an answer about the chain: never take a message that
  // mentions a revert as a node limit. / 有些客户端的回滚也用 -32000，而回滚是关于链的回答：提到 revert 的一律不算节点限制。
  // ...and so is running out of gas ("gas required exceeds allowance", "exceeds block gas limit") (review L-4)
  // 耗尽 gas 同样是关于链的回答
  if (code !== -32000 || /revert|gas|allowance/i.test(msg)) return false
  return /limit|range|too many|too large|more than|exceed|not supported|unsupported|timeout|too heavy|response size/i.test(msg)
}

// A JSON-RPC error that reports an execution revert: geth's code 3, or a message saying so (-32000 "execution reverted").
// 报告执行回滚的 JSON-RPC 错误：geth 的 code 3，或消息如此说（-32000 "execution reverted"）。
const revertShaped = (err) => Number(err?.code) === 3 || /revert/i.test(String(err?.message ?? ''))

// Node sets already warned about, once per process (arch A5) / 已警告过的节点集合，每个进程一次
const warnedSets = new Set()
// An https URL on a host that can resolve: not plain http, not a reserved name (RFC 6761: .invalid, .example, .test,
// .localhost). / 可解析主机上的 https URL：不是纯 http，也不是保留名（RFC 6761）。
const deployable = (u) => { const m = /^https:\/\/(?:[^/?#@]*@)?([^/?#:]+)/i.exec(u); return !!m && !/(?:^|\.)(?:invalid|example|test|localhost)$/i.test(m[1]) }

export function createRpc({ urls, quorum = 2, timeoutMs = 8000, fetch: fetchImpl, allowSingleNode = false, bodyLimit = RPC_BODY_LIMIT, disagreeRetryMs = 300, maxHeadSpread = 64, quiet = false, warn } = {}) {
  if (!Array.isArray(urls) || urls.length === 0) throw new TapeAPIError('RPC_UNAVAILABLE', 'no rpc urls')
  urls = [...new Set(urls.map(String))]
  if (!Number.isInteger(quorum) || quorum < 1) throw new TapeAPIError('RPC_UNAVAILABLE', 'quorum must be a positive integer')
  const f = fetchImpl || globalThis.fetch
  if (typeof f !== 'function') throw new TapeAPIError('RPC_UNAVAILABLE', 'no fetch implementation')
  let need = quorum
  if (urls.length < quorum) {
    if (allowSingleNode !== true) throw new TapeAPIError('RPC_UNAVAILABLE', `quorum ${quorum} needs at least ${quorum} distinct rpc urls, got ${urls.length} (pass allowSingleNode: true for a dev setup)`)
    need = urls.length
  }
  const degraded = need < quorum
  // A quorum equal to the node count has no spare: one node down, rate limiting or refusing a method stops every
  // read (arch A5). Said once per node set, and only for a set that could be a deployment (some `deployable` URL);
  // plain-http and reserved-name sets are local or test setups. `quiet: true` silences it.
  // quorum 等于节点数就没有余量：一个节点宕机、限流或拒绝某方法，所有读取都会停下（arch A5）。每个节点集合只说一次，
  // 且只对可能是正式部署的集合说；纯 http 与保留名集合是本地或测试环境。
  if (!quiet && !degraded && need > 1 && urls.length === need && urls.some(deployable)) {
    const key = [...urls].sort().join(',')
    if (!warnedSets.has(key)) {
      warnedSets.add(key)
      ;(warn || console.warn)(`[tapeapi] rpc: quorum ${need} of ${urls.length} nodes leaves no spare; any single node failure stops reads. Add a node (e.g. 2-of-3) or pass quiet: true.`)
    }
  }
  let nextId = 1
  // A node that ANSWERED no: a rejection carrying what it said (`refusal`), never an answer about the chain.
  // 作答说"不"的节点：带着原话（`refusal`）的拒绝，绝不是关于链的回答。
  const refused = (err, prefix = '') => {
    const refusal = { code: Number(err.code), message: String(err.message ?? '').slice(0, 120) }
    return Object.assign(new Error(`${prefix}node cannot answer (${err.code}): ${refusal.message}`), { refusal })
  }

  async function one(url, method, params) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    try {
      const res = await f(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }), signal: ac.signal,
      })
      if (!res.ok) {
        // An HTTP error may still carry the node's JSON-RPC answer: publicnode refuses history older than its window
        // as HTTP 403 + {-32602 "Archive requests require a personal token"} (recorded 2026-09-25, review R4-1). Read it,
        // bounded like any answer, and keep it as a refusal: it stays a rejection (the node did not answer the call, so
        // a 403 on one node's eth_call is never a quorum disagreement). A body that is not JSON (a Cloudflare HTML 520)
        // is a plain HTTP failure. / HTTP 错误也可能带着节点的 JSON-RPC 回答：publicnode 以 HTTP 403 + -32602 拒绝窗口之外
        // 的历史。有上限地读出来、记为拒绝：它仍是拒绝（节点没有回答该调用，一个节点 eth_call 返回 403 绝不算分歧）。
        // 不是 JSON 的响应体（Cloudflare 的 HTML 520）就是普通的 HTTP 失败。
        let j = null
        if (/\bjson\b/i.test(String(res.headers?.get?.('content-type') ?? ''))) { try { j = await readJsonBounded(res, bodyLimit) } catch { /* not a JSON-RPC answer / 不是 JSON-RPC 回答 */ } }
        // Any other body is left unread: cancel it, or the connection stays busy until it drains (review R5-7).
        // 其它响应体不读：取消它，否则连接一直被占着直到读完。
        else { try { await res.body?.cancel() } catch { /* already gone / 已经没了 */ } }
        if (j && typeof j === 'object' && j.error && typeof j.error === 'object') throw refused(j.error, `http ${res.status}, `)
        throw new Error(`http ${res.status}`)
      }
      const j = await readJsonBounded(res, bodyLimit)
      if (!j || typeof j !== 'object') throw new Error('bad json-rpc body')
      // A node that rate limits us, does not implement a method, or caps how much it will scan is telling us
      // about ITSELF, not about the chain: that is a node failure, like a timeout. A revert is an answer about
      // the chain and stays one. / 节点限流、不支持某方法、或限制扫描范围，说的是它自己而不是链：属于节点故障。
      // 回滚说的是链，仍然算作答。
      // `refusal` keeps what the node said: a node that ANSWERED no differs from one that could not be reached (review R2-1)
      // `refusal` 保留节点的原话：作答说"不"的节点与连不上的节点不同
      if (j.error && isNodeLimit(j.error)) throw refused(j.error)
      if (j.error) return { kind: 'error', value: { code: j.error.code, message: String(j.error.message ?? ''), data: typeof j.error.data === 'string' ? j.error.data : undefined } }
      if (!('result' in j)) throw new Error('no result')
      return { kind: 'ok', value: j.result }
    } finally { clearTimeout(timer) }
  }

  // TAP-20 §3.2: accept only when EVERY node that answered returned the same bytes; any split is RPC_DISAGREE,
  // never a majority. A node that failed in transport (timeout, HTTP error, oversize body) did not answer and is
  // not a disagreement, but at least `need` nodes must answer. A revert on one node and a value on another is a
  // disagreement. One re-ask of all nodes absorbs the honest race where nodes straddle a block boundary on
  // "latest"; the re-ask must be unanimous too.
  // TAP-20 §3.2：所有作答节点的字节必须完全一致；任何分歧都是 RPC_DISAGREE，绝不少数服从多数。传输失败不算作答、
  // 也不算分歧，但作答数须 ≥ need。一个 revert、一个有值，是分歧。对全部节点重问一次以吸收 "latest" 跨块边界的
  // 诚实竞态；重问也必须一致。
  async function round(method, params, project) {
    const settled = await Promise.allSettled(urls.map(u => one(u, method, params)))
    const buckets = new Map(); const failures = []; const refusals = []; let tooLarge = 0
    settled.forEach((s, i) => {
      if (s.status === 'rejected') { failures.push(`${describeUrl(urls[i], i)}: ${s.reason?.message || s.reason}`); if (s.reason?.refusal) refusals.push(s.reason.refusal); if (s.reason?.tooLarge) tooLarge++; return }
      // 错误按 code 与是否回滚形态分桶，不按原文（各实现 revert 文本不同，M-12；R3-4）/ errors bucket by code and revert
      // shape, never by text: revert texts differ per client (review M-12, R3-4)
      // `project` keeps only the fields that are facts about the chain: nodes decorate some answers differently
      // (a log object may or may not carry blockTimestamp), and decoration is not disagreement.
      // `project` 只保留关于链的事实字段：各节点对某些回答的附加字段不同（日志对象可能带或不带 blockTimestamp），附加字段不算分歧。
      if (s.value.kind === 'ok' && project) {
        try { s.value.value = project(s.value.value) } catch (e) { failures.push(`${describeUrl(urls[i], i)}: malformed answer (${e.message})`); return }
      }
      // ...and by whether it is revert-shaped (code 3, or a message saying "revert"): "execution reverted" on one node and
      // "header not found" on another share -32000, yet only one is an answer about the chain (review R3-4).
      // ……并按是否为回滚形态分桶：一个节点 "execution reverted"、另一个 "header not found" 同为 -32000，但只有前者是关于链的回答。
      const key = s.value.kind === 'error' ? `error:${s.value.value.code}:${revertShaped(s.value.value) ? 'revert' : ''}` : 'ok:' + canonicalJSON(s.value.value)
      const b = buckets.get(key) || { n: 0, r: s.value }; b.n++; buckets.set(key, b)
    })
    const answered = settled.length - failures.length
    // `refusals`: set only when every node that failed answered with a node-limit error (none unreachable)
    // `refusals`：仅当每个失败的节点都以节点限制错误作答（没有连不上的）时给出
    // `tooLarge`: every node that failed sent an answer over bodyLimit -- set by this client, never read from a node's words
    // `tooLarge`：每个失败的节点发来的回答都超过 bodyLimit——由本客户端标记，绝不从节点的话里推断
    if (answered < need) throw new TapeAPIError('RPC_UNAVAILABLE', `${method}: only ${answered}/${need} nodes answered (${failures.join('; ')})`, { ...(refusals.length && refusals.length === failures.length ? { refusals } : {}), ...(tooLarge && tooLarge === failures.length ? { tooLarge: true } : {}) })
    if (buckets.size > 1) throw new TapeAPIError('RPC_DISAGREE', `${method}: ${answered} nodes answered with ${buckets.size} different results`)
    const [b] = buckets.values()
    if (b.r.kind === 'error') {
      // Errors bucket by code (messages differ per client), but revert DATA is chain state: surface it only when
      // every node reported the same bytes. / 错误按 code 分桶；revert 数据是链上状态，仅当所有节点字节一致时才给出。
      const datas = new Set(settled.filter((x) => x.status === 'fulfilled').map((x) => x.value.value.data))
      // `rpcRevert`: every answering node reported a revert (review R3-4) / 每个作答节点报的都是回滚
      throw new TapeAPIError('RPC_ERROR', `${method}: ${b.r.value.message}`, { rpcCode: b.r.value.code, ...(revertShaped(b.r.value) ? { rpcRevert: true } : {}), ...(datas.size === 1 && b.r.value.data ? { rpcData: b.r.value.data } : {}) })
    }
    return b.r.value
  }

  async function call(method, params = [], { project } = {}) {
    try { return await round(method, params, project) }
    catch (e) {
      if (e.code !== 'RPC_DISAGREE' || disagreeRetryMs < 0) throw e
      await new Promise((r) => setTimeout(r, disagreeRetryMs))
      return round(method, params, project)
    }
  }

  // eth_blockNumber is not an eth_call and honest nodes are routinely a block or two apart, so byte equality
  // would fail all the time. Take the LOWEST head among at least `need` answers (a block every answering node
  // has reached) and refuse a spread wider than maxHeadSpread, which means a stale or lying node.
  // eth_blockNumber 不是 eth_call，诚实节点常差一两个块，逐字节比较会一直失败。取至少 need 个作答中的最低块高
  // （每个作答节点都已到达），块高差超过 maxHeadSpread 视为节点落后或撒谎而拒绝。
  async function blockNumber() {
    const settled = await Promise.allSettled(urls.map(u => one(u, 'eth_blockNumber', [])))
    const heads = []; const failures = []
    settled.forEach((s, i) => {
      if (s.status === 'fulfilled' && s.value.kind === 'ok') {
        try { heads.push(Number(BigInt(s.value.value))); return } catch { /* fall through */ }
      }
      failures.push(`${describeUrl(urls[i], i)}: ${s.status === 'rejected' ? (s.reason?.message || s.reason) : 'bad eth_blockNumber answer'}`)
    })
    if (heads.length < need) throw new TapeAPIError('RPC_UNAVAILABLE', `eth_blockNumber: only ${heads.length}/${need} nodes answered (${failures.join('; ')})`)
    const lo = Math.min(...heads); const hi = Math.max(...heads)
    if (hi - lo > maxHeadSpread) throw new TapeAPIError('RPC_DISAGREE', `eth_blockNumber: heads span ${lo}..${hi}, more than ${maxHeadSpread} blocks apart`)
    return lo
  }

  async function ethCall(to, data, block = 'latest') { return call('eth_call', [{ to, data }, block]) }
  async function chainId() { return Number(BigInt(await call('eth_chainId', []))) }
  // A client for ONE node, with this client's fetch and timeout. Data that authenticates itself (a TAP-26 frame,
  // a payload whose digest is on chain) needs no agreement: one honest node is enough, and asking every node to
  // agree only makes such a read fail whenever any node is unavailable or refuses the method (TAP-26 §3.7).
  // 单节点客户端。自带认证的数据（TAP-26 帧、摘要在链上的载荷）不需要一致：一个诚实节点就够；要求全体一致
  // 反而会让这种读取在任一节点不可用或拒绝该方法时失败。
  // `o.bodyLimit` raises the answer size for one kind of read (a whole block's receipts, TAP-26 §3.7) / 为某类读取放宽回答大小
  const single = (url, o = {}) => {
    if (!urls.includes(url)) throw new TapeAPIError('RPC_UNAVAILABLE', `${describeUrl(url, 0)} is not one of this client's nodes`)
    return createRpc({ urls: [url], quorum: 1, timeoutMs, fetch: fetchImpl, bodyLimit: o.bodyLimit ?? bodyLimit, disagreeRetryMs, maxHeadSpread })
  }
  return { call, ethCall, blockNumber, chainId, urls, quorum: need, degraded, single, bodyLimit }
}
