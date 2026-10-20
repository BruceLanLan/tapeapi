// The public TapeAPI service (api.tapeapi.fun) as a Cloudflare Worker: the same identity and setup mode as
// examples/cloudflare-worker, with the free public methods of methods.js.
// 公共 TapeAPI 服务（api.tapeapi.fun）的 Cloudflare Worker：身份与设置模式同 examples/cloudflare-worker，方法见 methods.js。
//
// Secret: SIGNER_KEY. Variables: CIRCUITS, TOKEN_ID, CONTAINER, DELEGATION_EXPIRES, DELEGATION_SIG, PUBLIC_URL,
// RPC_URLS (kept across deploys by keep_vars), and, experimental, MCP_TOOLS_SHA256 (TAPI-20 §3.8, see manifestOf):
// set, the manifest adds the tool methods and declares /mcp/pinned, whose tools they are. An MCP_TOOLS_SHA256 that is
// not 64 hex digits keeps the whole service in setup mode, with a problem naming it.
// Adding or changing a method changes the manifest: republish it on chain with the holder console, step 7.
// 密钥 SIGNER_KEY；变量同上（实验性的 MCP_TOOLS_SHA256 见 manifestOf：设置后清单加上工具方法并声明 /mcp/pinned；不是 64 位十六进制时整个服务停在设置模式，problem 点名该变量）。增改方法会改变清单：用持有人操作台第 7 步重新上链。
import { createProvider } from '@tapeapi/server'
import { sig, rpcUrlsFor } from '@tapeapi/sdk'
import { setupAnswer } from '../cloudflare-worker/worker.js'
import { createChainReader } from '../_lib/chain.mjs'
import { MANIFEST_METHODS, TOOL_MANIFEST_METHODS, publicMethods, toolMethods } from './methods.js'
import { createMcpEndpoint, holdToToolsSha256, MCP_PATH } from '@tapeapi/server/mcp'
import { VERSION } from '@tapeapi/server'

const REQUIRED = ['CIRCUITS', 'TOKEN_ID', 'CONTAINER', 'DELEGATION_EXPIRES', 'DELEGATION_SIG', 'PUBLIC_URL']
// The SDK's defaults: three distinct operators (NodeReal, Alchemy, 48 Club). wrangler.toml's RPC_URLS is what deploys.
// SDK 默认节点：三家不同运营方。实际部署用 wrangler.toml 的 RPC_URLS。
const DEFAULT_RPC_URLS = rpcUrlsFor(56).join(',')
const configured = (env) => REQUIRED.every((k) => env[k]) && !!env.SIGNER_KEY
// The MCP endpoint the manifest declares (2.4, experimental): only the tool methods, whose signed results are MCP tool
// results (TAPI-20 §3.8, TAPs #16 §4.2). /mcp stays the eight REST methods as tools, as before, and is not declared.
// 清单声明的 MCP 端点（2.4，实验性）：只列工具方法，它们的签名结果就是 MCP 工具结果。/mcp 仍是八个 REST 方法的工具外观，不声明。
export const MCP_PINNED_PATH = '/mcp/pinned'
const TOOL_NAMES = new Set(TOOL_MANIFEST_METHODS.map((m) => m.name))
const baseUrl = (env) => env.PUBLIC_URL.replace(/\/+$/, '')

// MCP_TOOLS_SHA256 as the holder published it: 64 hex digits, lowercased here (TAPI-20 §3.8 writes lowercase; a value
// copied in capitals is the same digest). Unset or empty: null. Anything else (a 0x prefix, a wrong length, other
// characters) is an Error naming the variable and the form it needs: build() turns it into setup mode, so the operator
// reads which variable is wrong in /tapeapi/v1/health and in every refusal (review E-5).
// 持有人发布的 MCP_TOOLS_SHA256：64 位十六进制，这里转小写（§3.8 写小写；照抄成大写的是同一个摘要）。未设或为空：null。其它形状
// （带 0x、长度不对、别的字符）抛出点名该变量与所需格式的错误：build() 把它变成设置模式，运营者在健康检查与每个拒绝里都能看到是哪个变量错了。
export function mcpToolsSha256Of(env) {
  const v = env?.MCP_TOOLS_SHA256
  const t = typeof v === 'string' ? v.trim() : v
  if (t === undefined || t === null || t === '') return null
  if (typeof t === 'string' && /^[0-9a-fA-F]{64}$/.test(t)) return t.toLowerCase()
  const got = typeof t !== 'string' ? typeof t : `${t.length} characters${/^0x/i.test(t) ? ' starting with 0x' : ''}`
  throw new Error(`MCP_TOOLS_SHA256 must be the toolsSha256 the holder published: 64 hex digits, without 0x (got ${got})`)
}

export function manifestOf(env) {
  const toolsSha256 = mcpToolsSha256Of(env)
  return {
    tapeapi: '0.1',
    name: env.SERVICE_NAME || 'TapeAPI Public',
    circuits: env.CIRCUITS,
    tokenId: String(env.TOKEN_ID),
    container: env.CONTAINER,
    signer: sig.privateKeyToAddress(env.SIGNER_KEY),
    delegation: { expires: Number(env.DELEGATION_EXPIRES), sig: env.DELEGATION_SIG },
    endpoints: { live: [`${baseUrl(env)}/tapeapi/v1`], async: false },
    // TAPI-20 §3.8 (2.4, experimental): only once MCP_TOOLS_SHA256 is set, to the toolsSha256 the holder publishes (taken
    // lowercased, see mcpToolsSha256Of), the tool methods follow the REST ones and `mcp` names /mcp/pinned (the console
    // computes the digest from it; mcpToolsSha256(mcpToolsManifestOf(env)) gives the same). Without it the manifest is
    // exactly what it was.
    // 只有设置了 MCP_TOOLS_SHA256（持有人发布的 toolsSha256，按 mcpToolsSha256Of 转小写）才在 REST 方法之后加上工具方法，并以
    // `mcp` 声明 /mcp/pinned（控制台从该端点算摘要；mcpToolsSha256(mcpToolsManifestOf(env)) 结果相同）。不设置时清单与以前完全相同。
    methods: toolsSha256 ? [...MANIFEST_METHODS, ...TOOL_MANIFEST_METHODS] : MANIFEST_METHODS,
    ...(toolsSha256 ? { mcp: { endpoint: `${baseUrl(env)}${MCP_PINNED_PATH}`, toolsSha256 } } : {}),
  }
}

// The manifest as each MCP endpoint sees it: tools come from a manifest's name, container and methods only
// (createMcpEndpoint), so a view with the REST methods gives /mcp exactly its 2.3 tools, and one with the tool methods
// gives /mcp/pinned's. / 每个 MCP 端点看到的清单：工具只由清单的 name、container 与 methods 生成，所以只含 REST 方法的视图给出
// /mcp 在 2.3 的工具，只含工具方法的视图给出 /mcp/pinned 的工具。
const restView = (m) => ({ ...m, methods: m.methods.filter((x) => !TOOL_NAMES.has(x.name)) })
const toolView = (m) => ({ ...m, methods: m.methods.filter((x) => TOOL_NAMES.has(x.name)) })
/**
 * @experimental (2.4) The manifest view whose tools /mcp/pinned serves: its mcpToolsSha256 (@tapeapi/server/mcp) is
 * the toolsSha256 to publish. It does not depend on MCP_TOOLS_SHA256 itself. / /mcp/pinned 所提供工具对应的清单视图：
 * 它的 mcpToolsSha256 就是要发布的 toolsSha256，与 MCP_TOOLS_SHA256 本身无关（不自指）。
 */
export function mcpToolsManifestOf(env) {
  const { mcp, ...m } = manifestOf({ ...env, MCP_TOOLS_SHA256: '' })
  return { ...m, methods: TOOL_MANIFEST_METHODS }
}

export function build(env) {
  const rpcUrls = (env.RPC_URLS || DEFAULT_RPC_URLS).split(',').map((u) => u.trim()).filter(Boolean)
  // 2-of-3 and a one-block lag behind the lowest head: one node down or behind still leaves a quorum.
  // 三取二，比最低链头落后一个块：一个节点宕机或落后时仍有法定数。
  // 3 s per node: healthy nodes answer in well under a second, and a hung one must not hold every call for 8 s a read. A
  // call makes several reads in a row (pinning the block takes up to three, then the method's own eth_calls), each up to
  // 2 + rpcRetries rounds: since 2.3 the SDK asks a read again, at most twice by default, after a round that failed by the
  // network in less than 2 s (never after a timeout), which adds at most about 5.2 s to a failing read. createProvider's
  // and the chain reader's option rpcRetries (0 turns it off) is left at the SDK's default here.
  // 每节点 3 秒：正常节点远低于 1 秒；挂住的节点不能让每次读取都等 8 秒。一次调用要连续做几次读取（钉块至多三次，再加方法自己的
  // eth_call），每次读取至多 2 + rpcRetries 轮：自 2.3 起，某轮在 2 秒内只因网络故障失败时，SDK 会把该读取再问（默认至多两次；
  // 超时从不重试），一次失败的读取至多多花约 5.2 秒。createProvider 与读链层的 rpcRetries 选项（0 关闭）这里保持 SDK 默认。
  const timeoutMs = Number(env.RPC_TIMEOUT_MS || 3000)
  const chain = createChainReader({ name: 'bsc', urls: rpcUrls, quorum: 2, lag: 1, timeoutMs })
  const manifest = manifestOf(env)
  // With MCP_TOOLS_SHA256 set, the tool methods are added and held to it (TAPI-20 §3.8; TAPs #16 §5.1): if a deploy
  // changes their tool text (a tool method description, SERVICE_NAME, the case of CONTAINER, the wording of
  // @tapeapi/server or the SDK), they answer a signed TOOLS_CHANGED (409), on /tapeapi/v1 and /mcp/pinned alike, until
  // the holder publishes the new digest; while their tool list cannot be built, they answer TOOLS_CHANGED with current
  // null and the next call reads it again (holdToToolsSha256). Only the tool methods are handed to holdToToolsSha256:
  // the REST methods are not tools of /mcp/pinned and are never held, not even while that list cannot be built.
  // 设置了 MCP_TOOLS_SHA256 时加上工具方法，并让它们受该值约束：部署改动了它们的工具文本（工具方法说明、SERVICE_NAME、CONTAINER
  // 的大小写、@tapeapi/server 或 SDK 的措辞）后，它们在 /tapeapi/v1 与 /mcp/pinned 上一律回答签名的 TOOLS_CHANGED（409），直到
  // 持有人发布新的摘要；工具列表建不出来时，它们回答 TOOLS_CHANGED（current 为 null），下一次调用重新读取。只把工具方法交给
  // holdToToolsSha256：REST 方法不是 /mcp/pinned 的工具，从不受约束，列表建不出来时也一样。
  const published = mcpToolsSha256Of(env)
  const rest = publicMethods(chain)
  const methods = published ? { ...rest, ...holdToToolsSha256(toolMethods(rest), { manifest: toolView(manifest), published }) } : rest
  return createProvider({
    manifest,
    signerKey: env.SIGNER_KEY,
    allowHttp: /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(env.PUBLIC_URL),
    rpcUrls, quorum: 2, chainId: 56, rpcTimeoutMs: timeoutMs,
    // The edge sets cf-connecting-ip and a client cannot forge it. / 该头由边缘设置，客户端无法伪造。
    rateLimit: { windowMs: 60_000, free: Number(env.RATE_FREE || 600), paid: Number(env.RATE_PAID || 6000) },
    methods,
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

let provider = null, mcpEndpoint = null, pinnedEndpoint = null
export default {
  async fetch(request, env) {
    // Values pasted on a phone often carry a trailing space or newline. / 手机上粘贴的值常带尾随空白。
    env = Object.fromEntries(Object.entries(env || {}).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]))
    if (!configured(env)) return setupAnswer(env, request)
    try { provider ??= build(env) } catch (e) { return setupAnswer(env, request, e.message) }
    const clientIp = request.headers.get('cf-connecting-ip') || undefined
    const path = new URL(request.url).pathname.replace(/\/+$/, '')
    // /mcp: the REST methods as MCP tools (remote MCP, Streamable HTTP), exactly as before; never declared in the manifest.
    // /mcp：REST 方法作为 MCP 工具（远程 MCP），与以前完全相同；从不在清单里声明。
    if (path === MCP_PATH) {
      mcpEndpoint ??= createMcpEndpoint({ provider, manifest: restView(provider.manifest ?? manifestOf(env)), name: env.TAPE_NAME || undefined, version: VERSION, onMessage: (m) => logMcp(m, env) })
      return mcpEndpoint.handleRequest(request, { clientIp })
    }
    // /mcp/pinned (2.4, experimental): the tool methods, only while MCP_TOOLS_SHA256 is set; the manifest declares it.
    // /mcp/pinned（2.4，实验性）：工具方法，只在设置了 MCP_TOOLS_SHA256 时提供；清单声明的就是它。
    if (path === MCP_PINNED_PATH && mcpToolsSha256Of(env)) {
      pinnedEndpoint ??= createMcpEndpoint({ provider, manifest: toolView(provider.manifest ?? manifestOf(env)), name: env.TAPE_NAME || undefined, version: VERSION, mcpResults: true, onMessage: (m) => logMcp(m, env) })
      return pinnedEndpoint.handleRequest(request, { clientIp })
    }
    return provider.handleRequest(request, { clientIp })
  },
}
