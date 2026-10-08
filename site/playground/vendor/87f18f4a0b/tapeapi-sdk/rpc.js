import { TapeAPIError } from './errors.js'
import { canonicalJSON, safeParseJSON } from './canon.js'
import { operatorOf } from './rpc-defaults.js'

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
    // No stream: the limit is still in BYTES, as on the stream path (TAPI-21 §3.2; spec review SD-6).
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
// Agreement is counted by OPERATOR, not by URL (operatorOf): two URLs of one operator that answer count once, and a
// node set with fewer distinct operators than quorum is refused like one with too few URLs (the old default, three
// NodeReal dataseeds, was one operator). Every URL is still asked, and every answer must still agree.
// 按**运营方**而不是 URL 计票：同一运营方的两个 URL 作答只算一次；不同运营方少于 quorum 的节点组合与 URL 太少一样被拒绝
// （旧默认的三个 NodeReal dataseed 只是一家）。每个 URL 仍然都问，所有回答仍须一致。
// A JSON-RPC error that reports an execution revert: geth's code 3, or a message saying so (-32000 "execution reverted").
// 报告执行回滚的 JSON-RPC 错误：geth 的 code 3，或消息如此说（-32000 "execution reverted"）。
const revertShaped = (err) => Number(err?.code) === 3 || /revert/i.test(String(err?.message ?? ''))

// -32005 rate limited, -32601 method not found, and the range/limit refusals nodes return as -32000.
// -32005 限流、-32601 方法不存在，以及节点以 -32000 返回的区间/限额拒绝。
// Rate limits in any code (FIXED RPC2-1, measured 2026-09-30): Coinbase answers each batch element with -32016 "over rate
// limit" inside an HTTP 200, dRPC with 15, others with 429 or -32029 / -32429. A node saying it is limited has not
// answered; a revert, or an answer about gas or an allowance, stays an answer whatever words it carries.
// 任何代码的限流（FIXED RPC2-1，2026-09-30 实测）：Coinbase 在 HTTP 200 的批量里对每个元素回 -32016 "over rate limit"，dRPC
// 回 15，其它节点回 429 或 -32029 / -32429。节点说自己被限流就是没有作答；回滚，或关于 gas、allowance 的回答，不论带什么字眼仍是回答。
const LIMIT_CODES = new Set([-32016, -32029, -32429, 15, 429])
const LIMIT_WORDS = /rate.?limit|too many requests|throttl|exceeded|quota|capacity/i
export function isNodeLimit(error) {
  const code = Number(error?.code)
  const msg = String(error?.message ?? '')
  if (code === -32005 || code === -32601) return true
  // Some clients also return -32000 for a revert, which IS an answer about the chain: never take a message that
  // mentions a revert as a node limit. / 有些客户端的回滚也用 -32000，而回滚是关于链的回答：提到 revert 的一律不算节点限制。
  // ...and so is running out of gas ("gas required exceeds allowance", "exceeds block gas limit") (review L-4)
  // 耗尽 gas 同样是关于链的回答
  if (revertShaped(error) || /gas|allowance/i.test(msg)) return false
  if (LIMIT_CODES.has(code) || LIMIT_WORDS.test(msg)) return true
  if (code !== -32000) return false
  return /limit|range|too many|too large|more than|exceed|not supported|unsupported|timeout|too heavy|response size/i.test(msg)
}

// A state read pinned to one block (security 1.1): eth_call, eth_getCode or eth_getStorageAt whose block parameter is an
// EIP-1898 object or a hex block number, never a tag. eth_getLogs is not one (its filter may carry a blockHash too).
// 钉在某个区块上的状态读取（安全加固 1.1）：区块参数为 EIP-1898 对象或十六进制块号（绝不是标签）的 eth_call、eth_getCode、
// eth_getStorageAt。eth_getLogs 不算（它的过滤器也可能带 blockHash）。
const PINNABLE = { eth_call: 1, eth_getCode: 1, eth_getStorageAt: 2 }
const pinnedRead = (method, params) => {
  const b = Array.isArray(params) && PINNABLE[method] !== undefined ? params[PINNABLE[method]] : undefined
  return (typeof b === 'string' && /^0x[0-9a-fA-F]+$/.test(b)) || (!!b && typeof b === 'object' && ('blockHash' in b || 'blockNumber' in b))
}
// A node saying it does not have that block (it lags behind the pinned block): -32001 "resource not found" (EIP-1898),
// or a message naming a missing block/header, and never a revert. "not canonical" / "not currently canonical" is not
// this: it is what the node says about the chain, and stays an answer. Only those words are excluded: publicnode and
// Coinbase say "block not found: canonical hash 0x…" (measured 2026-09-30), which is a missing block (FIXED RPC2-2).
// 节点表示它没有该区块（落后于所钉区块）：-32001 "resource not found"（EIP-1898），或消息说区块/区块头不存在，且绝不是回滚。
// "not canonical" / "not currently canonical" 不属此类：那是节点对链的陈述，仍算作答。只排除这两种措辞：publicnode 与 Coinbase
// 答 "block not found: canonical hash 0x…"（2026-09-30 实测），那是没有该块（FIXED RPC2-2）。
const blockMissing = (err) => !revertShaped(err) && !/not (?:currently )?canonical/i.test(String(err?.message ?? '')) &&
  (Number(err?.code) === -32001 || /header.*not found|block.*not found|unknown block|not found.*block/i.test(String(err?.message ?? '')))

// Node sets already warned about, once per process (arch A5) / 已警告过的节点集合，每个进程一次
const warnedSets = new Set()
// An https URL on a host that can resolve: not plain http, not a reserved name (RFC 6761: .invalid, .example, .test,
// .localhost). / 可解析主机上的 https URL：不是纯 http，也不是保留名（RFC 6761）。
const deployable = (u) => { const m = /^https:\/\/(?:[^/?#@]*@)?([^/?#:]+)/i.exec(u); return !!m && !/(?:^|\.)(?:invalid|example|test|localhost)$/i.test(m[1]) }

// The connection broke before any answer (FIXED RPC2-4): a reset, "socket hang up", a body "terminated", a network
// TypeError. Never a timeout or an abort, never what a node answered (an HTTP error, a refusal, a body too large or not JSON).
// 连接在任何回答之前断开（FIXED RPC2-4）：重置、"socket hang up"、响应体 "terminated"、网络 TypeError。绝不是超时或中止，
// 也绝不是节点的回答（HTTP 错误、拒绝、过大或不是 JSON 的响应体）。
const BROKEN_CODES = new Set(['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET'])
function brokenConnection(e) {
  if (!e || typeof e !== 'object' || e instanceof TapeAPIError || e.refusal || e.timedOut) return false
  const causes = [e, e.cause, e.cause?.cause].filter((x) => x && typeof x === 'object')
  const words = causes.map((x) => `${x.name ?? ''} ${x.code ?? ''} ${x.message ?? ''}`).join(' ')
  if (/abort|timeout|timed ?out/i.test(words)) return false
  if (causes.some((x) => BROKEN_CODES.has(String(x.code ?? '')))) return true
  if (/ECONNRESET|EPIPE|socket hang up|other side closed|\bterminated\b/i.test(words)) return true
  // A network TypeError from fetch: Node, Chrome, Firefox, Safari / fetch 抛出的网络 TypeError：Node、Chrome、Firefox、Safari
  return e instanceof TypeError && /fetch failed|failed to fetch|networkerror|load failed/i.test(String(e.message))
}

export function createRpc({ urls, quorum = 2, timeoutMs = 8000, fetch: fetchImpl, allowSingleNode = false, bodyLimit = RPC_BODY_LIMIT, disagreeRetryMs = 300, maxHeadSpread = 64, quiet = false, warn, transportRetryMs = 250 } = {}) {
  if (!Array.isArray(urls) || urls.length === 0) throw new TapeAPIError('INVALID_ARGUMENT', 'no rpc urls')
  urls = [...new Set(urls.map(String))]
  if (!Number.isInteger(quorum) || quorum < 1) throw new TapeAPIError('INVALID_ARGUMENT', 'quorum must be a positive integer')
  const f = fetchImpl || globalThis.fetch
  if (typeof f !== 'function') throw new TapeAPIError('INVALID_ARGUMENT', 'no fetch implementation')
  // opOf[i]: who runs urls[i] / urls[i] 的运营方
  const opOf = urls.map(operatorOf)
  const operators = [...new Set(opOf)]
  let need = quorum
  if (urls.length < quorum) {
    if (allowSingleNode !== true) throw new TapeAPIError('INVALID_ARGUMENT', `quorum ${quorum} needs at least ${quorum} distinct rpc urls, got ${urls.length} (pass allowSingleNode: true for a dev setup)`)
    need = urls.length
  }
  if (operators.length < need) {
    if (allowSingleNode !== true) throw new TapeAPIError('INVALID_ARGUMENT', `quorum ${quorum} needs nodes of at least ${quorum} independent operators, got ${operators.length} (${operators.join(', ')}); URLs of one operator count once (pass allowSingleNode: true for a dev setup)`)
    need = operators.length
  }
  // Distinct operators among the nodes that answered (indexes into urls) / 作答节点中不同运营方的数目
  const operatorsOf = (idx) => new Set(idx.map((i) => opOf[i])).size
  const degraded = need < quorum
  // TAP-10 §5.2 strict agreement / 严格共识
  const strictNeed = degraded ? need : Math.max(need, 2, Math.min(3, operators.length))
  // A quorum equal to the node count has no spare: one node down, rate limiting or refusing a method stops every
  // read (arch A5). Said once per node set, and only for a set that could be a deployment (some `deployable` URL);
  // plain-http and reserved-name sets are local or test setups. `quiet: true` silences it.
  // quorum 等于节点数就没有余量：一个节点宕机、限流或拒绝某方法，所有读取都会停下（arch A5）。每个节点集合只说一次，
  // 且只对可能是正式部署的集合说；纯 http 与保留名集合是本地或测试环境。
  // Counted in operators: a second URL of the same operator is no spare when that operator is down.
  // 按运营方计：同一运营方的第二个 URL 在该运营方宕机时不是余量。
  if (!quiet && !degraded && need > 1 && operators.length === need && urls.some(deployable)) {
    const key = [...urls].sort().join(',')
    if (!warnedSets.has(key)) {
      warnedSets.add(key)
      ;(warn || console.warn)(`[tapeapi] rpc: quorum ${need} of ${operators.length === urls.length ? `${urls.length} nodes` : `${operators.length} operators`} leaves no spare; any single node failure stops reads. Add a node (e.g. 2-of-3) or pass quiet: true.`)
    }
  }
  let nextId = 1
  // A node that ANSWERED no: a rejection carrying what it said (`refusal`), never an answer about the chain.
  // 作答说"不"的节点：带着原话（`refusal`）的拒绝，绝不是关于链的回答。
  const refused = (err, prefix = '') => {
    const refusal = { code: Number(err.code), message: String(err.message ?? '').slice(0, 120) }
    return Object.assign(new Error(`${prefix}node cannot answer (${err.code}): ${refusal.message}`), { refusal })
  }

  // One JSON-RPC response object -> an answer ({ kind, value }), or a throw when the node did not answer (the rules below).
  // 一个 JSON-RPC 响应对象 -> 回答；节点没有作答时抛出（规则见下）。
  function answerOf(j) {
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
  }

  // A plain request whose connection broke is asked once more after transportRetryMs (FIXED RPC2-4: X Layer has two
  // operators, so one reset was RPC_UNAVAILABLE). A timeout is not asked again. Batches keep P101-3: their calls are
  // asked again alone, through here. transportRetryMs <= 0 turns it off.
  // 连接断开的单个请求过 transportRetryMs 再问一次（FIXED RPC2-4：X Layer 只有两家运营方，一次重置就是 RPC_UNAVAILABLE）。
  // 超时不重问。批量仍按 P101-3：其中的调用逐个重问，走的就是这里。transportRetryMs <= 0 关闭重试。
  async function one(url, method, params) {
    try { return await once(url, method, params) } catch (e) {
      if (!(transportRetryMs > 0) || !brokenConnection(e)) throw e
      await new Promise((r) => setTimeout(r, transportRetryMs))
      return once(url, method, params)
    }
  }
  async function once(url, method, params) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    const id = nextId++
    try {
      const res = await f(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), signal: ac.signal,
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
      // An answer to another request (or to none: no id, id null) is not an answer to this one: the node did not answer,
      // as a batch element with the wrong id (FIXED RPC-ID). A node-limit refusal addressed to no request (id null, as a
      // front end may send it) stays a refusal: it is still not an answer. / 回答的是别的请求（或没有 id、id 为 null）就不是对
      // 这个请求的回答：该节点没有作答，与批量里 id 不对的元素一样。不针对任何请求的节点限流拒绝仍记为拒绝：它同样不是回答。
      const j = await readJsonBounded(res, bodyLimit)
      const obj = !!j && typeof j === 'object' && !Array.isArray(j)
      if (!obj || !('id' in j) || j.id === null || String(j.id) !== String(id)) {
        if (obj && (j.id ?? null) === null && j.error && typeof j.error === 'object' && isNodeLimit(j.error)) throw refused(j.error)
        throw new Error('the answer is for another request (id mismatch)')
      }
      return answerOf(j)
    } catch (e) {
      // our timer fired: a timeout / 自己的计时器触发：超时
      if (ac.signal.aborted && e && typeof e === 'object') { try { e.timedOut = true } catch { /* frozen / 不可写 */ } }
      throw e
    } finally { clearTimeout(timer) }
  }

  // JSON-RPC batching (performance only; what counts as an answer, and every quorum rule, is unchanged). Calls to one node
  // started in the same turn of the event loop go out as one batch request of at most MAX_BATCH calls; a lone call goes
  // out as a plain request, exactly as before. Each call in a batch is still its own quorum round across all nodes.
  // JSON-RPC 批量（只为性能；什么算回答、所有法定数规则都不变）。同一轮事件循环里发往同一节点的调用合并为一个批量请求，
  // 每批至多 MAX_BATCH 个；只有一个调用时照旧发普通请求。批里的每个调用仍然各自在全部节点间过法定数。
  // - Answers are matched by id, never by position; a call the batch did not answer is a call that node did not answer.
  //   按 id 而不是位置对应回答；批量里没有回答的调用，就是该节点没有回答的调用。
  // - A batch that fails other than by a timeout (an HTTP error, a body that is not an array, an answer too large, a network
  //   failure) is asked again call by call. Its elements are never read on an HTTP error: dRPC's free plan answers a batch
  //   of 4 with HTTP 500 and an error per element (code 31, measured 2026-09-29), which read as answers would be a false
  //   disagreement. / 非超时的批量失败（HTTP 错误、响应体不是数组、回答过大、网络失败）改为逐个重问。HTTP 错误时绝不读取其中的
  //   元素：dRPC 免费档对 4 个调用的批量回 HTTP 500 且每个元素都带错误（code 31，2026-09-29 实测），当作回答会造成假分歧。
  // - What the node ANSWERED about the batch (an HTTP error, a single object, a 200 body that is not JSON) means it does not
  //   take batches: every later call to it goes out alone. A failure with no answer (the connection reset, the body cut
  //   off mid-read) says nothing about batches: later calls go out alone only until BATCH_RETRY_MS has passed or the node
  //   has answered BATCH_RETRY_CALLS calls alone, then it is sent a batch again (FIXED P101-3: one reset used to stop
  //   batching to that node for the client's lifetime). An answer too large is about that batch only and changes nothing.
  //   节点对批量的**回答**（HTTP 错误、单个对象、不是 JSON 的 200 响应体）说明它不接受批量：之后发往它的调用都逐个发送。没有回答的
  //   失败（连接被重置、响应体读到一半断掉）与批量无关：之后的调用只逐个发送到过了 BATCH_RETRY_MS 或该节点逐个答完
  //   BATCH_RETRY_CALLS 个调用为止，然后再发批量（FIXED P101-3：以前一次重置就让该节点在客户端生命周期内不再批量）。
  //   回答过大只关乎那一批，什么都不改变。
  // - A timeout is not retried call by call: the node did not answer, and each call fails as a single one would.
  //   超时不逐个重问：节点没有作答，每个调用都像单个请求那样失败。
  // MAX_BATCH 3: dRPC's free plan (a default node of X Layer and Base) refuses a batch of more than 3 (measured 2026-09-29).
  // MAX_BATCH 为 3：dRPC 免费档（X Layer 与 Base 的默认节点）拒绝超过 3 个调用的批量（2026-09-29 实测）。
  const MAX_BATCH = 3
  const BATCH_RETRY_MS = 5 * 60_000, BATCH_RETRY_CALLS = 20
  // url -> { until, calls }: no batch to it before `until` (Infinity: never) unless `calls` calls were answered alone first
  // url -> { until, calls }：`until` 之前（Infinity 为永不）不向它发批量，除非先逐个答完 `calls` 个调用
  const noBatch = new Map()
  const batching = (url) => {
    const p = noBatch.get(url)
    if (!p) return true
    if (p.until === Infinity || (Date.now() < p.until && p.calls < BATCH_RETRY_CALLS)) return false
    noBatch.delete(url)
    return true
  }
  // an eth_call sent alone while batching is paused; each one the node answers counts toward batching again
  // 暂停批量期间单独发出的 eth_call；节点每答一个，都向恢复批量计一次
  const alone = (url, method, params) => one(url, method, params).then((a) => { const p = noBatch.get(url); if (p) p.calls++; return a })
  const queues = new Map()       // url -> calls waiting for this turn's flush / 等待本轮发出的调用
  // Only eth_call is batched: resolve and the identity reads are eth_calls, and the other methods keep the exact wire
  // behaviour each node was measured with (publicnode refuses old eth_getLogs as HTTP 403 per request, review R4-1).
  // The identity-root sentinel's eth_getStorageAt reads (security 1.1) go out alone, in the same turn as the batch they
  // would have joined (no extra round): a node that answers "no" to a batch holding them would otherwise be taken as a
  // node that refuses batches, and stop getting eth_call batches for the client's lifetime (FIXED SECR-5); and the
  // eth_call batches of a resolution stay exactly those of 1.1.0.
  // 只批量 eth_call：解析与身份读取都是 eth_call；其它方法保持各节点实测时的原样（publicnode 按请求以 HTTP 403 拒绝旧日志）。
  // 身份根哨兵的 eth_getStorageAt（安全加固 1.1）单独发出，与它本会加入的批量在同一轮（不多一轮）：否则节点对含有它们的批量说
  // "不"，会被当成不接受批量的节点，在客户端生命周期内不再收到 eth_call 批量（FIXED SECR-5）；解析的 eth_call 批量也与 1.1.0 完全相同。
  function ask(url, method, params) {
    if (method !== 'eth_call') return one(url, method, params)
    if (!batching(url)) return alone(url, method, params)
    return new Promise((resolve, reject) => {
      let q = queues.get(url)
      // setTimeout 0, not a microtask: a read started after an already-settled await (a cached fact) still joins the batch
      // setTimeout 0 而不是微任务：在已完成的 await（缓存的事实）之后才开始的读取也能进入同一批
      if (!q) { q = []; queues.set(url, q); setTimeout(() => flush(url), 0) }
      q.push({ method, params, resolve, reject })
    })
  }
  function flush(url) {
    const q = queues.get(url) ?? []
    queues.delete(url)
    for (let i = 0; i < q.length; i += MAX_BATCH) {
      const part = q.slice(i, i + MAX_BATCH)
      if (part.length === 1) one(url, part[0].method, part[0].params).then(part[0].resolve, part[0].reject)
      else if (!batching(url)) for (const c of part) alone(url, c.method, c.params).then(c.resolve, c.reject)
      else batch(url, part)
    }
  }
  async function batch(url, part) {
    const ids = part.map(() => nextId++)
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    let list
    let answered = false      // the node said something about the batch / 节点对这一批有所回答
    try {
      const res = await f(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(part.map((c, k) => ({ jsonrpc: '2.0', id: ids[k], method: c.method, params: c.params }))), signal: ac.signal,
      })
      if (!res.ok) { answered = true; try { await res.body?.cancel() } catch { /* already gone / 已经没了 */ } throw new Error(`http ${res.status}`) }
      // A body that is not JSON is an answer; a body cut off mid-read (a raw stream error) is not.
      // 不是 JSON 的响应体是回答；读到一半断掉的响应体（原始的流错误）不是。
      try { list = await readJsonBounded(res, bodyLimit) } catch (e) { if (e instanceof TapeAPIError) answered = true; throw e }
      answered = true
      if (!Array.isArray(list)) throw new Error('batch answered with a single object')
    } catch (e) {
      if (ac.signal.aborted) { for (const c of part) c.reject(e); return }
      // An answer over bodyLimit is about this batch, not the node: ask call by call, each under its own limit.
      // 超过 bodyLimit 说的是这一批而不是节点：逐个重问，各自受上限约束。
      if (!e?.data?.tooLarge) {
        const before = noBatch.get(url)
        if (answered) noBatch.set(url, { until: Infinity, calls: 0 })
        else if (before?.until !== Infinity) noBatch.set(url, { until: Date.now() + BATCH_RETRY_MS, calls: 0 })
      }
      for (const c of part) alone(url, c.method, c.params).then(c.resolve, c.reject)
      return
    } finally { clearTimeout(timer) }
    const byId = new Map()
    for (const j of list) if (j && typeof j === 'object' && 'id' in j && !byId.has(String(j.id))) byId.set(String(j.id), j)
    part.forEach((c, k) => {
      const j = byId.get(String(ids[k]))
      if (!j) { c.reject(new Error('no answer in batch')); return }
      try { c.resolve(answerOf(j)) } catch (e) { c.reject(e) }
    })
  }

  // TAPI-20 §3.2: accept only when EVERY node that answered returned the same bytes; any split is RPC_DISAGREE,
  // never a majority. A node that failed in transport (timeout, HTTP error, oversize body) did not answer and is
  // not a disagreement, but at least `need` nodes must answer. A revert on one node and a value on another is a
  // disagreement. One re-ask of all nodes absorbs the honest race where nodes straddle a block boundary on
  // "latest"; the re-ask must be unanimous too.
  // TAPI-20 §3.2：所有作答节点的字节必须完全一致；任何分歧都是 RPC_DISAGREE，绝不少数服从多数。传输失败不算作答、
  // 也不算分歧，但作答数须 ≥ need。一个 revert、一个有值，是分歧。对全部节点重问一次以吸收 "latest" 跨块边界的
  // 诚实竞态；重问也必须一致。
  // `opts.answers === 'tap10'` (@experimental, TAP-10 conformance): only a result or an execution revert is an answer
  // (TAP-10 §1 "Answer"); any other JSON-RPC error is a node failure, like a timeout. `opts.strict` (TAP-10 §5.2 strict
  // agreement): the agreeing answers must come from at least max(2, min(3, operators)) operators (never fewer than the
  // quorum; a degraded allowSingleNode set keeps its own count). Neither is set by any 1.x default read.
  // `opts.answers === 'tap10'`（@experimental，TAP-10 一致模式）：只有结果与执行回滚算回答（TAP-10 §1）；其它 JSON-RPC 错误与超时
  // 一样算节点故障。`opts.strict`（TAP-10 §5.2 严格共识）：一致的回答须来自至少 max(2, min(3, 运营方数)) 家运营方（不少于法定数；
  // allowSingleNode 降级的节点组合保持自己的数目）。1.x 的默认读取都不设这两项。
  async function round(method, params, project, opts = null) {
    const settled = await Promise.allSettled(urls.map(u => ask(u, method, params)))
    const buckets = new Map(); const failures = []; const refusals = []; const answeredIdx = []; let tooLarge = 0
    const pinned = pinnedRead(method, params)
    const tap10Answers = opts?.answers === 'tap10'
    const needHere = opts?.strict ? strictNeed : need
    settled.forEach((s, i) => {
      if (s.status === 'rejected') { failures.push(`${describeUrl(urls[i], i)}: ${s.reason?.message || s.reason}`); if (s.reason?.refusal) refusals.push(s.reason.refusal); if (s.reason?.data?.tooLarge) tooLarge++; return }
      if (tap10Answers && s.value.kind === 'error' && !revertShaped(s.value.value)) { failures.push(`${describeUrl(urls[i], i)}: not an answer (${s.value.value.code}: ${s.value.value.message.slice(0, 80)})`); return }
      // A pinned read that a node answers with "no such block" (it has not reached the pinned block yet): that node did
      // not answer, as a timeout would not (FIXED SECR-3). Nodes that have the block still all have to agree, and at least
      // `need` operators still have to answer. Not a refusal: channel.js reads `refusals` as what a node will not do.
      // 钉块读取中节点答"没有该区块"（尚未到达所钉区块）：该节点没有作答，与超时相同（FIXED SECR-3）。持有该块的节点仍须全体一致，
      // 作答的运营方仍须 ≥ need。不记为 refusal：channel.js 把 `refusals` 读作节点不肯做的事。
      if (pinned && s.value.kind === 'error' && blockMissing(s.value.value)) { failures.push(`${describeUrl(urls[i], i)}: does not have the pinned block (${s.value.value.code}: ${s.value.value.message.slice(0, 80)})`); return }
      // 错误按 code 与是否回滚形态分桶，不按原文（各实现 revert 文本不同，M-12；R3-4）/ errors bucket by code and revert
      // shape, never by text: revert texts differ per client (review M-12, R3-4)
      // `project` keeps only the fields that are facts about the chain: nodes decorate some answers differently
      // (a log object may or may not carry blockTimestamp), and decoration is not disagreement.
      // `project` 只保留关于链的事实字段：各节点对某些回答的附加字段不同（日志对象可能带或不带 blockTimestamp），附加字段不算分歧。
      if (s.value.kind === 'ok' && project) {
        try { s.value.value = project(s.value.value, i) } catch (e) { failures.push(`${describeUrl(urls[i], i)}: malformed answer (${e.message})`); return }
      }
      // ...and by whether it is revert-shaped (code 3, or a message saying "revert"): "execution reverted" on one node and
      // "header not found" on another share -32000, yet only one is an answer about the chain (review R3-4).
      // ……并按是否为回滚形态分桶：一个节点 "execution reverted"、另一个 "header not found" 同为 -32000，但只有前者是关于链的回答。
      const key = s.value.kind === 'error' ? `error:${s.value.value.code}:${revertShaped(s.value.value) ? 'revert' : ''}` : 'ok:' + canonicalJSON(s.value.value)
      const b = buckets.get(key) || { n: 0, r: s.value }; b.n++; buckets.set(key, b)
      answeredIdx.push(i)
    })
    // Counted in operators: a second URL of an operator that already answered adds no independent answer.
    // 按运营方计：已作答运营方的第二个 URL 不增加独立回答。
    const answered = operatorsOf(answeredIdx)
    // `refusals`: set only when every node that failed answered with a node-limit error (none unreachable)
    // `refusals`：仅当每个失败的节点都以节点限制错误作答（没有连不上的）时给出
    // `tooLarge`: every node that failed sent an answer over bodyLimit -- set by this client, never read from a node's words
    // `tooLarge`：每个失败的节点发来的回答都超过 bodyLimit——由本客户端标记，绝不从节点的话里推断
    // A strict read says why it needs that many; a default read's message is unchanged (GOLDEN TAP10-0)
    // 严格读取说明为何需要这么多家；默认读取的信息不变
    const strictWhy = !opts?.strict ? '' : degraded ? `; strict agreement on this allowSingleNode set needs ${needHere}`
      : `; strict agreement (TAP-10 §5.2) needs every configured node to agree, from max(2, min(3, ${operators.length} operators), quorum ${need}) = ${needHere} operators`
    if (answered < needHere) throw new TapeAPIError('RPC_UNAVAILABLE', `${method}: only ${answered}/${needHere} ${answeredIdx.length > answered ? 'operators' : 'nodes'} answered (${failures.join('; ')})${strictWhy}`, { ...(refusals.length && refusals.length === failures.length ? { refusals } : {}), ...(tooLarge && tooLarge === failures.length ? { tooLarge: true } : {}) })
    if (buckets.size > 1) throw new TapeAPIError('RPC_DISAGREE', `${method}: ${answeredIdx.length} nodes answered with ${buckets.size} different results`)
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

  async function call(method, params = [], { project, answers, strict } = {}) {
    const opts = answers || strict ? { answers, strict: strict === true } : null
    try { return await round(method, params, project, opts) }
    catch (e) {
      if (e.code !== 'RPC_DISAGREE' || disagreeRetryMs < 0) throw e
      await new Promise((r) => setTimeout(r, disagreeRetryMs))
      return round(method, params, project, opts)
    }
  }

  // eth_blockNumber is not an eth_call and honest nodes are routinely a block or two apart, so byte equality
  // would fail all the time. Take the LOWEST head among at least `need` answers (a block every answering node
  // has reached) and refuse a spread wider than maxHeadSpread, which means a stale or lying node.
  // eth_blockNumber 不是 eth_call，诚实节点常差一两个块，逐字节比较会一直失败。取至少 need 个作答中的最低块高
  // （每个作答节点都已到达），块高差超过 maxHeadSpread 视为节点落后或撒谎而拒绝。
  async function blockNumber() {
    const settled = await Promise.allSettled(urls.map(u => one(u, 'eth_blockNumber', [])))
    const heads = []; const failures = []; const answeredIdx = []
    settled.forEach((s, i) => {
      if (s.status === 'fulfilled' && s.value.kind === 'ok') {
        try { heads.push(Number(BigInt(s.value.value))); answeredIdx.push(i); return } catch { /* fall through */ }
      }
      failures.push(`${describeUrl(urls[i], i)}: ${s.status === 'rejected' ? (s.reason?.message || s.reason) : 'bad eth_blockNumber answer'}`)
    })
    const answered = operatorsOf(answeredIdx)
    if (answered < need) throw new TapeAPIError('RPC_UNAVAILABLE', `eth_blockNumber: only ${answered}/${need} ${heads.length > answered ? 'operators' : 'nodes'} answered (${failures.join('; ')})`)
    const lo = Math.min(...heads); const hi = Math.max(...heads)
    if (hi - lo > maxHeadSpread) throw new TapeAPIError('RPC_DISAGREE', `eth_blockNumber: heads span ${lo}..${hi}, more than ${maxHeadSpread} blocks apart`)
    return lo
  }

  /**
   * @experimental (security 1.1) A block that nodes of at least `need` operators confirm, for pinning every read of one
   * resolution to it. `tag` ('finalized', 'safe' or 'latest') is only where to start: "finalized" is what each NODE says
   * it is (1rpc answered latest − 5000 on BSC; four Base nodes differed by 178 blocks, measured 2026-09-29), so the tag
   * is never used for a read. Each node is asked for its block at `tag`; the candidate is the highest number that nodes
   * of `need` operators have reached (each operator counted once, at its highest answer). When those nodes already gave
   * one identical block, that is the answer (one round); otherwise every node is asked for the candidate number and all
   * that answer must report the same block (a second round, unanimous as any read, TAPI-20 §3.2). Two answers for one
   * number with different hashes are RPC_DISAGREE. Returns { number, hash, timestamp, tag, operators }; freshness is the
   * caller's check (it needs the caller's clock). A later read pinned to the block (an EIP-1898 blockHash or a hex number)
   * that a lagging node answers with "header not found" / "unknown block" / -32001 counts as that node not answering.
   * @experimental（安全加固 1.1）至少 `need` 家运营方确认的区块，用于把一次解析的全部读取钉在它上面。`tag` 只是起点：
   * "finalized" 是每个**节点**自己说的，因此标签绝不用于读取。先问每个节点它在 `tag` 处的区块；候选为 `need` 家运营方都已到达的
   * 最高块号（每家运营方只计一次、取其最高的回答）。若这些节点给出的已是同一个区块，即为结果（一轮）；否则向每个节点问候选块号，
   * 作答者必须报告同一个区块（第二轮，与任何读取一样须全体一致）。同一块号出现两个不同哈希即 RPC_DISAGREE。新鲜度由调用方检查。
   * 之后钉在该块上的读取（EIP-1898 blockHash 或十六进制块号），落后节点答 "header not found" / "unknown block" / -32001 的，
   * 按该节点未作答处理。
   * `{ stateRoot: true }` (@experimental, security 1.2 proofs): the block's stateRoot is returned when nodes of `need`
   * operators report it for the block (undefined otherwise); a node that leaves it out is not counted, and one that
   * reports another is RPC_DISAGREE (agreedRoot below). Without it, confirmedBlock is exactly 1.2.0.
   * `{ stateRoot: true }`（@experimental，安全加固 1.2 证明模式）：有 `need` 家运营方的节点对该块报出 stateRoot 时随结果返回（否则为
   * undefined）；省略的节点不计入，报出另一个的即 RPC_DISAGREE（见下面的 agreedRoot）。不传时 confirmedBlock 与 1.2.0 完全相同。
   */
  const BLOCK_TAGS = new Set(['finalized', 'safe', 'latest'])
  const blockFacts = (b) => {
    if (!b || typeof b !== 'object') throw new Error('no such block')
    const number = Number(BigInt(b.number)), timestamp = Number(BigInt(b.timestamp))
    if (typeof b.hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(b.hash) || !Number.isSafeInteger(number) || !Number.isSafeInteger(timestamp)) throw new Error('malformed block')
    return { number, hash: b.hash.toLowerCase(), timestamp }
  }
  // ...and its stateRoot, for proofs (a node that gives none, or a malformed one, gives none) / 再加 stateRoot，供证明使用
  const blockFactsWithRoot = (b) => {
    const f = blockFacts(b)
    if (typeof b.stateRoot === 'string' && /^0x[0-9a-fA-F]{64}$/.test(b.stateRoot)) f.stateRoot = b.stateRoot.toLowerCase()
    return f
  }
  async function confirmedBlock(tag = 'finalized', { stateRoot: withRoot = false } = {}) {
    if (!BLOCK_TAGS.has(tag)) throw new TapeAPIError('INVALID_ARGUMENT', `confirmedBlock takes 'finalized', 'safe' or 'latest', not ${String(tag).slice(0, 32)}`)
    const facts = withRoot ? blockFactsWithRoot : blockFacts
    const settled = await Promise.allSettled(urls.map((u) => one(u, 'eth_getBlockByNumber', [tag, false])))
    const got = []; const failures = []
    settled.forEach((s, i) => {
      if (s.status === 'fulfilled' && s.value.kind === 'ok') { try { got.push({ i, ...facts(s.value.value) }); return } catch (e) { failures.push(`${describeUrl(urls[i], i)}: ${e.message}`); return } }
      failures.push(`${describeUrl(urls[i], i)}: ${s.status === 'rejected' ? (s.reason?.message || s.reason) : `error ${s.value.value.code}`}`)
    })
    const answered = operatorsOf(got.map((g) => g.i))
    if (answered < need) throw new TapeAPIError('RPC_UNAVAILABLE', `eth_getBlockByNumber(${tag}): only ${answered}/${need} operators answered (${failures.join('; ')})`)
    const hashAt = new Map(), rootAt = new Map()
    for (const g of got) {
      const h = hashAt.get(g.number)
      if (h && h !== g.hash) throw new TapeAPIError('RPC_DISAGREE', `eth_getBlockByNumber(${tag}): nodes report two different hashes for block ${g.number}`)
      hashAt.set(g.number, g.hash)
      // One hash, two stateRoots: one node misreports the header (only asked for with { stateRoot: true }). A node that
      // gives none is not compared. / 同一哈希、两个 stateRoot：有节点谎报区块头（只在 { stateRoot: true } 时检查）；没给的不比较。
      if (withRoot && g.stateRoot) {
        if (rootAt.has(g.number) && rootAt.get(g.number) !== g.stateRoot) throw new TapeAPIError('RPC_DISAGREE', `eth_getBlockByNumber(${tag}): nodes report two different stateRoots for block ${g.number}`)
        rootAt.set(g.number, g.stateRoot)
      }
    }
    const best = new Map()   // operator -> its highest answer / 每家运营方最高的回答
    for (const g of got) { const op = opOf[g.i]; if (!best.has(op) || best.get(op).number < g.number) best.set(op, g) }
    const ranked = [...best.values()].sort((a, b) => b.number - a.number)
    const target = ranked[need - 1].number
    const top = ranked.slice(0, need)
    if (top.every((g) => g.number === target)) {
      const g = top[0]
      if (top.some((x) => x.timestamp !== g.timestamp)) throw new TapeAPIError('RPC_DISAGREE', `eth_getBlockByNumber(${tag}): nodes report two timestamps for block ${target}`)
      return { number: target, hash: g.hash, timestamp: g.timestamp, tag, operators: need, ...(withRoot ? { stateRoot: agreedRoot(got, target, g.hash, tag) } : {}) }
    }
    // A node that has not reached the block answers null: that is no answer, not a disagreement.
    // 尚未到达该块的节点答 null：那是没有作答，不是分歧。
    if (!withRoot) {
      const b = await call('eth_getBlockByNumber', ['0x' + target.toString(16), false], { project: facts })
      if (b.number !== target) throw new TapeAPIError('RPC_DISAGREE', `eth_getBlockByNumber: asked for block ${target}, nodes answered block ${b.number}`)
      return { number: b.number, hash: b.hash, timestamp: b.timestamp, tag, operators: need }
    }
    // With the stateRoot (FIXED PROOFR-5): the block itself goes through the same unanimous round as without it (number,
    // hash, timestamp; a node that leaves the stateRoot out is not a different answer), and each node's stateRoot is kept
    // on the side and settled by agreedRoot. / 带 stateRoot 时（FIXED PROOFR-5）：区块本身照旧过同样的全体一致（块号、哈希、
    // 时间戳；省略 stateRoot 的节点不算另一种回答），各节点的 stateRoot 另行记下，由 agreedRoot 裁定。
    const seen = []
    const b = await call('eth_getBlockByNumber', ['0x' + target.toString(16), false], { project: (x, i) => { const f = blockFactsWithRoot(x); seen.push({ i, ...f }); return blockFacts(x) } })
    if (b.number !== target) throw new TapeAPIError('RPC_DISAGREE', `eth_getBlockByNumber: asked for block ${target}, nodes answered block ${b.number}`)
    return { number: b.number, hash: b.hash, timestamp: b.timestamp, tag, operators: need, stateRoot: agreedRoot(seen, target, b.hash, `0x${target.toString(16)}`) }
  }
  // The stateRoot of block `number` (hash `hash`): the nodes that report one for that block must all report the same
  // (another one is RPC_DISAGREE: a node misreports the header), and it counts only when nodes of `need` operators report
  // it; a node that leaves it out (or gives a malformed one) is not counted either way. undefined when too few gave it
  // (FIXED PROOFR-5: one confirming node without a stateRoot made every proof PROOF_UNAVAILABLE on the first path, and
  // RPC_DISAGREE on the second). / 块 `number`（哈希 `hash`）的 stateRoot：对该块报了 stateRoot 的节点必须全部相同（不同即
  // RPC_DISAGREE：有节点谎报区块头），且须有 `need` 家运营方的节点报出才算数；省略（或格式错误）的节点两边都不计。报出的太少时
  // 为 undefined（FIXED PROOFR-5：原先一个确认节点不给 stateRoot，第一条路径让全部证明 PROOF_UNAVAILABLE，第二条路径则 RPC_DISAGREE）。
  function agreedRoot(answers, number, hash, what) {
    const withIt = answers.filter((g) => g.number === number && g.hash === hash && g.stateRoot)
    if (new Set(withIt.map((g) => g.stateRoot)).size > 1) throw new TapeAPIError('RPC_DISAGREE', `eth_getBlockByNumber(${what}): nodes report two different stateRoots for block ${number}`)
    return withIt.length && operatorsOf(withIt.map((g) => g.i)) >= need ? withIt[0].stateRoot : undefined
  }

  /**
   * @experimental (TAP-10 §5.3) The TAP-10 pinned block: every node is asked for its head (eth_blockNumber); once heads
   * from Q = min(2, operators) operators are in, the others get at most `graceMs` (1.5 s) more. Each operator counts once,
   * at the LOWEST head its nodes reported; the pinned block is the Q-th highest operator head minus 2, and its pin lag the
   * highest operator head minus the pinned block. A lag above `maxLag` (TAP-10 §2.1: BSC 400, Base 150, X Layer 300) is
   * RPC_STALE with data.status 'stale-block': block numbers only, no clock. Then, as confirmedBlock does, every node is
   * asked for that block by number and all that answer must report the same block (hash and timestamp), from nodes of
   * `quorum` operators, so the reads can pin to its hash (EIP-1898), which is stronger than pinning to a number.
   * blockNumber() is not used: its maxHeadSpread (64) refuses heads TAP-10 accepts on an L2.
   * `{ stateRoot: true }` also returns the agreed stateRoot (proofs), as confirmedBlock does.
   * @experimental（TAP-10 §5.3）TAP-10 钉块：向每个节点要头块；Q = min(2, 运营方数) 家的头块到齐后，其余的至多再等 `graceMs`
   * （1.5 秒）。每家运营方只计一次，取其节点报告的**最低**头块；钉块为第 Q 高的运营方头块减 2，钉块滞后为最高运营方头块减钉块。
   * 滞后超过 `maxLag` 即 RPC_STALE、data.status 为 'stale-block'：只看块号，不看时钟。然后像 confirmedBlock 那样按块号向每个节点
   * 取该块，作答者须报告同一个区块（哈希与时间戳），且来自 quorum 家运营方，读取因此可以钉在它的哈希上（EIP-1898），比按块号更强。
   * 不用 blockNumber()：它的 maxHeadSpread（64）会拒绝 TAP-10 在 L2 上接受的头块差。
   */
  async function tap10Block({ maxLag, stateRoot: withRoot = false, graceMs = 1500 } = {}) {
    if (!Number.isSafeInteger(maxLag) || maxLag < 0) throw new TapeAPIError('INVALID_ARGUMENT', 'tap10Block: maxLag must be a whole number of blocks')
    const Q = Math.min(2, operators.length)
    const lowest = new Map()   // operator -> its lowest head / 每家运营方最低的头块
    const failures = []
    await new Promise((resolve) => {
      let pending = urls.length, timer = null, closed = false
      const close = () => { if (closed) return; closed = true; if (timer) clearTimeout(timer); resolve() }
      urls.forEach((u, i) => {
        one(u, 'eth_blockNumber', []).then((a) => {
          if (a.kind !== 'ok') throw new Error(`error ${a.value.code}: ${String(a.value.message).slice(0, 80)}`)
          const n = Number(BigInt(a.value))
          if (!Number.isSafeInteger(n) || n < 0) throw new Error('bad eth_blockNumber answer')
          if (closed) return
          const op = opOf[i]
          if (!lowest.has(op) || lowest.get(op) > n) lowest.set(op, n)
        }).catch((e) => { failures.push(`${describeUrl(u, i)}: ${e?.message || e}`) }).finally(() => {
          pending--
          if (pending === 0) return close()
          if (!closed && !timer && lowest.size >= Q) timer = setTimeout(close, graceMs)
        })
      })
    })
    if (lowest.size < Q) throw new TapeAPIError('RPC_UNAVAILABLE', `eth_blockNumber: only ${lowest.size}/${Q} operators answered (${failures.join('; ')})`, { data: { status: 'unavailable' } })
    const heads = [...lowest.values()].sort((a, b) => b - a)
    const number = heads[Q - 1] - 2
    const lag = heads[0] - number
    const headsByOperator = Object.fromEntries(lowest)
    if (number < 0) throw new TapeAPIError('RPC_UNAVAILABLE', `eth_blockNumber: heads ${heads.join(', ')} leave no block to pin`, { data: { status: 'unavailable' } })
    if (lag > maxLag) throw new TapeAPIError('RPC_STALE', `stale-block: the pinned block ${number} is ${lag} blocks behind the highest head an operator reports (${heads[0]}), more than ${maxLag} (TAP-10 §5.3)`, { data: { status: 'stale-block', block: number, lag, maxLag, heads: headsByOperator } })
    const hex = '0x' + number.toString(16)
    const facts = withRoot ? blockFactsWithRoot : blockFacts
    const seen = []
    const b = await call('eth_getBlockByNumber', [hex, false], { answers: 'tap10', project: (x, i) => { const f = facts(x); seen.push({ i, ...f }); return blockFacts(x) } })
    if (b.number !== number) throw new TapeAPIError('RPC_DISAGREE', `eth_getBlockByNumber: asked for block ${number}, nodes answered block ${b.number}`)
    return { number, hash: b.hash, timestamp: b.timestamp, tag: 'tap10', lag, maxLag, heads: headsByOperator, operators: need, ...(withRoot ? { stateRoot: agreedRoot(seen, number, b.hash, hex) } : {}) }
  }

  // `block`: a tag, a hex number, or an EIP-1898 object ({ blockHash, requireCanonical } or { blockNumber })
  // `block`：标签、十六进制块号，或 EIP-1898 对象
  // `opts` (@experimental): { answers: 'tap10', strict } as for call() / 与 call() 相同
  async function ethCall(to, data, block = 'latest', opts) { return opts ? call('eth_call', [{ to, data }, block], opts) : call('eth_call', [{ to, data }, block]) }
  async function chainId() { return Number(BigInt(await call('eth_chainId', []))) }
  // A client for ONE node, with this client's fetch and timeout. Data that authenticates itself (a TAPI-26 frame,
  // a payload whose digest is on chain) needs no agreement: one honest node is enough, and asking every node to
  // agree only makes such a read fail whenever any node is unavailable or refuses the method (TAPI-26 §3.7).
  // 单节点客户端。自带认证的数据（TAPI-26 帧、摘要在链上的载荷）不需要一致：一个诚实节点就够；要求全体一致
  // 反而会让这种读取在任一节点不可用或拒绝该方法时失败。
  // `o.bodyLimit` raises the answer size for one kind of read (a whole block's receipts, TAPI-26 §3.7) / 为某类读取放宽回答大小
  const single = (url, o = {}) => {
    if (!urls.includes(url)) throw new TapeAPIError('INVALID_ARGUMENT', `${describeUrl(url, 0)} is not one of this client's nodes`)
    return createRpc({ urls: [url], quorum: 1, timeoutMs, fetch: fetchImpl, bodyLimit: o.bodyLimit ?? bodyLimit, disagreeRetryMs, maxHeadSpread, transportRetryMs })
  }
  // `operators`: the distinct operators behind `urls`, in first-seen order / `urls` 背后的不同运营方
  return { call, ethCall, blockNumber, confirmedBlock, tap10Block, chainId, urls, operators, quorum: need, degraded, single, bodyLimit }
}
