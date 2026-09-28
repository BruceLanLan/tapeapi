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
// 密钥：SIGNER_KEY（只有上游需要你自己的而不是调用方的密钥时，再加 UPSTREAM_AUTHORIZATION）。变量见上；RECEIPT_TTL_S 为回执
// 可取回的秒数，RECEIPT_LOOKUPS_PER_MIN 为 receipt 方法每 IP 每分钟的次数，RECEIPT_REQUIRE_HASH 为 "1" 时取回执须同时给出
// requestSha256（上游 id 可猜时用，例如 Ollama）；FORWARD_SESSION_HEADERS 为 "0" 时不把客户端的会话头转发给上游（默认转发）。
import { createAIProxy } from '@tapeapi/server/ai-proxy'
import { sig } from '@tapeapi/sdk'
import { setupAnswer } from '../cloudflare-worker/worker.js'

const REQUIRED = ['CIRCUITS', 'TOKEN_ID', 'CONTAINER', 'DELEGATION_EXPIRES', 'DELEGATION_SIG', 'PUBLIC_URL']
const configured = (env) => REQUIRED.every((k) => env[k]) && !!env.SIGNER_KEY

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
  let models
  try { models = JSON.parse(env.MODELS_JSON) } catch { throw new Error('MODELS_JSON must be the price table as JSON: [{ "id", "aliases"?, "formats"?, "prices": [{ "currency", "unit": "1M tokens", "input", "output", "cacheRead"?, "cacheWrite"?, "cacheWrite1h"?, "reasoning"? }] }]') }
  return createAIProxy({
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
export default {
  async fetch(request, env) {
    // Values pasted on a phone often carry a trailing space or newline. / 手机上粘贴的值常带尾随空白。
    env = Object.fromEntries(Object.entries(env || {}).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]))
    if (!configured(env)) return setupAnswer(env, request)
    if (!env.UPSTREAM_BASE_URL) return setupAnswer(env, request, 'UPSTREAM_BASE_URL (the /v1 base URL of your AI API) is not set')
    if (!proxy) { try { proxy = build(env) } catch (e) { return setupAnswer(env, request, e.message) } }
    return proxy.handleRequest(request, { clientIp: request.headers.get('cf-connecting-ip') || undefined })
  },
}
