// The MCP signing proxy as a Cloudflare Worker: your MCP server stays where it is (UPSTREAM_URL); this Worker, on a
// hostname of yours, gives it a TapeOut identity, pins its tool definitions and signs every result.
// Same identity and setup mode as examples/cloudflare-worker, so the holder console works unchanged for the identity.
// MCP 签名代理的 Cloudflare Worker：你的 MCP 服务器留在原处（UPSTREAM_URL）；这个 Worker 放在你自己的主机名上，给它 TapeOut
// 身份、钉住工具定义、签名每个结果。身份与设置模式同 examples/cloudflare-worker，持有人操作台的身份部分无需改动。
//
// Secret: SIGNER_KEY (and UPSTREAM_AUTHORIZATION if your server needs one). Variables: UPSTREAM_URL, CIRCUITS,
// TOKEN_ID, CONTAINER, DELEGATION_EXPIRES, DELEGATION_SIG, PUBLIC_URL; optional TOOLS_SHA256 (the digest you published,
// so a fresh isolate does not adopt changed tools), TAPE_NAME, SERVICE_NAME, RATE_FREE.
// 密钥：SIGNER_KEY（上游需要鉴权时再加 UPSTREAM_AUTHORIZATION）。变量见上；可选 TOOLS_SHA256（你发布的摘要，新的隔离实例
// 不会因此接受被改过的工具）、TAPE_NAME、SERVICE_NAME、RATE_FREE。
import { createMcpProxy } from '@tapeapi/server/mcp-proxy'
import { sig } from '@tapeapi/sdk'
import { setupAnswer } from '../cloudflare-worker/worker.js'

const REQUIRED = ['CIRCUITS', 'TOKEN_ID', 'CONTAINER', 'DELEGATION_EXPIRES', 'DELEGATION_SIG', 'PUBLIC_URL']
const configured = (env) => REQUIRED.every((k) => env[k]) && !!env.SIGNER_KEY

export function manifestBaseOf(env) {
  return {
    tapeapi: '0.1',
    name: env.SERVICE_NAME || 'MCP server (TapeAPI proxy)',
    circuits: env.CIRCUITS,
    tokenId: String(env.TOKEN_ID),
    container: env.CONTAINER,
    delegation: { expires: Number(env.DELEGATION_EXPIRES), sig: env.DELEGATION_SIG },
    endpoints: { live: [`${env.PUBLIC_URL.replace(/\/+$/, '')}/tapeapi/v1`], async: false },
  }
}

export function build(env, extra = {}) {
  if (env.SIGNER_ADDRESS && env.SIGNER_ADDRESS.toLowerCase() !== sig.privateKeyToAddress(env.SIGNER_KEY).toLowerCase()) throw new Error(`SIGNER_ADDRESS ${env.SIGNER_ADDRESS} does not match SIGNER_KEY`)
  return createMcpProxy({
    upstream: { url: env.UPSTREAM_URL, ...(env.UPSTREAM_AUTHORIZATION ? { headers: { authorization: env.UPSTREAM_AUTHORIZATION } } : {}) },
    manifestBase: manifestBaseOf(env),
    signerKey: env.SIGNER_KEY,
    toolsSha256: env.TOOLS_SHA256 || undefined,
    name: env.TAPE_NAME || undefined,
    // LINK_CONTENT=1 puts params and results in the verify links, in clear; default: hashes only.
    // LINK_CONTENT=1 让核验链接带明文参数与结果；默认只带哈希。
    linkContent: env.LINK_CONTENT === '1',
    // http only for a loopback PUBLIC_URL (local testing) / 只有回环地址的 PUBLIC_URL 允许 http
    allowHttp: /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(env.PUBLIC_URL),
    // Per isolate; the edge sets cf-connecting-ip and a client cannot forge it. / 按隔离实例计；该头由边缘设置，客户端无法伪造。
    rateLimit: { windowMs: 60_000, free: Number(env.RATE_FREE || 600), paid: 0 },
    ...extra,
  })
}

let proxy = null
export default {
  async fetch(request, env) {
    // Values pasted on a phone often carry a trailing space or newline. / 手机上粘贴的值常带尾随空白。
    env = Object.fromEntries(Object.entries(env || {}).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]))
    if (!configured(env)) return setupAnswer(env, request)
    if (!env.UPSTREAM_URL) return setupAnswer(env, request, 'UPSTREAM_URL (the URL of your MCP server) is not set')
    // Built on the first request (no fetch at module scope in a Worker); a failed start is retried on the next one.
    // 第一个请求时构建（Worker 不能在模块作用域 fetch）；启动失败时下一个请求重试。
    if (!proxy) { try { proxy = build(env) } catch (e) { return setupAnswer(env, request, e.message) } }
    try { await proxy.ready } catch (e) { proxy = null; return setupAnswer(env, request, e.message) }
    return proxy.handleRequest(request, { clientIp: request.headers.get('cf-connecting-ip') || undefined })
  },
}
