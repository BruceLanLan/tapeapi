// The AI signing sidecar as a Cloudflare Worker: your AI API stays where it is (UPSTREAM_BASE_URL, its /v1 base); this
// Worker, on a hostname of yours, gives it a TapeOut identity, pins one endpoint per API format (OpenAI Chat, OpenAI
// Responses, Anthropic Messages, Embeddings) and the price table in the manifest, and signs a usage receipt for every
// metered answer. Streams are passed through as they arrive.
// Same identity and setup mode as examples/cloudflare-worker, so the holder console works unchanged for the identity.
// AI 签名旁路的 Cloudflare Worker：你的 OpenAI 兼容接口留在原处（UPSTREAM_BASE_URL）；这个 Worker 放在你自己的主机名上，给它
// TapeOut 身份、把接口地址与价目表钉进清单，并为每个计量的回答签发用量回执。流按到达透传。身份与设置模式同
// examples/cloudflare-worker，持有人操作台的身份部分无需改动。
//
// Secret: SIGNER_KEY (and UPSTREAM_AUTHORIZATION only if the upstream needs a key of yours rather than your callers').
// Variables: UPSTREAM_BASE_URL, MODELS_JSON (the price table), CIRCUITS, TOKEN_ID, CONTAINER, DELEGATION_EXPIRES,
// DELEGATION_SIG, PUBLIC_URL; optional SERVICE_NAME, RATE_IP (requests per minute per IP, default 600), RECEIPT_TTL_S
// (how long receipts stay retrievable, default 3600), RECEIPT_LOOKUPS_PER_MIN (the receipt method's budget per IP,
// default 10), RECEIPT_REQUIRE_HASH ("1": a receipt lookup must name requestSha256 too; for an upstream whose answer
// ids are guessable, such as Ollama's), FORWARD_SESSION_HEADERS ("0": do not pass the clients' session headers
// x-claude-code-session-id, session-id and thread-id upstream; default: pass them).
// FORMATS (set it): the API formats your upstream really serves, comma-separated, among openai-chat, openai-responses,
// anthropic-messages, openai-embeddings, or "all". Only these are published in the manifest (a public statement on
// chain) and get receipts; an upstream that is OpenAI-compatible only sets FORMATS=openai-chat. Unset: all four, as
// 2.0.0 published, with a "warning" in /tapeapi/v1/health and one console warning per isolate, naming FORMATS and its
// values. An unknown name: setup mode, naming the variable. Same rule as examples/new-api-sidecar. A metered path of a
// format left out is answered HTTP 400 naming FORMATS and is not forwarded.
// 密钥：SIGNER_KEY（只有上游需要你自己的而不是调用方的密钥时，再加 UPSTREAM_AUTHORIZATION）。变量见上；RECEIPT_TTL_S 为回执
// 可取回的秒数，RECEIPT_LOOKUPS_PER_MIN 为 receipt 方法每 IP 每分钟的次数，RECEIPT_REQUIRE_HASH 为 "1" 时取回执须同时给出
// requestSha256（上游 id 可猜时用，例如 Ollama）；FORWARD_SESSION_HEADERS 为 "0" 时不把客户端的会话头转发给上游（默认转发）。
// FORMATS（请设置）：上游真正提供的 API 格式，逗号分隔，或 "all"。只有这些格式写进清单（链上的公开声明）并签发回执；只兼容 OpenAI 的
// 上游设 FORMATS=openai-chat。未设：四种都发布（与 2.0.0 相同），/tapeapi/v1/health 带 warning，每个隔离实例打一次控制台警告，点名该变量
// 与可选值。名字不认识：设置模式，并点名该变量。规则与 examples/new-api-sidecar 相同。未启用格式的计量路径答 400 并点名 FORMATS，不转发。
import { createAIProxy } from '@tapeapi/server/ai-proxy'
import { sig, ai } from '@tapeapi/sdk'
import { setupAnswer } from '../cloudflare-worker/worker.js'

const REQUIRED = ['CIRCUITS', 'TOKEN_ID', 'CONTAINER', 'DELEGATION_EXPIRES', 'DELEGATION_SIG', 'PUBLIC_URL']
const configured = (env) => REQUIRED.every((k) => env[k]) && !!env.SIGNER_KEY

/**
 * The adapters FORMATS selects, in ai.FORMATS order, or a sentence saying what is wrong (the same rule as
 * examples/new-api-sidecar/server.mjs selectFormats, kept inline: that file needs node:http).
 * FORMATS 选出的适配器（按 ai.FORMATS 顺序），或一句说明哪里不对的话（规则同 new-api-sidecar 的 selectFormats；那个文件依赖 node:http，故在此内联）。
 */
export function formatsOf(env) {
  const names = ai.FORMATS.map((f) => f.name)
  const choose = `choose among ${names.join(', ')} (comma-separated), or all; an upstream that is OpenAI-compatible only sets FORMATS=openai-chat`
  // Unset: every format, as 2.0.0 published; formatsWarning(env) says so. / 未设：全部格式，与 2.0.0 相同；formatsWarning 说明。
  if (!env.FORMATS) return [...ai.FORMATS]
  const asked = String(env.FORMATS).split(/[\s,]+/).filter(Boolean)
  if (!asked.length) return `FORMATS names no format: ${choose}`
  if (asked.length === 1 && asked[0].toLowerCase() === 'all') return [...ai.FORMATS]
  const unknown = asked.filter((n) => !names.includes(n))
  if (unknown.length) return `FORMATS names ${unknown.length === 1 ? 'a format' : 'formats'} this sidecar does not know (${unknown.map((n) => JSON.stringify(n)).join(', ')}): ${choose}`
  return ai.FORMATS.filter((f) => asked.includes(f.name))
}

/** The warning when FORMATS is not set (null when it is): the same sentence as examples/new-api-sidecar's.
 *  未设 FORMATS 时的警告（设了为 null），与 new-api-sidecar 同一句话。 */
export function formatsWarning(env) {
  if (env.FORMATS) return null
  const names = ai.FORMATS.map((f) => f.name).join(', ')
  return `FORMATS is not set, so every format is published and signed (${names}), as 2.0.0 did; set FORMATS to the formats your upstream really serves, comma-separated among ${names}, or all (an upstream that is OpenAI-compatible only sets FORMATS=openai-chat)`
}

export function manifestBaseOf(env) {
  return {
    tapeapi: '0.1',
    name: env.SERVICE_NAME || 'AI service (TapeAPI sidecar)',
    circuits: env.CIRCUITS,
    tokenId: String(env.TOKEN_ID),
    container: env.CONTAINER,
    delegation: { expires: Number(env.DELEGATION_EXPIRES), sig: env.DELEGATION_SIG },
    endpoints: { live: [`${env.PUBLIC_URL.replace(/\/+$/, '')}/tapeapi/v1`], async: false },
  }
}

export function build(env, extra = {}) {
  if (env.SIGNER_ADDRESS && env.SIGNER_ADDRESS.toLowerCase() !== sig.privateKeyToAddress(env.SIGNER_KEY).toLowerCase()) throw new Error(`SIGNER_ADDRESS ${env.SIGNER_ADDRESS} does not match SIGNER_KEY`)
  const formats = formatsOf(env)
  if (typeof formats === 'string') throw new Error(formats)
  let models
  try { models = JSON.parse(env.MODELS_JSON) } catch { throw new Error('MODELS_JSON must be the price table as JSON: [{ "id", "aliases"?, "formats"?, "prices": [{ "currency", "unit": "1M tokens", "input", "output", "cacheRead"?, "cacheWrite"?, "cacheWrite1h"?, "reasoning"? }] }]') }
  // A model limited to a format FORMATS leaves out, in words. / 模型限定的格式被 FORMATS 排除：用一句话说清。
  const enabled = new Set(formats.map((f) => f.name)), known = new Set(ai.FORMATS.map((f) => f.name))
  for (const [i, m] of (Array.isArray(models) ? models : []).entries()) {
    const off = Array.isArray(m?.formats) ? m.formats.filter((f) => typeof f === 'string' && known.has(f) && !enabled.has(f)) : []
    if (off.length) throw new Error(`MODELS_JSON models[${i}] (${String(m.id).slice(0, 64)}) lists ${off.join(', ')} in "formats", which FORMATS does not enable (enabled: ${[...enabled].join(', ')}); remove ${off.length === 1 ? 'it' : 'them'} from the model's "formats" or add ${off.length === 1 ? 'it' : 'them'} to FORMATS`)
  }
  return createAIProxy({
    formats,
    // A metered path of a format FORMATS leaves out: HTTP 400 naming FORMATS, never passed through without a receipt.
    // FORMATS 未启用的格式的计量路径：答 400 并点名 FORMATS，绝不无回执透传。
    refuseOtherFormats: { hint: `FORMATS does not enable it; if your upstream really serves it, add it to FORMATS (comma-separated among ${ai.FORMATS.map((f) => f.name).join(', ')}, or all)` },
    upstream: { baseUrl: env.UPSTREAM_BASE_URL, ...(env.UPSTREAM_AUTHORIZATION ? { headers: { authorization: env.UPSTREAM_AUTHORIZATION } } : {}) },
    manifestBase: manifestBaseOf(env),
    signerKey: env.SIGNER_KEY,
    models,
    // http only for a loopback PUBLIC_URL (local testing) / 只有回环地址的 PUBLIC_URL 允许 http
    allowHttp: /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(env.PUBLIC_URL),
    // Per isolate; the edge sets cf-connecting-ip and a client cannot forge it. Receipts live in the isolate too: the
    // `receipt` method finds only those this isolate signed. / 按隔离实例计；回执也存在隔离实例内，receipt 方法只能找到本实例签的。
    rateLimit: { windowMs: 60_000, free: 600, paid: 0, ip: Number(env.RATE_IP || 600) },
    ...(env.RECEIPT_TTL_S ? { receiptTtlMs: Number(env.RECEIPT_TTL_S) * 1000 } : {}),
    ...(env.RECEIPT_LOOKUPS_PER_MIN !== undefined && env.RECEIPT_LOOKUPS_PER_MIN !== '' ? { receiptRateLimit: { ip: Number(env.RECEIPT_LOOKUPS_PER_MIN), windowMs: 60_000 } } : {}),
    ...(env.RECEIPT_REQUIRE_HASH === '1' || env.RECEIPT_REQUIRE_HASH === 'true' ? { requireRequestHash: true } : {}),
    ...(env.FORWARD_SESSION_HEADERS === '0' || env.FORWARD_SESSION_HEADERS === 'false' ? { forwardSessionHeaders: false } : {}),
    ...extra,
  })
}

let proxy = null
let warnedFormats = false
export default {
  async fetch(request, env) {
    // Values pasted on a phone often carry a trailing space or newline. / 手机上粘贴的值常带尾随空白。
    env = Object.fromEntries(Object.entries(env || {}).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]))
    if (!configured(env)) return setupAnswer(env, request)
    if (!env.UPSTREAM_BASE_URL) return setupAnswer(env, request, 'UPSTREAM_BASE_URL (the /v1 base URL of your AI API) is not set')
    const formats = formatsOf(env)
    if (typeof formats === 'string') return setupAnswer(env, request, formats)
    if (!proxy) { try { proxy = build(env) } catch (e) { return setupAnswer(env, request, e.message) } }
    const res = await proxy.handleRequest(request, { clientIp: request.headers.get('cf-connecting-ip') || undefined })
    // FORMATS unset: every format, and a warning in health (and once in the log). / 未设 FORMATS：全部格式，health 带警告。
    const warning = formatsWarning(env)
    if (!warning) return res
    if (!warnedFormats) { warnedFormats = true; console.warn(`[ai-proxy] WARNING ${warning}`) }
    if (request.method !== 'GET' || new URL(request.url).pathname.replace(/\/+$/, '') !== '/tapeapi/v1/health') return res
    try { return new Response(JSON.stringify({ ...(await res.clone().json()), warning }), { status: res.status, headers: res.headers }) } catch { return res }
  },
}
