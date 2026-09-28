#!/usr/bin/env node
// The TapeAPI signing sidecar for a relay running new-api: it sits IN FRONT of new-api (client -> sidecar -> new-api),
// passes /v1/* through byte for byte and signs a usage receipt for every Chat, Responses, Anthropic Messages and
// Embeddings answer (createAIProxy from @tapeapi/server/ai-proxy). new-api keeps its channels, keys, quotas and billing;
// your users keep their keys and their SDKs. The operator runs it; nobody else hosts it (it sees your users' API keys).
// 给运行 new-api 的中转站用的 TapeAPI 签名旁路：放在 new-api **前面**（客户端 -> 旁路 -> new-api），/v1/* 逐字节透传，并为每个
// Chat、Responses、Anthropic Messages、Embeddings 回答签一份用量回执。new-api 的渠道、密钥、额度与计费都不变；用户的密钥与 SDK
// 也不变。旁路由中转站自己运行，不交给任何第三方托管（它经手用户的 API 密钥）。
//
// Environment / 环境变量:
//   PUBLIC_URL           https://api.example.com   the public https root of THIS sidecar (your users' base URL root)
//   CIRCUITS, TOKEN_ID, CONTAINER, DELEGATION_EXPIRES, DELEGATION_SIG   the identity, as the holder console shows them
//   SIGNER_KEY           the service key the delegation names (or SIGNER_KEY_FILE: a file holding it, e.g. a Docker secret)
//   MODELS_FILE          the price table (default: models.json next to this file)
//   UPSTREAM_BASE_URL    new-api's /v1 base (default http://new-api:3000/v1, the compose service)
//   TAPE_NAME            optional: the service's TapeOut name, printed in the hint for tapeapi-verify users
//   SERVICE_NAME         optional display name (default "AI relay (TapeAPI sidecar)")
//   PORT, HOST           listen address (default 8080, 127.0.0.1; the image sets HOST=0.0.0.0)
//   RATE_IP              requests per minute per client IP at the sidecar (default 600; 0 = off, leave limits to new-api)
//   CLIENT_IP_HEADER     the header your reverse proxy sets to the client's address (x-real-ip, x-forwarded-for, ...);
//                        unset = the TCP peer (then every caller behind one proxy shares one rate-limit bucket)
//   SIGNER_ADDRESS       optional: must match SIGNER_KEY (a guard against pasting the wrong key)
//
// Until the identity is complete the sidecar runs in SETUP MODE: /tapeapi/v1/health names the signing address (the
// holder console reads it there to build the delegation) and what is missing; everything else answers 503.
// 身份变量设齐之前旁路处于**设置模式**：/tapeapi/v1/health 给出签名地址（持有人操作台从这里读取它来构造委托）与缺了什么；其余一律 503。
//
//   node examples/new-api-sidecar/server.mjs          (Docker: see docker-compose.yml and README.md)
import http from 'node:http'
import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createAIProxy } from '@tapeapi/server/ai-proxy'
import { sig, ai } from '@tapeapi/sdk'

export const REQUIRED = ['PUBLIC_URL', 'CIRCUITS', 'TOKEN_ID', 'CONTAINER', 'DELEGATION_EXPIRES', 'DELEGATION_SIG']
export const DEFAULT_UPSTREAM = 'http://new-api:3000/v1'
export const DEFAULT_MODELS_FILE = fileURLToPath(new URL('models.json', import.meta.url))
export const CONSOLE_URL = 'https://tapeapi.fun/console/'
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const HEADER_NAME = /^[a-z0-9!#$%&'*+.^_`|~-]+$/
const LOOPBACK_HTTP = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' }

/**
 * Read and check the environment. Never throws: `ok: false` is setup mode, with `missing` (variables not set) and
 * `problem` (a variable that is set but wrong), so the operator sees one clear sentence instead of a stack trace.
 * 读取并检查环境变量。从不抛出：ok 为 false 即设置模式，missing 列出没设的变量，problem 说明设了但不对的那一个。
 * @param {Record<string, string|undefined>} rawEnv
 * @returns {{ ok: boolean, missing: string[], problem: string|null, signer: string|null, config?: object }}
 */
export function readConfig(rawEnv = process.env) {
  // Values pasted from a phone or a web page often carry a trailing space or newline. / 粘贴来的值常带尾随空白。
  const env = Object.fromEntries(Object.entries(rawEnv || {}).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]))
  const out = (problem, extra = {}) => ({ ok: false, missing: extra.missing ?? [], problem, signer: extra.signer ?? null })

  let signerKey = env.SIGNER_KEY || ''
  if (!signerKey && env.SIGNER_KEY_FILE) {
    try { signerKey = readFileSync(env.SIGNER_KEY_FILE, 'utf8').trim() } catch (e) { return out(`SIGNER_KEY_FILE ${env.SIGNER_KEY_FILE} cannot be read (${e.code || e.message})`) }
  }
  let signer = null
  if (signerKey) {
    try { signer = sig.privateKeyToAddress(signerKey) } catch { return out('SIGNER_KEY is not a private key (0x followed by 64 hex digits); generate one in step 3 of the holder console') }
  }
  const missing = [...(signer ? [] : ['SIGNER_KEY (secret)']), ...REQUIRED.filter((k) => !env[k])]
  if (missing.length) return out(null, { missing, signer })
  if (env.SIGNER_ADDRESS && env.SIGNER_ADDRESS.toLowerCase() !== signer.toLowerCase()) return out(`SIGNER_ADDRESS ${env.SIGNER_ADDRESS} does not match SIGNER_KEY (${signer})`, { signer })

  // Identity / 身份
  let pub
  try { pub = new URL(env.PUBLIC_URL) } catch { return out(`PUBLIC_URL must be a URL such as https://api.example.com, not ${JSON.stringify(env.PUBLIC_URL)}`, { signer }) }
  const publicUrl = pub.href.replace(/\/+$/, '')
  const loopback = LOOPBACK_HTTP.test(publicUrl)
  if (pub.protocol !== 'https:' && !loopback) return out(`PUBLIC_URL must be https (terminate TLS in your reverse proxy in front of the sidecar); http only for 127.0.0.1 or localhost`, { signer })
  if (pub.search || pub.hash || pub.username || pub.password) return out('PUBLIC_URL must not carry a query, a fragment or credentials', { signer })
  // A bare origin: the holder console publishes endpoints of the form https://<host>/tapeapi/v1 only. / 只写到域名：操作台只发布 https://<host>/tapeapi/v1 形式的端点。
  if (pub.pathname !== '/') return out(`PUBLIC_URL must be a bare origin such as https://api.example.com, without the path ${pub.pathname}`, { signer })
  for (const k of ['CIRCUITS', 'CONTAINER']) if (!ADDRESS.test(env[k])) return out(`${k} must be an address (0x followed by 40 hex digits), as the holder console shows it`, { signer })
  if (!/^\d{1,78}$/.test(env.TOKEN_ID)) return out('TOKEN_ID must be a whole number (your circuit\'s token id)', { signer })
  const expires = Number(env.DELEGATION_EXPIRES)
  if (!/^\d{1,12}$/.test(env.DELEGATION_EXPIRES)) return out('DELEGATION_EXPIRES must be a Unix time in seconds, as the holder console shows it', { signer })
  if (expires <= Math.floor(Date.now() / 1000)) return out(`the delegation expired at ${new Date(expires * 1000).toISOString()}: renew it in step 4 of the holder console (${CONSOLE_URL}) and set the new DELEGATION_EXPIRES and DELEGATION_SIG`, { signer })
  if (!/^0x[0-9a-fA-F]{130,}$/.test(env.DELEGATION_SIG)) return out('DELEGATION_SIG must be the 65-byte signature from step 4 of the holder console (0x followed by 130 hex digits)', { signer })

  // Upstream (new-api) / 上游
  const upstreamBaseUrl = env.UPSTREAM_BASE_URL || DEFAULT_UPSTREAM
  try { const u = new URL(upstreamBaseUrl); if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error() } catch { return out(`UPSTREAM_BASE_URL must be new-api's /v1 base, such as ${DEFAULT_UPSTREAM}`, { signer }) }

  // The price table / 价目表
  const modelsFile = env.MODELS_FILE || DEFAULT_MODELS_FILE
  const models = readModels(modelsFile, publicUrl)
  if (typeof models === 'string') return out(models, { signer })

  // Rate limit and client address / 限流与客户端地址
  const rateIp = env.RATE_IP === undefined || env.RATE_IP === '' ? 600 : Number(env.RATE_IP)
  if (!Number.isInteger(rateIp) || rateIp < 0) return out('RATE_IP must be a whole number of requests per minute per client IP (0 = no limit at the sidecar)', { signer })
  const clientIpHeader = env.CLIENT_IP_HEADER ? env.CLIENT_IP_HEADER.toLowerCase() : null
  if (clientIpHeader && !HEADER_NAME.test(clientIpHeader)) return out(`CLIENT_IP_HEADER must be a header name such as x-real-ip, not ${JSON.stringify(env.CLIENT_IP_HEADER)}`, { signer })
  const name = env.SERVICE_NAME || 'AI relay (TapeAPI sidecar)'
  if ([...name].length > 64) return out('SERVICE_NAME must be at most 64 characters', { signer })
  // The receipt method: lifetime and whether a lookup must name the request hash (for channels whose answer ids are
  // guessable, such as Ollama's). / receipt 方法：保留时长，以及取回是否必须给出请求哈希（渠道的回答 id 可猜时用，例如 Ollama）。
  const receiptTtlS = env.RECEIPT_TTL_S === undefined || env.RECEIPT_TTL_S === '' ? 3600 : Number(env.RECEIPT_TTL_S)
  if (!Number.isInteger(receiptTtlS) || receiptTtlS <= 0) return out('RECEIPT_TTL_S must be a whole number of seconds above 0 (default 3600)', { signer })
  if (![undefined, '', '0', '1'].includes(env.RECEIPT_REQUIRE_HASH)) return out('RECEIPT_REQUIRE_HASH must be 1 (a receipt lookup must name requestSha256 too) or 0', { signer })
  const requireRequestHash = env.RECEIPT_REQUIRE_HASH === '1'
  // 0: the clients' session headers (x-claude-code-session-id, session-id, thread-id) do not reach new-api. / 0：不转发会话头。
  if (![undefined, '', '0', '1'].includes(env.FORWARD_SESSION_HEADERS)) return out('FORWARD_SESSION_HEADERS must be 1 (pass the clients\' session headers upstream, the default) or 0', { signer })
  const forwardSessionHeaders = env.FORWARD_SESSION_HEADERS !== '0'

  return {
    ok: true, missing: [], problem: null, signer,
    config: {
      publicUrl, loopback, upstreamBaseUrl, modelsFile, models, signerKey, signer, rateIp, clientIpHeader, receiptTtlS, requireRequestHash, forwardSessionHeaders,
      tapeName: env.TAPE_NAME || null,
      manifestBase: {
        tapeapi: '0.1', name, circuits: env.CIRCUITS, tokenId: String(BigInt(env.TOKEN_ID)), container: env.CONTAINER,
        delegation: { expires, sig: env.DELEGATION_SIG },
        endpoints: { live: [`${publicUrl}/tapeapi/v1`], async: false },
      },
    },
  }
}

/**
 * The price table from a file: the models array, or a sentence saying what is wrong with it (file, JSON, or the rules
 * of TAP-20 §3.9 checked exactly as clients check them). / 从文件读价目表：返回数组，或一句说明哪里不对的话。
 */
export function readModels(file, publicUrl = 'https://sidecar.invalid') {
  let text
  try { text = readFileSync(file, 'utf8') } catch (e) { return `MODELS_FILE ${file} cannot be read (${e.code || e.message}); copy models.example.json to models.json and edit it` }
  let models
  try { models = JSON.parse(text) } catch (e) { return `MODELS_FILE ${file} is not valid JSON: ${e.message}` }
  if (!Array.isArray(models) || !models.length) return `MODELS_FILE ${file} must hold a JSON array of models: [{ "id", "aliases"?, "formats"?, "prices": [{ "currency", "unit": "1M tokens", "input", "output", ... }] }]`
  try {
    ai.validateAIField({ endpoints: ai.FORMATS.map((f) => ({ format: f.name, baseUrl: publicUrl + f.baseSuffix })), models }, { allowHttp: true })
  } catch (e) { return `the price table in ${file} is not valid: ${e.message}` }
  return models
}

/** The sidecar for a good configuration. Throws what createAIProxy throws. / 按正确配置建出旁路。 */
export function buildProxy(config, { fetch, log } = {}) {
  return createAIProxy({
    upstream: { baseUrl: config.upstreamBaseUrl },
    manifestBase: config.manifestBase,
    signerKey: config.signerKey,
    models: config.models,
    allowHttp: config.loopback,
    rateLimit: config.rateIp === 0 ? false : { windowMs: 60_000, free: config.rateIp, paid: 0, ip: config.rateIp },
    ...(config.receiptTtlS ? { receiptTtlMs: config.receiptTtlS * 1000 } : {}),
    ...(config.requireRequestHash ? { requireRequestHash: true } : {}),
    ...(config.forwardSessionHeaders === false ? { forwardSessionHeaders: false } : {}),
    ...(fetch ? { fetch } : {}),
    ...(log ? { log } : {}),
  })
}

/** Setup mode, as examples/cloudflare-worker's setupAnswer (the holder console reads the signer from health).
 *  设置模式，与 examples/cloudflare-worker 的 setupAnswer 相同（持有人操作台从 health 读取签名地址）。 */
export function setupAnswer(state, request) {
  const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...CORS, ...headers } })
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  const path = new URL(request.url).pathname.replace(/\/+$/, '')
  const why = state.problem || `missing: ${state.missing.join(', ')}`
  if (request.method === 'GET' && path === '/tapeapi/v1/health') return json(200, { ok: false, setup: true, signer: state.signer, missing: state.missing, ...(state.problem ? { problem: state.problem } : {}) })
  // An AI client gets the error in the OpenAI shape it can print. / AI 客户端收到它能显示的 OpenAI 错误格式。
  if (path.startsWith('/v1/')) return json(503, { error: { message: `this AI service is being set up (${why})`, type: 'tapeapi_proxy_error', param: null, code: 'setup' } }, { [ai.SIDECAR_ERROR_HEADER]: '1' })
  return json(503, { ok: false, error: { code: 'DELEGATION_INVALID', message: `this service is being set up; ${why}` } })
}

/**
 * The request handler for an environment: the sidecar when the configuration is complete, setup mode otherwise.
 * 按环境变量得到请求处理函数：配置完整时是旁路，否则是设置模式。
 */
export function createSidecar(env = process.env, { fetch, log = (...a) => console.error('[new-api-sidecar]', ...a) } = {}) {
  let state = readConfig(env)
  let proxy = null
  if (state.ok) {
    try { proxy = buildProxy(state.config, { fetch, log }) } catch (e) { state = { ok: false, missing: [], problem: e.message, signer: state.signer } }
  }
  return {
    state, proxy,
    config: state.ok ? state.config : null,
    handleRequest: (request, { clientIp } = {}) => (proxy ? proxy.handleRequest(request, { clientIp }) : setupAnswer(state, request)),
  }
}

/** The client's address: the trusted header when configured (the right-most entry of a list: the one your proxy added),
 *  else the TCP peer. / 客户端地址：配置了可信请求头时取它（列表取最右一项，即你的代理加上的那项），否则取 TCP 对端。 */
export function clientIpOf(req, header) {
  if (header) {
    const v = req.headers[header]
    const s = Array.isArray(v) ? v[v.length - 1] : v
    const last = typeof s === 'string' ? s.split(',').map((x) => x.trim()).filter(Boolean).pop() : null
    if (last) return last.slice(0, 64)
  }
  return req.socket.remoteAddress || 'unknown'
}

/**
 * Listen and serve. Node's http <-> the fetch-style handler, streaming both ways: an event stream is written chunk by
 * chunk as it comes, never buffered (the same bridge as examples/ai-proxy/index.mjs).
 * 监听并服务。Node http 与 fetch 风格处理函数之间双向流式转换：事件流逐块写出，从不缓冲。
 * @param {{ env?: object, port?: number, host?: string, fetch?: Function, log?: Function, quiet?: boolean,
 *           localPublicUrl?: boolean }} [o]  localPublicUrl: TESTING ONLY, PUBLIC_URL defaults to http://127.0.0.1:<port>
 */
export async function startSidecar({ env = process.env, port, host, fetch, log, quiet = false, localPublicUrl = false } = {}) {
  const say = quiet ? () => {} : (l) => console.log(`[new-api-sidecar] ${l}`)
  let sidecar = null
  const server = http.createServer(async (req, res) => {
    try {
      if (!sidecar) { res.writeHead(503, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"starting","type":"tapeapi_proxy_error","code":"starting"}}') }
      const headers = new Headers()
      for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) { try { headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]) } catch { /* not a fetch header */ } }
      const hasBody = !['GET', 'HEAD'].includes(req.method)
      let it = null
      const body = hasBody ? new ReadableStream({
        async pull(c) { it ??= req[Symbol.asyncIterator](); const { done, value } = await it.next(); if (done) c.close(); else c.enqueue(new Uint8Array(value)) },
        cancel() { req.destroy() },
      }, { highWaterMark: 0 }) : undefined
      const r = await sidecar.handleRequest(new Request(new URL(req.url, 'http://127.0.0.1'), { method: req.method, headers, body, duplex: 'half' }), { clientIp: clientIpOf(req, sidecar.config?.clientIpHeader) })
      res.writeHead(r.status, Object.fromEntries(r.headers))
      if (!r.body) return res.end()
      res.on('close', () => { if (!res.writableEnded) r.body.cancel().catch(() => {}) })   // the client went away / 客户端离开
      for await (const chunk of r.body) res.write(chunk)
      res.end()
    } catch (e) {
      console.error('[new-api-sidecar] request failed:', e?.message || e)
      if (!res.headersSent) { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":{"message":"malformed request","type":"tapeapi_proxy_error","code":"bad_request"}}') } else res.destroy()
    }
  })
  // No overall request timeout: a stream may run for minutes. Headers must still arrive in 15 s.
  // 不设整体请求超时：流可能持续数分钟。请求头仍须在 15 秒内到达。
  server.requestTimeout = 0
  server.headersTimeout = 15_000
  const listenPort = Number(port ?? env.PORT ?? 8080)
  const listenHost = host ?? env.HOST ?? '127.0.0.1'
  await new Promise((resolve, reject) => server.once('error', reject).listen(listenPort, listenHost, resolve))
  const actual = server.address().port
  const effective = localPublicUrl && !env.PUBLIC_URL ? { ...env, PUBLIC_URL: `http://127.0.0.1:${actual}` } : env
  sidecar = createSidecar(effective, { fetch, ...(log ? { log } : {}) })

  const { state } = sidecar
  say(`listening on http://${listenHost}:${actual}`)
  if (!state.ok) {
    say(`SETUP MODE: ${state.problem || `missing ${state.missing.join(', ')}`}`)
    say(`signer   ${state.signer ?? '(no SIGNER_KEY yet)'}`)
    say(`next     open ${CONSOLE_URL}; it reads the signer from ${effective.PUBLIC_URL ? effective.PUBLIC_URL.replace(/\/+$/, '') : '<PUBLIC_URL>'}/tapeapi/v1/health`)
  } else {
    const m = sidecar.proxy.manifest(), c = state.config
    say(`${m.name}: signer ${m.signer}, container ${m.container}, delegation until ${new Date(m.delegation.expires * 1000).toISOString().slice(0, 10)}`)
    say(`upstream ${c.upstreamBaseUrl}   (new-api; your users' keys pass through to it unchanged)`)
    for (const e of m.ai.endpoints) say(`${e.format.padEnd(18)} ${e.baseUrl}`)
    say(`models   ${m.ai.models.length} priced (${m.ai.models.slice(0, 6).map((x) => x.id).join(', ')}${m.ai.models.length > 6 ? ', ...' : ''}) from ${c.modelsFile}`)
    say(`manifest ${c.publicUrl}/.well-known/tapeapi.json   (publish it on chain from ${CONSOLE_URL})`)
    if (c.rateIp && !c.clientIpHeader) say(`rate     ${c.rateIp}/min per TCP peer: behind a reverse proxy set CLIENT_IP_HEADER, or all callers share one bucket (RATE_IP=0 leaves limits to new-api)`)
    if (c.tapeName) say(`verify   users of Claude Code or Codex can run: tapeapi-verify ${c.tapeName}`)
    const days = Math.floor((m.delegation.expires * 1000 - Date.now()) / 86_400_000)
    if (days < 30) say(`RENEW    the delegation expires in ${days} days: renew it in step 4 of ${CONSOLE_URL}`)
  }
  return {
    server, port: actual, url: `http://127.0.0.1:${actual}`, state, proxy: sidecar.proxy, handleRequest: sidecar.handleRequest,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()) }),
  }
}

// Run as a program (not when imported by the smoke test or the tests). / 作为程序运行时启动（被测试导入时不启动）。
const isMain = (() => { try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) } catch { return false } })()
if (isMain) {
  const s = await startSidecar()
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await s.close(); process.exit(0) })
}
