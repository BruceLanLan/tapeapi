// The public TapeAPI service (api.tapeapi.fun) as a Cloudflare Worker: the same identity and setup mode as
// examples/cloudflare-worker, with the free public methods of methods.js.
// 公共 TapeAPI 服务（api.tapeapi.fun）的 Cloudflare Worker：身份与设置模式同 examples/cloudflare-worker，方法见 methods.js。
//
// Secret: SIGNER_KEY. Variables: CIRCUITS, TOKEN_ID, CONTAINER, DELEGATION_EXPIRES, DELEGATION_SIG, PUBLIC_URL,
// RPC_URLS (kept across deploys by keep_vars). Adding or changing a method changes the manifest: republish it on chain
// with the holder console, step 7.
// 密钥 SIGNER_KEY；变量同上。增改方法会改变清单：用持有人操作台第 7 步重新上链。
import { createProvider } from '@tapeapi/server'
import { sig, rpcUrlsFor } from '@tapeapi/sdk'
import { setupAnswer } from '../cloudflare-worker/worker.js'
import { createChainReader } from '../_lib/chain.mjs'
import { MANIFEST_METHODS, publicMethods } from './methods.js'
import { createMcpEndpoint, MCP_PATH } from '@tapeapi/server/mcp'
import { VERSION } from '@tapeapi/server'

const REQUIRED = ['CIRCUITS', 'TOKEN_ID', 'CONTAINER', 'DELEGATION_EXPIRES', 'DELEGATION_SIG', 'PUBLIC_URL']
// The SDK's defaults: three distinct operators (NodeReal, Alchemy, 48 Club). wrangler.toml's RPC_URLS is what deploys.
// SDK 默认节点：三家不同运营方。实际部署用 wrangler.toml 的 RPC_URLS。
const DEFAULT_RPC_URLS = rpcUrlsFor(56).join(',')
const configured = (env) => REQUIRED.every((k) => env[k]) && !!env.SIGNER_KEY

export function manifestOf(env) {
  return {
    tapeapi: '0.1',
    name: env.SERVICE_NAME || 'TapeAPI Public',
    circuits: env.CIRCUITS,
    tokenId: String(env.TOKEN_ID),
    container: env.CONTAINER,
    signer: sig.privateKeyToAddress(env.SIGNER_KEY),
    delegation: { expires: Number(env.DELEGATION_EXPIRES), sig: env.DELEGATION_SIG },
    endpoints: { live: [`${env.PUBLIC_URL.replace(/\/+$/, '')}/tapeapi/v1`], async: false },
    methods: MANIFEST_METHODS,
  }
}

export function build(env) {
  const rpcUrls = (env.RPC_URLS || DEFAULT_RPC_URLS).split(',').map((u) => u.trim()).filter(Boolean)
  // 2-of-3 and a one-block lag behind the lowest head: one node down or behind still leaves a quorum.
  // 三取二，比最低链头落后一个块：一个节点宕机或落后时仍有法定数。
  // 3 s per node: healthy nodes answer in well under a second, and a hung one must not hold every call for 8 s a round
  // (a call makes up to four rounds). / 每节点 3 秒：正常节点远低于 1 秒；挂住的节点不能让每轮都等 8 秒（一次调用最多四轮）。
  const timeoutMs = Number(env.RPC_TIMEOUT_MS || 3000)
  const chain = createChainReader({ name: 'bsc', urls: rpcUrls, quorum: 2, lag: 1, timeoutMs })
  return createProvider({
    manifest: manifestOf(env),
    signerKey: env.SIGNER_KEY,
    allowHttp: /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(env.PUBLIC_URL),
    rpcUrls, quorum: 2, chainId: 56, timeoutMs,
    // The edge sets cf-connecting-ip and a client cannot forge it. / 该头由边缘设置，客户端无法伪造。
    rateLimit: { windowMs: 60_000, free: Number(env.RATE_FREE || 600), paid: Number(env.RATE_PAID || 6000) },
    methods: publicMethods(chain),
  })
}

// One log line per MCP message, for counting distinct callers (Workers observability). The caller tag is
// HMAC-SHA256(key, `${ip}|${UTC day}`) cut to 12 hex characters, with key = SHA-256("tapeapi-mcp-caller|" + SIGNER_KEY):
// never the IP itself, unlinkable across days, and not reversible by whoever reads the logs, since trying every IP needs
// the key (a plain hash of IP and day is, in hours: review MCP-R5). Without SIGNER_KEY no caller tag is logged.
// 每条 MCP 消息一行日志，用于统计不同调用方。调用方标签是 HMAC-SHA256(key, `${ip}|${UTC 日期}`) 取前 12 个十六进制字符，
// key = SHA-256("tapeapi-mcp-caller|" + SIGNER_KEY)：从不记录 IP 本身，跨天无法关联；读日志的人也无法反推，因为穷举 IP 需要
// 密钥（IP 与日期的普通哈希几小时就能穷举：审查 MCP-R5）。没有 SIGNER_KEY 时不记录调用方标签。
const enc = new TextEncoder()
const hmacKeys = new Map()   // SIGNER_KEY -> Promise<CryptoKey> / 按 SIGNER_KEY 缓存
function callerKey(signerKey) {
  let k = hmacKeys.get(signerKey)
  if (!k) {
    k = crypto.subtle.digest('SHA-256', enc.encode(`tapeapi-mcp-caller|${signerKey}`))
      .then((raw) => crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']))
    hmacKeys.set(signerKey, k)
  }
  return k
}
export async function callerTag(ip, signerKey, day = new Date().toISOString().slice(0, 10)) {
  if (!signerKey) return undefined
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', await callerKey(signerKey), enc.encode(`${ip || '-'}|${day}`)))
  return Array.from(mac.slice(0, 6), (b) => b.toString(16).padStart(2, '0')).join('')
}
function logMcp({ method, tool, clientIp }, env) {
  callerTag(clientIp, env?.SIGNER_KEY).then((caller) => console.log(JSON.stringify({ evt: 'mcp', method, tool, caller })), () => {})
}

let provider = null, mcpEndpoint = null
export default {
  async fetch(request, env) {
    // Values pasted on a phone often carry a trailing space or newline. / 手机上粘贴的值常带尾随空白。
    env = Object.fromEntries(Object.entries(env || {}).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]))
    if (!configured(env)) return setupAnswer(env, request)
    try { provider ??= build(env) } catch (e) { return setupAnswer(env, request, e.message) }
    const clientIp = request.headers.get('cf-connecting-ip') || undefined
    // /mcp: the same methods as MCP tools (remote MCP, Streamable HTTP). Not in the manifest, so adding it changed
    // nothing on chain. / /mcp：同样的方法作为 MCP 工具（远程 MCP）。不在清单里，所以加它不改链上任何东西。
    if (new URL(request.url).pathname.replace(/\/+$/, '') === MCP_PATH) {
      mcpEndpoint ??= createMcpEndpoint({ provider, manifest: provider.manifest ?? manifestOf(env), identity: { name: env.TAPE_NAME || undefined }, version: VERSION, onMessage: (m) => logMcp(m, env) })
      return mcpEndpoint.handle(request, { clientIp })
    }
    return provider.handleRequest(request, { clientIp })
  },
}
