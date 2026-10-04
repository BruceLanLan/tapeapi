#!/usr/bin/env node
// tapeapi-verify: a local verifying proxy for AI clients that cannot read usage receipts themselves (Claude Code, Codex,
// any tool with a base-URL setting). Point ANTHROPIC_BASE_URL / OPENAI_BASE_URL at it; it forwards every request to the
// TapeAPI AI service it was started for (resolved on chain from its TapeOut name, the delegation checked), passes the
// bytes both ways unchanged, and checks each answer's signed usage receipt against the resolved manifest (signer, price
// table) and the exact bytes sent and received. One verdict line per call on stderr; --log appends the receipts as JSON
// lines; --strict turns a receipt that fails into an error the client sees.
// tapeapi-verify：本地核验代理，给自己读不到用量回执的 AI 客户端用（Claude Code、Codex、任何能设 base URL 的工具）。把
// ANTHROPIC_BASE_URL / OPENAI_BASE_URL 指向它；它把每个请求转给启动时指定的 TapeAPI AI 服务（按 TapeOut 名字在链上解析并核对
// 委托），双向字节原样不变，并按解析到的清单（signer、价目表）与确切的收发字节核验每个回答的签名用量回执。每次调用在 stderr
// 打一行结论；--log 把回执按 JSON 行追加到文件；--strict 让核验失败变成客户端看得到的错误。
//
//   npx -y --package=<release tgz> tapeapi-verify 11.1013.tape
//   ANTHROPIC_BASE_URL=http://127.0.0.1:8790 claude          OPENAI_BASE_URL=http://127.0.0.1:8790/v1 codex
//
// Strict mode and streams: a stream's receipt comes right before its final event (message_stop, response.completed,
// [DONE]) and covers it. A stream ends at its final event, at [DONE] or when the upstream closes, whichever comes first;
// in strict mode the chunk in which it ends is held until a receipt that came before the end verifies, and released at
// once. If none does, the end is never delivered and a format-shaped error event is sent instead.
// 严格模式与流：流的回执紧挨在最终事件之前并覆盖它。流在最终事件、[DONE] 或上游关闭时结束（先到者为准）；严格模式下，流在其中
// 结束的那一块被扣住，直到结束之前到达的回执核验通过，随即放出；都不通过则结束永不送达，改发一个该格式的错误事件。
//
// Salt: on a metered path, a JSON request body gets 64 random whitespace characters appended before it is forwarded
// (ai.saltRequestBody), so the request hash in the receipt cannot be confirmed by hashing guessed prompts. The upstream
// parses the same request (no field changes, no extra token, prompt caching unaffected); compressed bodies are sent as
// they are; --no-salt turns it off. The receipt is checked against the bytes actually sent.
// 加盐：在计量路径上，JSON 请求正文转发前在末尾追加 64 个随机空白字符，回执里的请求哈希因此无法靠对猜测的提示词取哈希来确认。
// 上游解析出的请求不变（不改字段、不增加 token、不影响提示词缓存）；压缩过的正文原样发送；--no-salt 关闭。回执按实际发出的字节核验。
//
// --request-usage (1.6, off by default; the same rule as createVerifyingFetch({ requestUsage: true })): a request the
// sidecar would change to obtain the usage (a stream OpenAI Chat request without stream_options.include_usage) is
// forwarded with that member set in its bytes (ai.requestUsageBody: one splice, checked against the sidecar's own
// change), before the salt. The sidecar then injects and strips nothing, the client receives the usage chunk (one more
// chunk, `choices: []`) inside the signed stream, and the receipt's usage is compared with it. A body that cannot be
// changed that way: --strict answers HTTP 400 (usage_request_skipped) without forwarding it; otherwise it is forwarded as
// it is and the verdict says usage-request-skipped. Only OpenAI Chat clients are concerned: Claude Code (Anthropic
// Messages) and Codex (Responses) streams carry their usage already.
// --request-usage（默认关，与 createVerifyingFetch({ requestUsage: true }) 同一规则）：旁路本会为拿到用量而改动的请求（没设
// stream_options.include_usage 的流式 OpenAI Chat 请求），在加盐之前于字节里设好该成员再转发。旁路随之不注入、不剥离，客户端在被签名的
// 流里收到用量块（多一个 choices: [] 的块），回执的用量与之比对。不能这样改写的正文：--strict 回 HTTP 400（usage_request_skipped）且不转发；
// 否则原样转发，结论行注明 usage-request-skipped。只与 OpenAI Chat 客户端有关：Claude Code 与 Codex 的流本来就带用量。

import http from 'node:http'
import { appendFileSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createTapeAPI, rpcUrlsFor, operatorOf, parseTapeName, CHAINS, chainByKey } from '../src/index.js'
import * as ai from '../src/ai.js'

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const DEFAULT_RPC = rpcUrlsFor(56)
const DEFAULT_PORT = 8790
const REQUEST_LIMIT = 64 * 1024 * 1024
const RESPONSE_LIMIT = 64 * 1024 * 1024
const THREAD_LIMIT = 8 * 1024 * 1024   // `task`: the size of a thread.json
// A TapeOut name on any supported chain, canonical form (11.1013.tape; 1.2.344.tape on X Layer) / 任一已支持链上的规范名字
const isTapeName = (s) => { const p = parseTapeName(s); return !!p && !p.error }
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
// Request headers are forwarded by the same rule as the sidecar's (ai.forwardsHeader): content-type, accept, the client's
// identity and session headers and each format's own; never cookies, forwarding headers, hop-by-hop headers or
// accept-encoding (the bytes must arrive as signed). / 请求头按与旁路相同的规则转发（ai.forwardsHeader）。
// Response headers not passed back: those that describe the transfer rather than the body (fetch has decoded it).
// 不回传的响应头：描述传输而非正文的头（fetch 已解码）。
const DROP_RESPONSE = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-length', 'content-encoding', 'trailer', 'upgrade'])

const log = (...a) => console.error('[tapeapi-verify]', ...a)
// What is logged about the shapes of a stream that no receipt covers (FIXED SSE-END, SSE-EOF, SSE-BOM; the same words as
// ai.createVerifyingFetch). / 对不受任何回执覆盖的流形态的记录（与 ai.createVerifyingFetch 措辞相同）。
const LATE_EVENT = 'an event after the end of the stream is not covered by its receipt'
const UNFINISHED_EVENT = 'an unfinished event at the close of the stream (no blank line after it) is not covered by its receipt, and some clients dispatch it'
const AMBIGUOUS_LINE = 'a line that starts with U+FEFF (a byte order mark) is read differently by different clients: the stream cannot be verified'
const NO_USAGE_ASKED = 'the request asked for the usage (requestUsage), but the stream carries none: the upstream did not send it, or something on the way took it out'

const USAGE = `tapeapi-verify ${VERSION}: a local proxy that verifies the signed usage receipt of every AI call.

Usage: tapeapi-verify [options] <service>

  <service>            the AI service: a TapeOut name (11.1013.tape; on X Layer or Base with its area code, 1.2.344.tape)
                       or a container address on BNB Smart Chain (0x...)
  --port <n>           local port (default ${DEFAULT_PORT}; 0 = any free port)
  --host <addr>        local address (default 127.0.0.1)
  --log <file>         append one JSON line per verified call (verdict and signed receipt; no prompts, no keys)
  --strict             a receipt that does not verify becomes an error to the client (HTTP 502, or an error
                       event in place of a stream's final event)
  --max-skew <s>       a receipt's time must be within this many seconds of now (default 300)
  --no-salt            send request bodies exactly as the client wrote them (default: 64 random whitespace
                       characters are appended to a JSON body, so the request hash cannot be guessed)
  --strip-session-headers
                       do not pass the client's session headers (x-claude-code-session-id, session-id,
                       thread-id) to the service; they let it tie your requests into one session
  --request-usage      ask for the usage of a streamed OpenAI Chat request that does not ask for it
                       (stream_options.include_usage, set in the request's bytes), so the receipt's usage
                       is checked against the stream; the client then sees one more chunk, choices: [].
                       A body that cannot be changed that way: refused with --strict, else sent as is
                       替未要用量的流式 OpenAI Chat 请求在字节里要用量，回执的用量因此可与流比对；客户端会多收到
                       一个 choices: [] 的块。无法这样改写的正文：--strict 时拒绝，否则原样发送
  --rpc <url,url,...>  BNB Chain nodes; each chain read needs 2 to agree (default: ${DEFAULT_RPC.length} public nodes of distinct operators)
  --rpc-xlayer <urls>  X Layer nodes, for a name with area code 2 (default: ${rpcUrlsFor(196).length} public nodes of 2 operators, no spare)
  --rpc-base <urls>    Base nodes, for a name with area code 3 (default: ${rpcUrlsFor(8453).length} public nodes of distinct operators)
  --dev <url>          TESTING ONLY: read the manifest from a local sidecar, no on-chain identity check
  --quiet              no line for calls that carry no receipt (models, count_tokens, ...)
  --version, --help

Exit status: 0 normal exit, 1 a runtime failure (the service cannot be resolved, the port cannot be opened), 2 a
usage mistake (an unknown option, no service, --rpc with fewer than 2 operators). No environment variable is read.

Then point your client at it:
  Claude Code   ANTHROPIC_BASE_URL=http://127.0.0.1:${DEFAULT_PORT}
  Codex         [model_providers.x] base_url = "http://127.0.0.1:${DEFAULT_PORT}/v1", wire_api = "responses"
  OpenAI SDKs   OPENAI_BASE_URL=http://127.0.0.1:${DEFAULT_PORT}/v1

Your API key goes to the service as it would without this proxy; nothing else sees it. A receipt proves who answered,
to exactly which request, with exactly which response, and what usage and price were claimed; it does not prove which
model actually ran. A receipt carries hashes of the request and the answer, not their text, and so does the --log
file; a receipt passed on together with the request or answer bytes (to check the hashes on the verification page),
or a verification link made with its content, contains that conversation.
`

function parseArgs(argv) {
  const o = { target: null, dev: null, rpc: null, chainRpc: {}, port: DEFAULT_PORT, host: '127.0.0.1', log: null, strict: false, maxSkew: 300, quiet: false, salt: true, stripSession: false, requestUsage: false }
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i], v
    const eq = a.startsWith('--') ? a.indexOf('=') : -1
    if (eq > 0) { v = a.slice(eq + 1); a = a.slice(0, eq) }
    const value = () => {
      if (v !== undefined) return v
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`)
      return argv[++i]
    }
    switch (a) {
      case '--help': case '-h': o.help = true; break
      case '--version': case '-v': o.version = true; break
      case '--port': o.port = Number(value()); if (!Number.isInteger(o.port) || o.port < 0 || o.port > 65535) throw new Error('--port must be 0 to 65535'); break
      case '--host': o.host = value(); break
      case '--log': o.log = value(); break
      case '--strict': o.strict = true; break
      case '--quiet': o.quiet = true; break
      case '--no-salt': o.salt = false; break
      case '--strip-session-headers': o.stripSession = true; break
      case '--request-usage': o.requestUsage = true; break
      case '--max-skew': o.maxSkew = Number(value()); if (!Number.isFinite(o.maxSkew) || o.maxSkew <= 0) throw new Error('--max-skew must be a positive number of seconds'); break
      case '--rpc': o.rpc = value().split(',').map((s) => s.trim()).filter(Boolean); break
      case '--rpc-xlayer': case '--rpc-base': o.chainRpc[chainByKey(a.slice(6)).chainId] = value().split(',').map((s) => s.trim()).filter(Boolean); break
      // TESTING ONLY: a local sidecar's manifest over http, no on-chain identity check. / 仅供测试。
      case '--dev': o.dev = value(); break
      default:
        if (a.startsWith('-')) throw new Error(`unknown option ${a}`)
        if (o.target) throw new Error('name one service')
        o.target = a
    }
  }
  if (o.target && o.dev) throw new Error('name a service or --dev, not both')
  if (o.target && !isTapeName(o.target) && !ADDRESS_RE.test(o.target)) throw new Error(`${o.target} is not a TapeOut name (11.1013.tape, 1.2.344.tape) or a container address`)
  return o
}

// ---------------------------------------------------------------------------------------------------------------
// Routing: a request path -> the service endpoint it goes to / 路由：请求路径 -> 它去往的服务端点
// ---------------------------------------------------------------------------------------------------------------
/**
 * The service roots of the manifest's AI endpoints, with their adapters. A local path goes to the endpoint whose format
 * matches it; any other path (models, count_tokens) to the Anthropic endpoint when the request speaks Anthropic
 * (anthropic-version), else to the first OpenAI-style endpoint, else the first.
 * 清单 AI 端点的服务根及其适配器。本地路径去往格式认得它的端点；其他路径（models、count_tokens）在请求说 Anthropic
 * （带 anthropic-version）时去 Anthropic 端点，否则去第一个 OpenAI 风格端点，再否则去第一个端点。
 */
export function routesOf(manifest, formats = ai.FORMATS) {
  const eps = manifest?.[ai.MANIFEST_FIELD]?.endpoints
  if (!Array.isArray(eps) || !eps.length) throw new Error(`the service publishes no ${ai.MANIFEST_FIELD} endpoints`)
  const routes = []
  for (const ep of eps) {
    const format = formats.find((f) => f.name === ep?.format)
    const root = format && ai.rootOf(ep.baseUrl, format)
    if (root) routes.push({ format, root: root.replace(/\/+$/, '') })
  }
  if (!routes.length) throw new Error(`none of the service's ${ai.MANIFEST_FIELD} endpoints has a format this version knows (${eps.map((e) => e?.format).join(', ')})`)
  return routes
}
export function route(routes, verb, path, headers) {
  const hit = routes.find((r) => r.format.match({ verb, path }))
  if (hit) return { ...hit, metered: true }
  // A metered path written loosely ('//', '%6D', a trailing '/'), which OpenAI and Anthropic still serve: `loose` names
  // the path it stands for (review P2-O1). / 计量路径的宽松写法（真实上游照样回答）：loose 给出它所指的路径。
  const lp = ai.loosePath(path)
  const loose = routes.find((r) => r.format.match({ verb, path: lp }))
  if (loose) return { ...loose, metered: false, loose: lp }
  const anthropic = headers.has('anthropic-version') ? routes.find((r) => r.format.name === 'anthropic-messages') : null
  return { ...(anthropic || routes.find((r) => r.format.baseSuffix === '/v1') || routes[0]), metered: false }
}

// Errors in the shape the client's format reads. / 按客户端格式可读的错误形状。
const anthropicLike = (r, headers) => r.format.name === 'anthropic-messages' || headers.has('anthropic-version')
function errorBody(anthropic, code, message) {
  return anthropic ? { type: 'error', error: { type: 'api_error', message: `tapeapi-verify: ${message}` } } : { error: { message: `tapeapi-verify: ${message}`, type: 'tapeapi_verify_error', param: null, code } }
}
// In place of a stream's final event: the event each format's clients treat as a failed answer (Anthropic `error`;
// Responses `response.failed`, which Codex reports, where it ignores a bare `error` event and retries).
// 代替流的最终事件：各格式客户端视为失败回答的事件（Anthropic 的 error；Responses 的 response.failed，Codex 会报告它，
// 而对单独的 error 事件视而不见并重试）。
function streamErrorEvent(format, message, id) {
  const text = `tapeapi-verify: ${message}`
  if (format.name === 'anthropic-messages') return `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: text } })}\n\n`
  if (format.name === 'openai-responses') return `event: response.failed\ndata: ${JSON.stringify({ type: 'response.failed', response: { id: id ?? 'tapeapi-verify', object: 'response', status: 'failed', error: { code: 'receipt_invalid', message: text }, output: [], usage: null } })}\n\n`
  return `data: ${JSON.stringify({ error: { message: text, type: 'tapeapi_verify_error', param: null, code: 'receipt_invalid' } })}\n\n`
}

async function readAll(stream, limit) {
  const parts = []; let n = 0
  for await (const c of stream) {
    n += c.length
    if (n > limit) throw Object.assign(new Error(`larger than ${limit} bytes`), { tooLarge: true })
    parts.push(c)
  }
  return new Uint8Array(Buffer.concat(parts))
}

const short = (s, n = 80) => String(s ?? '').slice(0, n)
function verdictLine(rep) {
  const r = rep.receipt?.result
  const u = r?.usage
  const bits = [rep.ok ? 'OK  ' : 'FAIL', `${rep.method} ${rep.path}`, rep.stream ? 'stream' : 'json', String(rep.status)]
  // Only with --request-usage. / 只在 --request-usage 时。
  if (rep.usageRequested) bits.push('usage=asked')
  if (rep.usageRequestSkipped) bits.push(`usage-request-skipped=${rep.usageRequestSkipped}`)
  if (r) bits.push(`model=${short(r.model ?? 'null', 60)}`, u ? `tokens in=${u.prompt_tokens} out=${u.completion_tokens}${u.cache_read_tokens ? ` cache_read=${u.cache_read_tokens}` : ''}${u.cache_write_tokens ? ` cache_write=${u.cache_write_tokens}` : ''}${u.cache_write_1h_tokens ? ` (1h ${u.cache_write_1h_tokens})` : ''}` : 'usage=null', r.prices ? `price=${r.prices.map((p) => `${p.amount} ${p.currency}`).join(' / ')}${r.modelMatchedBy === 'request' ? ' (model from the request)' : ''}` : 'price=null', ...(r.complete ? [] : ['INCOMPLETE']), `id=${short(rep.receipt.id, 48)}`)
  if (rep.problems.length) bits.push(`problems: ${rep.problems.join('; ')}`)
  if (rep.warnings.length) bits.push(`warnings: ${rep.warnings.join('; ')}`)
  return bits.join('  ')
}

async function main() {
  // `task` (experimental, 1.7) is taken first and only as the very first word; everything else below is as it was in 1.6
  if (process.argv[2] === 'task') { process.exitCode = await taskMain(process.argv.slice(3)); return }
  let opts
  try { opts = parseArgs(process.argv.slice(2)) } catch (e) { process.stderr.write(`tapeapi-verify: ${e.message}\n\n${USAGE}`); process.exit(2) }
  if (opts.help) { process.stdout.write(USAGE + TASK_USAGE); return }
  if (opts.version) { process.stdout.write(`${VERSION}\n`); return }
  if (!opts.target && !opts.dev) { process.stderr.write(`tapeapi-verify: name the AI service\n\n${USAGE}`); process.exit(2) }
  if (opts.dev) {
    log('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!')
    log('!! --dev is for TESTING ONLY: the service identity is NOT checked on chain.          !!')
    log('!! Receipts are checked against the signer the local manifest names, nothing more.    !!')
    log('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!')
  }
  const rpcUrls = opts.rpc ?? (opts.target ? DEFAULT_RPC : null)
  if (rpcUrls && new Set(rpcUrls.map(operatorOf)).size < 2) { process.stderr.write('tapeapi-verify: --rpc needs nodes of at least 2 independent operators (every chain read must be agreed by 2)\n'); process.exit(2) }
  for (const [id, urls] of Object.entries(opts.chainRpc)) {
    if (new Set(urls.map(operatorOf)).size < 2) { process.stderr.write(`tapeapi-verify: --rpc-${CHAINS[id].key} needs nodes of at least 2 independent operators\n`); process.exit(2) }
  }
  // A name on X Layer or Base is read there (--rpc-xlayer / --rpc-base, or the SDK's defaults for that chain).
  // X Layer 或 Base 上的名字在那条链上读取。
  const chains = Object.fromEntries(Object.entries(opts.chainRpc).map(([id, urls]) => [id, { rpcUrls: urls }]))
  const api = createTapeAPI({ ...(rpcUrls ? { rpcUrls, quorum: 2 } : {}), ...(opts.dev ? { dev: true } : {}), chains })
  let svc, routes
  try {
    svc = await api.resolve(opts.dev ? { dev: opts.dev } : opts.target)
    // resolve() validated the field (TAPI-20 §3.9) and dropped it when invalid. / resolve() 已校验该字段，无效则已丢弃。
    if (svc.aiProblems) throw new Error(`its ${ai.MANIFEST_FIELD} field is invalid: ${svc.aiProblems.join('; ')}`)
    routes = routesOf(svc.manifest)
  } catch (e) {
    process.stderr.write(`tapeapi-verify: cannot use ${opts.dev ?? opts.target}: ${e.message}\n`)
    // The operator of that service, or someone trying a documentation example (42.1013.tape is one), needs the next step.
    // 该服务的运营者，或照着文档示例（42.1013.tape 就是示例名）试的人，需要知道下一步。
    if (opts.target) process.stderr.write(`  Your own service? tapeapi-doctor checks it step by step and says what is missing: node sdk/bin/tapeapi-doctor.js ${opts.target} (in a checkout of https://github.com/BruceLanLan/tapeapi)\n  No service yet? See it work locally first: node examples/relay-trial/trial.mjs\n  是你自己的服务？tapeapi-doctor 逐项检查并说明缺什么：node sdk/bin/tapeapi-doctor.js ${opts.target}（在上面仓库的检出里）；还没有服务？先跑本地试跑：node examples/relay-trial/trial.mjs\n`)
    process.exit(1)
  }
  if (!svc.verified || (svc.verified.delegation !== true && svc.verified.dev !== true)) { process.stderr.write('tapeapi-verify: the service delegation did not verify\n'); process.exit(1) }

  const stats = { calls: 0, ok: 0, failed: 0, passThrough: 0, sidecarErrors: 0 }
  const writeLog = (rep) => {
    if (!opts.log) return
    const line = { ts: new Date().toISOString(), method: rep.method, path: rep.path, status: rep.status, stream: rep.stream, format: rep.format, ok: rep.ok, ...(rep.sidecarError ? { sidecarError: true, code: rep.code } : {}), ...(rep.usageRequested !== undefined ? { usageRequested: rep.usageRequested } : {}), ...(rep.usageRequestSkipped ? { usageRequestSkipped: rep.usageRequestSkipped } : {}), problems: rep.problems, warnings: rep.warnings, unchecked: rep.unchecked, receipt: rep.receipt }
    try { appendFileSync(opts.log, JSON.stringify(line) + '\n', { mode: 0o600 }) } catch (e) { log(`cannot write ${opts.log}: ${e.message}`) }
  }
  // Check one receipt; once more after re-reading the manifest when another key signed it (the service may have
  // rotated). / 核验一份回执；换了签名密钥时重读清单后再核一次（服务可能换了钥）。
  async function check(args) {
    const run = () => ai.verifyUsageReceipt({ ...args, manifest: svc.manifest, maxSkewS: opts.maxSkew })
    let r = run()
    if (!r.ok && !svc.verified?.dev && r.problems.some((p) => p.startsWith('signed by '))) {
      try { await api.refresh(svc); routes = routesOf(svc.manifest); r = run() } catch { /* keep the first verdict / 保留第一次的结论 */ }
    }
    return r
  }
  function report(rep) {
    if (rep.sidecarError) { stats.sidecarErrors++; log(`ERR   ${rep.method} ${rep.path}  ${rep.status}  sidecar error (${rep.code}): ${rep.problems.join('; ')}`) }
    else { if (rep.ok) stats.ok++; else stats.failed++; log(verdictLine(rep)) }
    writeLog(rep)
  }

  const server = http.createServer(async (req, res) => {
    const ac = new AbortController()
    res.on('close', () => { if (!res.writableEnded) ac.abort() })
    const sendError = (status, anthropic, code, message, extra = {}) => {
      if (res.headersSent) return res.destroy()
      res.writeHead(status, { 'content-type': 'application/json', 'x-should-retry': 'false', ...extra })
      res.end(JSON.stringify(errorBody(anthropic, code, message)))
    }
    let url
    // Joined, not resolved: a path that starts with '//' stays a path. / 拼接而非解析：以 '//' 开头的路径仍是路径。
    try { url = new URL('http://local' + req.url) } catch { return sendError(400, false, 'bad_request', 'bad request URL') }
    const headers = new Headers()
    for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i].toLowerCase()
      if (!ai.forwardsHeader(k) || (opts.stripSession && ai.isSessionHeader(k))) continue
      try { headers.append(k, req.rawHeaders[i + 1]) } catch { /* not a fetch header */ }
    }
    const verb = req.method.toUpperCase()
    const r = route(routes, verb, url.pathname, headers)
    const anthropic = anthropicLike(r, headers)
    stats.calls++
    if (r.loose) {
      const why = `${verb} ${url.pathname} is a metered ${r.format.name} path written loosely; it must be written exactly as ${r.loose}, the only path whose receipt is checked`
      if (opts.strict) { stats.failed++; log(`FAIL ${why}`); return sendError(400, anthropic, 'bad_path', why) }
      log(`FAIL ${why}: passed on, not verified`)
    }
    let body
    try { body = verb === 'GET' || verb === 'HEAD' ? null : await readAll(req, REQUEST_LIMIT) } catch (e) {
      return sendError(e.tooLarge ? 413 : 400, anthropic, 'bad_request', e.tooLarge ? `the request is larger than ${REQUEST_LIMIT} bytes` : 'the request body could not be read')
    }
    // --request-usage: the member is set in the bytes before the salt; `asked` goes into every verdict of this call and
    // only exists when the option is on. / 在加盐之前于字节里设好成员；asked 只在开启时存在，并入本次调用的每个结论。
    let asked = null
    if (r.metered && opts.requestUsage) {
      const u = body && body.length ? ai.requestUsageBody(body, { format: r.format, headers }) : null
      asked = { usageRequested: !!u?.bytes }
      if (u?.bytes) body = u.bytes
      else if (u?.skipped) {
        const why = `requestUsage: the usage of this ${r.format.name} request cannot be asked for in its bytes (${u.skipped}: ${ai.usageRequestSkipWhy(u.skipped)}), so the sidecar would ask for it itself and its usage could not be checked`
        if (opts.strict) { stats.failed++; log(`FAIL ${verb} ${url.pathname}: ${why}; not forwarded (--strict)`); return sendError(400, anthropic, 'usage_request_skipped', `${why}; send the body as a UTF-8 JSON object without such keys, or run without --request-usage or --strict`) }
        asked.usageRequestSkipped = u.skipped
      }
    }
    // The salt goes on the bytes forwarded, and the receipt is checked over exactly those. / 盐加在转发的字节上，回执按这些字节核验。
    if (r.metered && opts.salt && body && body.length) { const more = ai.saltRequestBody(body, headers); if (more) body = more }
    const target = r.root + url.pathname + url.search
    let up
    try { up = await fetch(target, { method: verb, headers, body: body && body.length ? body : verb === 'POST' ? body : undefined, redirect: 'manual', signal: ac.signal }) } catch (e) {
      log(`FAIL ${verb} ${url.pathname}: the service could not be reached (${e?.cause?.message || e?.message || e})`)
      return sendError(502, anthropic, 'service_unreachable', `the service at ${new URL(r.root).host} could not be reached`)
    }
    const out = {}
    for (const [k, v] of up.headers) if (!DROP_RESPONSE.has(k)) out[k] = k in out ? `${out[k]}, ${v}` : v
    const nullBody = verb === 'HEAD' || [101, 204, 205, 304].includes(up.status) || !up.body
    if (!r.metered) {
      stats.passThrough++
      if (!opts.quiet) log(`--    ${verb} ${url.pathname} ${up.status} (no receipt: not a metered path)`)
      res.writeHead(up.status, out)
      if (nullBody) return res.end()
      try { for await (const c of up.body) res.write(c) } catch { return res.destroy() }
      return res.end()
    }
    const format = r.format
    const common = { requestBytes: body ?? new Uint8Array(0), path: url.pathname, status: up.status }
    const base = { method: verb, path: url.pathname, status: up.status, format: format.name, ...asked }
    const stream = !!format.stream && (up.headers.get('content-type') || '').toLowerCase().includes('text/event-stream') && !nullBody
    if (!stream) {
      let bytes
      try { bytes = nullBody ? new Uint8Array(0) : await readAll(up.body, RESPONSE_LIMIT) } catch (e) {
        return sendError(502, anthropic, 'bad_response', e.tooLarge ? `the answer is larger than ${RESPONSE_LIMIT} bytes` : 'the answer could not be read')
      }
      // An answer the sidecar made itself: no upstream answer and no receipt, a transport failure passed on as it is.
      // 旁路自己产生的回答：没有上游回答也没有回执，是传输失败，原样转交。
      if (up.headers.get(ai.SIDECAR_ERROR_HEADER) === '1' && !up.headers.get(ai.RECEIPT_HEADER)) {
        let why = ''
        try { why = String(JSON.parse(new TextDecoder().decode(bytes))?.error?.message ?? '').slice(0, 200) } catch { /* not JSON */ }
        report({ ...base, ok: false, sidecarError: true, code: up.status === 429 ? 'RATE_LIMITED' : 'PROVIDER_UNAVAILABLE', problems: [`the sidecar answered HTTP ${up.status} itself${why ? ` (${why})` : ''}: no upstream answer, no receipt`], warnings: [], unchecked: ['request', 'response'], receipt: null, stream: false })
        res.writeHead(up.status, out)
        return res.end(bytes)
      }
      let envelope = null, headerError = null
      try { envelope = ai.decodeReceiptHeader(up.headers.get(ai.RECEIPT_HEADER)) } catch (e) { headerError = e.message }
      const v = await check({ ...common, envelope, responseBytes: bytes, stream: false })
      if (!envelope) v.problems.splice(0, v.problems.length, headerError === 'no receipt' ? `no ${ai.RECEIPT_HEADER} header` : headerError)
      const rep = { ...base, ...v, stream: false }
      report(rep)
      if (!rep.ok && opts.strict) return sendError(502, anthropic, 'receipt_invalid', `the usage receipt did not verify: ${rep.problems.join('; ')}`)
      res.writeHead(up.status, out)
      return res.end(bytes)
    }
    // A stream: passed on as it arrives. It ends at the format's final event, at its sentinel ([DONE]) or when the upstream
    // closes, whichever comes first (the openai SDKs stop reading at [DONE]); what is checked there is the stream as it
    // stood at that point, whatever else came in the same chunk (FIXED SSE-END). Strict: only whole events are passed on
    // (the bytes after a chunk's last blank line wait for the rest of their event), and the event that ends the stream
    // waits until a receipt that came before it verifies; then the stream goes on up to its end only and the answer ends
    // there, so nothing after the end reaches the client however the bytes were cut. With no receipt that verifies, a
    // format-shaped error event is sent in its place, and the client never holds half an event that the error could
    // complete (review G1 M14, RC-2). The same error ends a stream with a line that starts with U+FEFF (clients disagree on
    // it; FIXED SSE-BOM) and one whose upstream closes, before its end, on an event left without its blank line (the
    // receipt rule discards it, the openai SDK dispatches it; FIXED SSE-EOF). Not strict: nothing is held or cut; the
    // receipts that came before the end are checked and logged as soon as it is passed on (with none, when the upstream
    // closes), also when the client hangs up there (FIXED SSE-LOG), and an event after the end, an unfinished event at the
    // close and a line that starts with U+FEFF are each logged once as a failure. The upstream breaking off after the end
    // is not a failure (review RC-4).
    // 流：到达即转交。流在格式的最终事件、sentinel（[DONE]）或上游关闭时结束（先到者为准；openai SDK 读到 [DONE] 就停止）；在那里
    // 核验的是流在那一点的样子，与同一块里还有什么无关。严格模式：只转交完整的事件（块中最后一个空行之后的字节等待其事件的其余部分），
    // 结束流的那个事件要等结束之前到达的回执核验通过；之后只转交到结束点为止，回答随即结束，无论字节怎样切分，结束之后的内容都不会
    // 到达客户端。没有核验通过的回执时改发一个该格式的错误事件，客户端手里也不会有半个会被错误事件补全的事件。含以 U+FEFF 开头的行的
    // 流（客户端理解不一致），以及上游在结束之前关闭、留下缺少空行的未结束事件的流（回执规则丢弃它，openai SDK 却分派它），同样以
    // 这个错误事件结束。非严格模式不扣留、不截断；流一结束就核验并记录结束之前到达的回执（没有时等上游关闭），客户端在那里挂断时也
    // 记录；结束之后的事件、关闭时未结束的事件、以 U+FEFF 开头的行，各记一次失败。上游在结束之后断开不算失败。
    const st = format.streamState()
    // The adapter reads the answer up to its end only, the final event included (onEvent runs before receiptsAtEnd is set,
    // and only from scanner.push, after this initialiser; the check stays outside the try) (FIXED SSE-END).
    // 适配器只读到结束处（含最终事件；onEvent 在 receiptsAtEnd 设置之前运行，且只由 scanner.push 调用；判断放在 try 之外）。
    const scanner = ai.createSseScanner({ sentinel: format.stream.sentinel ?? null, final: format.stream.final ?? null, onEvent: (j, n) => { if (scanner.info.receiptsAtEnd !== null) return; try { st.event(j, n) } catch { /* the adapter's problem is the verdict's */ } } })
    // The last receipt first (the outermost sidecar's); an earlier one only if the last does not verify.
    // 先看最后一个回执（最外层旁路的）；它核验不过时才看更早的。
    async function verify(receipts, atEnd) {
      let rep = null
      for (let i = receipts.length - 1; i >= 0; i--) {
        let envelope
        try { envelope = ai.decodeReceiptHeader(receipts[i]) } catch { continue }
        // The hash where the stream first ended; the whole stream's only when it never ended (FIXED SSE-END).
        // 流第一次结束处的哈希；只有流从未结束时才用整条流的。
        const v = await check({ ...common, envelope, responseSha256: scanner.info.digestAtEnd ?? scanner.digest(), stream: true, answer: st.result() })
        if (v.ok || !rep) rep = v
        if (v.ok) break
      }
      if (!rep) rep = { ok: false, problems: [atEnd ? 'no tapeapi-receipt comment before the end of the event stream' : 'no tapeapi-receipt comment in the event stream'], warnings: [], unchecked: [], receipt: null }
      // Asked for, and none came (the same words as createVerifyingFetch). / 要了却没有。
      if (asked?.usageRequested && ai.usageOf(st.result().usage) === null) rep = { ...rep, warnings: [...rep.warnings, NO_USAGE_ASKED] }
      rep = { ...base, ...rep, stream: true }
      report(rep)
      return rep
    }
    // "\n\n" first: the receipt comment may have arrived split, its head already passed on unterminated; a line end closes
    // it and a blank line after a comment dispatches nothing, so the error event always stands on its own.
    // 先写 "\n\n"：回执注释可能被切开到达，前半截已转出且未结束；换行把它结束，注释后的空行不分派任何事件，错误事件因此总是独立的。
    const fail = (rep) => { res.write('\n\n' + streamErrorEvent(format, `the usage receipt did not verify: ${rep.problems.join('; ')}`, st.result().id)); res.end(); ac.abort() }
    // Strict: the bytes of an event not yet whole. At most this much; an event larger than that fails the stream.
    // 严格模式：尚不完整的事件的字节。至多这么多；更大的事件让流失败。
    let partial = [], partialLen = 0
    const flushPartial = () => { for (const p of partial) res.write(p); partial = []; partialLen = 0 }
    let verdict = null
    const ended = () => scanner.info.receiptsAtEnd !== null
    // Shapes no receipt covers, each logged once (FIXED SSE-END, SSE-EOF, SSE-BOM). / 不受任何回执覆盖的形态，各记录一次。
    const flagged = new Set()
    const flag = (problem) => { const rep = { ...base, ok: false, problems: [problem], warnings: [], unchecked: [], receipt: verdict?.receipt ?? null, stream: true }; if (!flagged.has(problem)) { flagged.add(problem); report(rep) } return rep }
    const late = () => ended() && scanner.info.events > scanner.info.eventsAtEnd
    const unfinished = () => { const t = scanner.state(); return t.eventHasData || t.eventHasFields || !t.atLineStart }
    res.writeHead(up.status, out)
    try {
      for await (const c of up.body) {
        const chunk = new Uint8Array(c)
        const wasEnded = ended()
        const cut = scanner.push(chunk)
        if (!opts.strict) {
          res.write(chunk)
          if (scanner.info.ambiguous) flag(AMBIGUOUS_LINE)
          // Checked and logged as soon as the stream ends: the client may hang up right there (FIXED SSE-LOG).
          // 流一结束就核验并记录：客户端可能就在那里挂断。
          if (!wasEnded && ended() && scanner.info.receiptsAtEnd > 0) verdict = await verify(scanner.info.receipts.slice(0, scanner.info.receiptsAtEnd), true)
          if (late()) flag(LATE_EVENT)
          continue
        }
        if (!ended()) {
          // A line read differently by different clients: nothing more goes on (FIXED SSE-BOM). / 各客户端理解不一致的行：不再转交。
          if (scanner.info.ambiguous) { verdict = flag(AMBIGUOUS_LINE); return fail(verdict) }
          if (cut < 0) {
            partial.push(chunk); partialLen += chunk.length
            if (partialLen > ai.EVENT_PARSE_LIMIT) { report(verdict = { ...base, ok: false, problems: [`an event larger than ${ai.EVENT_PARSE_LIMIT} bytes`], warnings: [], unchecked: [], receipt: null, stream: true }); return fail(verdict) }
            continue
          }
          flushPartial(); res.write(chunk.subarray(0, cut))
          if (cut < chunk.length) { partial.push(chunk.subarray(cut)); partialLen = chunk.length - cut }
          continue
        }
        // This chunk ends the stream: once a receipt that came before the end verifies, the stream goes on up to its end
        // and the answer ends there (FIXED SSE-END). / 流在这一块中结束：结束之前的回执核验通过后，只转交到结束点，回答随即结束。
        if (scanner.info.ambiguousAtEnd) { verdict = flag(AMBIGUOUS_LINE); return fail(verdict) }
        verdict = await verify(scanner.info.receipts.slice(0, scanner.info.receiptsAtEnd), true)
        if (!verdict.ok) return fail(verdict)
        const endAt = scanner.info.endOffset
        // A CR that ends the chunk and the stream: the LF that may follow is not waited for. / 块末的 CR 结束流：不等可能随后的 LF。
        flushPartial(); res.write(chunk.subarray(0, endAt))
        res.end(); ac.abort(); return
      }
    } catch (e) {
      // After the end the answer is whole: the upstream breaking off then is not a failure, and a client that hangs up
      // there still gets its verdict logged (FIXED SSE-LOG; strict never reads past the end).
      // 结束之后回答已完整：此时上游断开不算失败；客户端在那里挂断，结论也照样记录（严格模式不会读到结束之后）。
      if (ended() && !opts.strict) {
        if (!verdict) verdict = await verify(scanner.info.receipts.slice(0, scanner.info.receiptsAtEnd), true)
        if (!ac.signal.aborted && unfinished()) flag(UNFINISHED_EVENT)
        return res.end()
      }
      if (!ac.signal.aborted) log(`FAIL ${verb} ${url.pathname}: the stream broke off (${e?.message || e})`)
      return res.destroy()
    }
    scanner.end()
    if (!verdict) {
      verdict = await verify(scanner.info.receipts, false)
      if (!verdict.ok && opts.strict) return fail(verdict)
    }
    // An event left without its blank line: discarded by the receipt rule, dispatched by the openai SDK (FIXED SSE-EOF).
    // 缺少空行的未结束事件：回执规则丢弃它，openai SDK 却分派它。
    if (unfinished()) { const rep = flag(UNFINISHED_EVENT); if (opts.strict) return fail(rep) }
    flushPartial()
    res.end()
  })
  // No overall request timeout: a stream may run for minutes. / 不设整体请求超时：流可能持续数分钟。
  server.requestTimeout = 0
  server.headersTimeout = 15_000
  try {
    await new Promise((resolve, reject) => server.once('error', reject).listen(opts.port, opts.host, resolve))
  } catch (e) { process.stderr.write(`tapeapi-verify: cannot listen on ${opts.host}:${opts.port}: ${e.message}\n`); process.exit(1) }
  const { port } = server.address()
  const local = `http://${opts.host.includes(':') ? `[${opts.host}]` : opts.host}:${port}`
  const m = svc.manifest
  log(`service ${short(m.name, 80)}  ${svc.chainId && svc.chainId !== 56 ? `on ${CHAINS[svc.chainId]?.name ?? `chain ${svc.chainId}`}  ` : ''}container ${svc.container}  signer ${m.signer}${svc.verified.dev ? '  (DEV: not checked on chain)' : `  holder ${svc.verified.holder}`}`)
  for (const r of routes) log(`  ${r.format.name.padEnd(18)} -> ${r.root}${r.format.baseSuffix}`)
  log(`models priced: ${m[ai.MANIFEST_FIELD].models.map((x) => x.id).slice(0, 12).join(', ')}${m[ai.MANIFEST_FIELD].models.length > 12 ? ', ...' : ''}`)
  log(`listening on ${local}${opts.strict ? '  (strict)' : ''}${opts.salt ? '' : '  (no salt)'}${opts.stripSession ? '  (session headers stripped)' : ''}${opts.requestUsage ? '  (usage requested)' : ''}${opts.log ? `  log ${opts.log}` : ''}`)
  log(`  ANTHROPIC_BASE_URL=${local}    OPENAI_BASE_URL=${local}/v1`)
  const stop = (sig) => { log(`${sig}: ${stats.ok} verified, ${stats.failed} failed, ${stats.sidecarErrors} sidecar errors, ${stats.passThrough} passed through; exiting`); process.exit(0) }
  process.on('SIGTERM', () => stop('SIGTERM'))
  process.on('SIGINT', () => stop('SIGINT'))
}

// ---------------------------------------------------------------------------------------------------------------
// `tapeapi-verify task <thread.json>` (EXPERIMENTAL, 1.7, outside the 1.x compatibility promise): check a container-agent task
// thread with createAgentKit(...).verifyTaskThread (@tapeapi/sdk/agent), and optionally the payment that belongs to it. It reads the
// chain; it signs nothing, sends nothing and pays for nothing. Phase 0 has no enforcement: every result says `enforcement: none`.
// `task`（实验性，1.7，不受 1.x 兼容承诺约束）：用 createAgentKit(...).verifyTaskThread 核验容器代理的任务线程，可选再核验对应的付款。
// 只读链；不签名、不发送、不付款。阶段 0 没有强制执行：每个结果都写 `enforcement: none`。
// ---------------------------------------------------------------------------------------------------------------
const TASK_USAGE = `
tapeapi-verify task (experimental, 1.7; not covered by the 1.x compatibility promise): check a container-agent task thread.

Usage: tapeapi-verify task <thread.json> [--payment <recipient> <index>] [--rpc <url,url,...>]

  <thread.json>        a JSON array of the thread's messages in the order they were received (tape.agent/offer, accept, mandate,
                       deliver, acceptance, revocation). Prints the state, the problems, whether it is a self-hire, who the two
                       parties are (container address and on-chain name; a name the manifest gives is marked untrusted), and
                       \`enforcement: none\`: a phase-0 mandate is a signed statement, nothing enforces it.
  --payment <recipient> <index>
                       also check the payment: the TapeSend message at <index> in the inbox of the container <recipient>, which must be
                       the thread's agent, sent by the thread's principal, with every asset attachment verified (TAP-10 section 19).
                       Public (unsealed) messages only.
  --rpc <url,url,...>  BNB Chain nodes; each chain read needs 2 to agree (default: ${DEFAULT_RPC.length} public nodes of distinct operators)

Exit status: 0 the thread verifies (and the payment, with --payment), 1 it does not, or a runtime failure (the file cannot be read,
the chain cannot be read), 2 a usage mistake (an unknown option, no file, a file that is not a JSON array of messages, --rpc with fewer
than 2 operators). The revocation floor and nonce store of one run start empty: a one-shot check cannot see an older list put back or a
reused nonce. A receipt proves who answered which call, not that the work is right.

tapeapi-verify task（实验性，1.7；不受 1.x 兼容承诺约束）：核验容器代理的任务线程。
用法：tapeapi-verify task <thread.json> [--payment <收款容器> <序号>] [--rpc <url,url,...>]
<thread.json> 是按收到顺序排列的消息 JSON 数组；打印状态、问题、是否自雇自、双方身份（容器地址与链上名字；清单给的名字标 untrusted）与
enforcement: none（阶段 0 的授权书只是签名声明，没有任何东西强制执行）。--payment 另核验付款：收款容器必须是线程里的代理，发件方必须是线程里的
委托方，每个资产附件按 TAP-10 第 19 节核验（只支持公开、未加密的消息）。退出码：0 通过，1 未通过或运行失败，2 用法错误。
`

function parseTaskArgs(argv) {
  const o = { file: null, rpc: null, payment: null, help: false }
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i], v
    const eq = a.startsWith('--') ? a.indexOf('=') : -1
    if (eq > 0) { v = a.slice(eq + 1); a = a.slice(0, eq) }
    const value = () => {
      if (v !== undefined) return v
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`)
      return argv[++i]
    }
    switch (a) {
      case '--help': case '-h': o.help = true; break
      case '--rpc': o.rpc = value().split(',').map((x) => x.trim()).filter(Boolean); break
      case '--payment': {
        if (v !== undefined || i + 2 >= argv.length) throw new Error('--payment needs <recipient> <index>')
        const recipient = argv[++i], index = argv[++i]
        if (!ADDRESS_RE.test(recipient)) throw new Error(`--payment: ${recipient} is not a container address (0x...)`)
        if (!/^(0|[1-9][0-9]{0,15})$/.test(index)) throw new Error(`--payment: ${index} is not an inbox index (a whole number)`)
        o.payment = { recipient, index: Number(index) }
        break
      }
      default:
        if (a.startsWith('-')) throw new Error(`unknown option ${a}`)
        if (o.file) throw new Error('name one thread file')
        o.file = a
    }
  }
  return o
}

/**
 * The `task` subcommand. `argv` is what follows the word `task`; `api` a createTapeAPI() client with rpcUrls of at least two
 * operators (tests pass one, with a fixed `clock`; taskMain makes it from --rpc). Returns the exit status: 0, 1 or 2 (see TASK_USAGE).
 * @experimental
 */
export async function runTask(argv, { api, clock, out = (t) => process.stdout.write(t), err = (t) => process.stderr.write(t) } = {}) {
  let o
  try { o = parseTaskArgs(argv) } catch (e) { err(`tapeapi-verify task: ${e.message}\n${TASK_USAGE}`); return 2 }
  if (o.help) { out(TASK_USAGE.replace(/^\n/, '')); return 0 }
  if (!o.file) { err(`tapeapi-verify task: name the thread file\n${TASK_USAGE}`); return 2 }
  let text
  try {
    const st = statSync(o.file)
    if (!st.isFile() || st.size > THREAD_LIMIT) throw new Error(st.isFile() ? `larger than ${THREAD_LIMIT} bytes` : 'not a file')
    text = readFileSync(o.file, 'utf8')
  } catch (e) { err(`tapeapi-verify task: cannot read ${o.file}: ${e.code ?? e.message}\n`); return 1 }
  let messages
  try { messages = JSON.parse(text) } catch (e) { err(`tapeapi-verify task: ${o.file} is not JSON: ${e.message}\n`); return 2 }
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 64 || messages.some((m) => !m || typeof m !== 'object' || Array.isArray(m))) {
    err(`tapeapi-verify task: ${o.file} must be a JSON array of 1 to 64 messages (objects)\n`); return 2
  }
  const agent = await import('../src/agent-public.js')
  const { plainText } = agent
  let check, payment = null
  try {
    const kit = agent.createAgentKit(api, clock ? { clock } : {})   // `clock` is for tests; a run of the command reads the system clock
    check = await kit.verifyTaskThread(messages)
    if (o.payment) payment = await checkPayment(agent, api, check, o.payment)
  } catch (e) { err(`tapeapi-verify task: cannot check the thread: ${e?.code ? e.code + ': ' : ''}${e?.message ?? e}\n`); return 1 }
  const lines = []
  const who = (i) => (i ? `${i.container}  name ${i.name ?? '(none on the chain\'s processor table)'}` : 'unknown')
  lines.push(`tapeapi-verify task: ${messages.length} message(s), chain ${api.chainId}   EXPERIMENTAL`)
  lines.push(`state:       ${check.state ?? 'none'}`)
  lines.push(`result:      ${check.ok ? 'ok' : 'NOT ok'}`)
  lines.push(`enforcement: ${check.enforcement} (phase 0: a mandate is a signed statement; nothing enforces it)`)
  lines.push(`self-hire:   ${check.selfHire ? `YES (${check.selfHireReasons.join(', ')}): reputation rules should leave this thread out` : 'no'}`)
  lines.push(`principal:   ${who(check.principal)}${check.principal ? `  holder ${check.principal.holder}` : ''}`)
  lines.push(`agent:       ${who(check.agent)}${check.agent?.signer ? `  signer ${check.agent.signer}` : ''}`)
  if (check.agent?.displayName) lines.push(`             manifest name (untrusted: the agent wrote it, it is not an identity): "${plainText(check.agent.displayName.text, 64)}"`)
  if (check.offerHash) lines.push(`offer:       ${check.offerHash}`)
  if (check.mandateHash) lines.push(`mandate:     ${check.mandateHash}${check.mandateCheck?.revocation ? `  revocation list: ${check.mandateCheck.revocation.status}` : ''}`)
  for (const d of check.deliveries) lines.push(`delivery:    deliverable ${d.deliverableHash} at ${d.ts}, ${d.evidence.receipts.length} receipt(s), evidence ${d.evidence.ok ? 'ok' : 'NOT ok'}`)
  if (check.evidence) lines.push(`evidence:    proves: ${check.evidence.proves}; does NOT prove: ${check.evidence.doesNotProve.join('; ')}`)
  lines.push(`verdict:     ${check.verdict ? `${check.verdict.verdict} at ${check.verdict.issued} (verdictHash ${check.verdict.verdictHash})` : 'none'}`)
  // the revocation time R only refuses agent messages signed after it; it does not by itself cancel the thread (the state
  // line says whether the final checks did) / 撤销时间只拒收其后签名的代理消息，本身不表示取消
  lines.push(`revocation:  ${check.revoked ? `at ${check.revoked.at} (${check.revoked.via}); agent messages signed after it are refused` : 'none'}`)
  if (check.unaccepted) lines.push('unaccepted:  yes (delivered, and no verdict before the delivery\'s own exp; there is no arbiter)')
  lines.push(`problems:    ${check.problems.length ? check.problems.length : 'none'}`)
  for (const p of check.problems) lines.push(`  - ${p.code}: ${plainText(p.message, 200)}`)
  if (payment) {
    lines.push(`payment:     message ${o.payment.index} in the inbox of ${o.payment.recipient}: ${payment.ok ? 'ok' : 'NOT ok'}`)
    for (const l of payment.lines) lines.push(`  ${l}`)
  }
  out(lines.join('\n') + '\n')
  return check.ok && (!payment || payment.ok) ? 0 : 1
}

// The payment that belongs to a thread (--payment): read-only TAP-10 §19 checks of one inbox message, plus what only this command
// can add: the message must be for the thread's agent and from the thread's principal. Nothing is signed or sent.
async function checkPayment(agent, api, check, { recipient, index }) {
  const lines = []
  let ok = true
  const bad = (m) => { ok = false; lines.push(m) }
  const pay = agent.createPaymentKit(api)
  // identityOf reads ownerOf: an agent without `circuits` here did not resolve as a minted TapeOut container, and a payment sent
  // to the address derived for a #ID nobody holds could never be moved by anyone
  if (!check.agent?.circuits) bad('the thread\'s agent is not a minted TapeOut container (no holder on the chain): a payment to it could never be moved')
  if (!check.agent?.container || recipient.toLowerCase() !== check.agent.container.toLowerCase()) bad(`the recipient ${recipient} is not the thread's agent (${check.agent?.container ?? 'unknown'}): this is not a payment to it`)
  const msg = await pay.readMessage({ recipient, inboxIndex: index })
  if (msg.status !== 'ok') { bad(`the message cannot be read: ${msg.status}`); return { ok, lines } }
  if (!check.principal?.container || msg.entry.from.toLowerCase() !== check.principal.container.toLowerCase()) bad(`the message is from ${msg.entry.from}, not the thread's principal (${check.principal?.container ?? 'unknown'})`)
  const results = await pay.verifyAttachments(msg)
  if (!results.length) bad('the message carries no asset attachment: nothing to verify')
  for (const r of results) {
    const a = r.attachment
    if (r.result !== 'ok') ok = false
    lines.push(`${a.type}${a.token ? ` ${a.token}` : ''} ${a.amount ?? `#${a.tokenId}`} in ${a.tx}: ${r.result}${r.step ? ` (step ${r.step})` : ''}${r.reason ? `: ${agent.plainText(r.reason, 120)}` : ''}`)
  }
  const named = check.verdict && typeof msg.message?.body === 'string' && msg.message.body.includes(check.verdict.verdictHash)
  lines.push(`the message body ${check.verdict ? (named ? 'names' : 'does not name') + ' the thread\'s verdictHash (information only)' : 'cannot name a verdict: the thread has none'}`)
  return { ok, lines }
}

async function taskMain(argv) {
  let o
  try { o = parseTaskArgs(argv) } catch (e) { process.stderr.write(`tapeapi-verify task: ${e.message}\n${TASK_USAGE}`); return 2 }
  if (o.help || !o.file) return runTask(argv, { api: null })
  const rpcUrls = o.rpc ?? DEFAULT_RPC
  if (new Set(rpcUrls.map(operatorOf)).size < 2) { process.stderr.write('tapeapi-verify: --rpc needs nodes of at least 2 independent operators (every chain read must be agreed by 2)\n'); return 2 }
  return runTask(argv, { api: createTapeAPI({ rpcUrls, quorum: 2 }) })
}

// Run as a program, not when imported (tests import routesOf / route). / 作为程序运行时才启动（测试只导入函数）。
const self = (() => { try { return realpathSync(fileURLToPath(import.meta.url)) } catch { return null } })()
const argv1 = (() => { try { return process.argv[1] && realpathSync(process.argv[1]) } catch { return null } })()
if (self && self === argv1) main().catch((e) => { log(`fatal: ${e?.stack || e}`); process.exit(1) })
