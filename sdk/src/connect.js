// @experimental `tapeapi connect` as data and text, for the command line and a web page alike: resolve an AI service,
// describe it (the "service card"), say why it cannot be used when it cannot, and give client settings only for the API
// formats its manifest declares (ai.snippetsFor). No Node-only import: the same module can run in a browser. Outside
// the compatibility promise.
// 实验性：把 tapeapi connect 做成数据与文本，命令行与网页共用：解析 AI 服务、描述它（服务卡片）、不可用时说明原因，并且只为其清单
// 声明的格式给出客户端配置。不引用仅限 Node 的模块，浏览器里同样可用。不受兼容承诺约束。
import { snippetsFor, SNIPPET_TOOLS, MANIFEST_FIELD, FORMATS } from './ai.js'
import { chainById } from './chains.js'
import { manifestToTools } from './webmcp.js'

export { snippetsFor, SNIPPET_TOOLS }

const T = (en, zh) => Object.freeze({ en, zh })
/** @experimental The fixed sentences every card carries. / 每张卡片都带的固定句子。 */
export const NOTES = Object.freeze({
  receipt: T('A receipt proves who signed which request and response bytes and what usage and price were claimed; it does not prove which model ran.',
    '回执证明谁签了哪些请求与回答字节、声称了多少用量与价格；不证明实际运行的是哪个模型。'),
  prices: T("Prices are the provider's public statement on chain, per 1M tokens; USD is for display only; nothing is settled here.",
    '价目是服务方的链上公开声明（每百万 token）；USD 仅作展示；这里不结算。'),
  boundary: T('Experimental, outside the compatibility promise. It reads the chain and the manifest only: it sends no transaction, asks for no key or password, uploads nothing and pays nothing.',
    '实验性，不受兼容承诺约束。只读链与清单：不发交易、不索要任何密钥或密码、不上传任何东西、不付款。'),
  token: T('API_KEY: the token you got from the provider, set in your own environment; this command never asks for it and never prints it.',
    'API_KEY：你在服务方取得的令牌，设在你自己的环境里；本命令从不索要它，也从不显示它。'),
})

// Why a service cannot be used, per TAP status. / 服务不可用的原因（按 TAP 状态）。
const NOT_FOUND = T('no TapeOut circuit answers to this name or address', '没有与这个名字或地址对应的 TapeOut 电路')
const BAD_MANIFEST = T('its manifest is not valid (see the detail)', '它的清单无效（见详情）')
const WHY = {
  unpaid: T('the name is not activated, or its payment ran out (TAP-10 §6.3): a TAP-11 client does not resolve it, and its receipts cannot be checked',
    '名字未激活或付费已到期（TAP-10 §6.3）：按 TAP-11 的客户端不解析它，它的回执也无法核验'),
  'not-opened': T('its container has not been opened (TAP-10 §6.2): nothing published under it can be read',
    '它的容器尚未开通（TAP-10 §6.2）：其下发布的内容都无法读取'),
  'store-changed': T('a TapeOut contract it depends on (the site store or the payment contract) runs an implementation this SDK does not accept (TAP-10 §6.1): nothing is read until the SDK is updated',
    '它依赖的 TapeOut 合约（站点存储或付费合约）运行着本 SDK 不接受的实现（TAP-10 §6.1）：SDK 更新之前不读取'),
  'no-manifest': T('nothing is published under it (no /.well-known/tapeapi.json)', '它下面没有发布任何服务（没有 /.well-known/tapeapi.json）'),
  'manifest-invalid': BAD_MANIFEST, incomplete: BAD_MANIFEST, 'no-hash': BAD_MANIFEST,
  'delegation-invalid': T('its delegation does not verify: the holder did not authorise this signer, or the authorisation expired',
    '它的委托核验不通过：持有人没有授权这个签名钥匙，或授权已过期'),
  'not-tapeout': NOT_FOUND, 'no-such-token': NOT_FOUND, 'no-such-cpu': NOT_FOUND,
  'not-ai': T('its manifest has no ai field and no MCP tool declaration (mcp, TAPI-20 §3.8): it is neither an AI service nor an MCP tool service',
    '它的清单没有 ai 字段，也没有 MCP 工具声明（mcp，TAPI-20 §3.8）：既不是 AI 服务，也不是 MCP 工具服务'),
  'mcp-invalid': T('its mcp field is invalid (see the detail)', '它的 mcp 字段无效（见详情）'),
  'ai-invalid': T('its ai field is invalid (see the detail)', '它的 ai 字段无效（见详情）'),
  unavailable: T('the chain or the service could not be read: nothing was decided', '链或服务读不到：无法判定'),
  'stale-block': T('the nodes answered with an old block: nothing was decided', '节点给出的区块过旧：无法判定'),
}
// Exit 3 ("could not be read, nothing decided") for the codes tapeapi-doctor counts as undecided (doctor.js `undecided`),
// PROVIDER_UNAVAILABLE among them: a --dev manifest that cannot be reached is not an answer (FIXED B-5).
// 退出码 3（读不到、无法判定）对应 tapeapi-doctor 视为无法判定的错误码，包括 PROVIDER_UNAVAILABLE：连不上的 --dev 清单不是答案。
const STATUS_OF_CODE = { DELEGATION_INVALID: 'delegation-invalid', MANIFEST_INVALID: 'manifest-invalid', NOT_FOUND: 'not-tapeout', RPC_UNAVAILABLE: 'unavailable', QUORUM_FAILED: 'unavailable', RPC_ERROR: 'unavailable', RPC_DISAGREE: 'unavailable', PROVIDER_UNAVAILABLE: 'unavailable' }
const RETRY_CODES = new Set(['RPC_UNAVAILABLE', 'QUORUM_FAILED', 'RPC_ERROR', 'RPC_DISAGREE', 'PROVIDER_UNAVAILABLE', 'TIMEOUT', 'NETWORK'])
const RETRY_STATUS = new Set(['unavailable', 'stale-block'])
const NET_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'])
const TOOL_LABEL = { 'openai-sdk': 'OpenAI SDK', curl: 'curl', codex: 'Codex', 'claude-code': 'Claude Code', 'claude-desktop': 'Claude Desktop' }
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o?.[k] !== undefined && o?.[k] !== null).map((k) => [k, o[k]]))

/**
 * @experimental Resolve `target` with `api` and describe it. Never throws for a service that cannot be used: the
 * result says why (`status`, `reason`, `detail`) and which exit status the command line gives (0 usable; 1 unavailable;
 * 2 a usage mistake, e.g. --tool names a format the manifest does not declare; 3 could not be read (the chain, or the
 * --dev manifest), run it again).
 * @experimental 用 api 解析 target 并描述它。服务不可用时不抛错：结果说明原因与命令行的退出码。
 * @param {string} target  a TapeOut name or a container address (ignored with `dev`)
 * @param {{ api: object, dev?: string|null, tool?: string, format?: string, port?: number, proxyCommand?: string }} o
 */
export async function connectReport(target, { api, dev = null, tool = 'all', format, port = 8790, proxyCommand, version } = {}) {
  const r = { target: dev ?? target, dev: !!dev, resolution: dev ? 'dev' : 'tap10', ok: false, exitCode: 1, status: null, reason: null, detail: null, service: null, formats: [], snippets: [], kind: null }
  let svc
  try {
    svc = await api.resolve(dev ? { dev } : target)
  } catch (e) {
    const tape = e?.name === 'TapeAPIError'
    const net = !tape && (NET_CODES.has(e?.cause?.code ?? e?.code) || /fetch failed/i.test(String(e?.message)))
    if (!tape && !net) throw e
    const status = (tape && (e.data?.status ?? STATUS_OF_CODE[e.code])) || (net ? 'unavailable' : String(e.code ?? 'error').toLowerCase())
    r.status = status
    r.detail = String(e?.message ?? e)
    r.exitCode = net || RETRY_CODES.has(e.code) || RETRY_STATUS.has(status) ? 3 : e.code === 'INVALID_ARGUMENT' ? 2 : 1
    r.reason = WHY[status] ?? T(r.detail, r.detail)
    const d = e?.data ?? {}
    if (d.container || d.holder) r.service = { tapeName: d.name ?? null, chainId: d.chainId ?? null, chain: chainById(d.chainId ?? 56)?.name ?? null, ...pick(d, ['container', 'holder']) }
    return r
  }
  const field = svc.manifest?.[MANIFEST_FIELD]
  const c = svc.conform ?? {}
  const chainId = svc.chainId ?? c.chainId ?? 56
  r.service = {
    name: typeof svc.manifest?.name === 'string' ? svc.manifest.name : null, tapeName: c.name ?? (dev ? null : target), chainId, chain: chainById(chainId)?.name ?? `chain ${chainId}`,
    container: svc.container ?? null, holder: svc.verified?.holder ?? c.holder ?? null, signer: svc.manifest?.signer ?? null,
    delegationExpires: Number.isSafeInteger(svc.manifest?.delegation?.expires) ? svc.manifest.delegation.expires : null,
    activation: c.activation ? { ...c.activation } : null, endpoints: [], models: [],
  }
  if (svc.aiProblems) { r.status = 'ai-invalid'; r.reason = WHY['ai-invalid']; r.detail = svc.aiProblems.join('; '); return r }
  if (!field) {
    if (svc.manifest?.mcp === undefined) { r.status = 'not-ai'; r.reason = WHY['not-ai']; return r }
    return mcpReport(r, svc, { target, dev, tool, format, version })
  }
  r.kind = 'ai'
  r.service.endpoints = field.endpoints.map((e) => ({ format: e.format, baseUrl: e.baseUrl }))
  r.service.models = field.models.map((m) => ({ id: m.id, ...(m.aliases ? { aliases: [...m.aliases] } : {}), ...(m.formats ? { formats: [...m.formats] } : {}), prices: m.prices.map((p) => ({ ...p })) }))
  r.formats = r.service.endpoints.map((e) => e.format)
  const missing = (need, label) => {
    r.exitCode = 2; r.status = 'not-declared'
    r.reason = T(`this service's manifest does not declare ${need.join(' or ')}, so no ${label} settings are generated`, `该服务的清单没有声明 ${need.join(' 或 ')}，所以不生成 ${label} 的配置`)
    return r
  }
  if (tool === 'claude-desktop') return missing(['mcp'], TOOL_LABEL[tool])
  if (tool && tool !== 'all' && !SNIPPET_TOOLS[tool].some((f) => r.formats.includes(f))) return missing(SNIPPET_TOOLS[tool], TOOL_LABEL[tool])
  if (format && !r.formats.includes(format)) return missing([format], format)
  r.snippets = snippetsFor(svc.manifest, { target, dev, port, proxyCommand, tool, format })
  r.ok = true; r.exitCode = 0; r.status = 'ok'
  return r
}

/** @experimental The format names this SDK knows. / 本 SDK 认得的格式名。 */
export const FORMAT_NAMES = Object.freeze(FORMATS.map((f) => f.name))

// ---------------------------------------------------------------------------------------------------------------
// MCP tool services (TAPI-20 §3.8), @experimental / MCP 工具服务（TAPI-20 §3.8），实验性
// ---------------------------------------------------------------------------------------------------------------
// A service whose manifest has no `ai` field but carries `mcp: { endpoint, toolsSha256 }` is an MCP tool service: its
// methods are the tools of an MCP server behind a signing proxy. Only that declaration counts (a /mcp route a server
// happens to answer is not in the manifest and is never guessed at), and nothing is fetched from the endpoint. The methods
// shown are those tapeapi-mcp can offer: the manifest's free methods (it offers no priced method), as manifestToTools
// lists them without a paid policy. A method is a tool only when the endpoint's tools/list has a tool of its name (the
// MCP tools draft, TAPs #16 §4.1: bound), which tapeapi-mcp checks, with the list's digest against mcp.toolsSha256; a
// manifest may bind only some of its methods (2.4), so the card calls them methods and does not count tools. The --json
// key stays service.tools (2.3) with the same meaning: these candidate methods.
// 清单没有 ai 字段、但带 mcp: { endpoint, toolsSha256 } 的服务是 MCP 工具服务：它的方法就是签名代理后面那个 MCP 服务器的工具。
// 只认这个声明（服务器碰巧应答的 /mcp 路由不在清单里，从不猜测），也不访问端点。显示的方法是 tapeapi-mcp 能提供的那些：清单里的
// 免费方法（它不提供收费方法），即不带 paid 策略时 manifestToTools 列出的方法。方法只有在端点的 tools/list 里有同名工具时才是工具
// （MCP 工具草案 TAPs #16 §4.1：绑定），这由 tapeapi-mcp 检查，同时用列表的摘要核对 mcp.toolsSha256；清单可以只绑定部分方法（2.4），
// 所以卡片称之为方法、不数工具。--json 的键仍是 service.tools（2.3），含义相同：这些候选方法。

/** @experimental The tools an MCP settings snippet is written for. / MCP 配置片段面向的工具。 */
export const MCP_SNIPPET_TOOLS = Object.freeze(['claude-code', 'claude-desktop'])
/** @experimental The fixed sentences of an MCP tool service's card. / MCP 工具服务卡片的固定句子。 */
export const MCP_NOTES = Object.freeze({
  receipt: T('A receipt proves which service key signed which request and answer, and when; it does not prove which program produced the answer, or that it is right.',
    '回执证明哪个服务钥匙在何时签了哪个请求与回答；不证明回答由哪个程序产生，也不证明回答正确。'),
  tools: T('The methods shown are the manifest\'s free methods (tapeapi-mcp offers no priced method). Which of them are tools is decided by tools/list at the endpoint, pinned on chain by mcp.toolsSha256; this command does not contact the endpoint, so it does not say which or how many. tapeapi-mcp reads tools/list, refuses the service if it does not hash to toolsSha256, and offers a method only if the list has a tool of that name.',
    '上面列的是清单里的免费方法（tapeapi-mcp 不提供收费方法）。其中哪些是工具，由端点的 tools/list 决定，并由链上的 mcp.toolsSha256 钉住；本命令不访问端点，所以不说是哪些、有几个。tapeapi-mcp 读取 tools/list，摘要与 toolsSha256 不符即拒绝该服务，且只提供列表里有同名工具的方法。'),
  boundary: NOTES.boundary,
})
// 64 lowercase hex digits, as TAPI-20 §3.8, the MCP tools draft (TAPs #16 §2) and the holder console write it (2.3).
// 64 位小写十六进制，与 TAPI-20 §3.8、MCP 工具草案（TAPs #16 §2）和持有人操作台一致（2.3）。
const SHA256_RE = /^[0-9a-f]{64}$/
/** Why a manifest's `mcp` field cannot be used (null when it can), as tapeapi-mcp decides it. / mcp 字段为何不能用（与 tapeapi-mcp 一致）。 */
function mcpFieldProblem(m, dev) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return 'mcp must be an object { endpoint, toolsSha256 }'
  if (typeof m.toolsSha256 !== 'string' || !SHA256_RE.test(m.toolsSha256)) return 'mcp.toolsSha256 must be 64 lowercase hex characters'
  if (typeof m.endpoint !== 'string' || m.endpoint.length > 2048) return 'mcp.endpoint must be a URL'
  let u
  try { u = new URL(m.endpoint) } catch { return 'mcp.endpoint must be a URL' }
  if (u.username || u.password) return 'mcp.endpoint must not carry credentials'
  if (u.search || u.hash) return 'mcp.endpoint must have no query or fragment'
  if (u.protocol === 'https:') return null
  if (u.protocol === 'http:' && u.hostname === '127.0.0.1') return dev ? null : 'mcp.endpoint must be https (http://127.0.0.1 only with --dev)'
  return 'mcp.endpoint must be https'
}
const shq = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`)
/** The server name the snippets give the service in the client's config. / 片段在客户端配置里给服务起的名字。 */
const serverNameOf = (target, dev) => (dev ? 'tapeapi-dev' : /^0x[0-9a-fA-F]{40}$/.test(String(target)) ? `tapeapi-${String(target).slice(2, 10).toLowerCase()}` : `tapeapi-${String(target ?? 'service').replace(/\.tape$/i, '').replace(/[^A-Za-z0-9]+/g, '-')}`)

/**
 * @experimental MCP client settings for an MCP tool service, only from its manifest's `mcp` field: Claude Code and
 * Claude Desktop through tapeapi-mcp (stdio; every answer checked on this machine, the tools pinned), then the declared
 * Streamable HTTP endpoint direct (not checked here). No key is needed or written. Pure (no I/O); [] without a usable
 * `mcp` field. `version`: the SDK release whose package npx runs.
 * @experimental MCP 工具服务的 MCP 客户端配置，只按清单的 mcp 字段生成：先是经 tapeapi-mcp（stdio，每个回答在本机核验、工具钉住）的
 * Claude Code 与 Claude Desktop，再是声明的 Streamable HTTP 端点直连（这里不核验）。不需要也不写任何密钥。纯函数。
 * @param {object} manifest
 * @param {{ target?: string, dev?: string|null, version?: string, tool?: string }} [o]
 * @returns {{ tool: string, format: 'mcp', via: 'stdio'|'direct', verifies: boolean, title: { en: string, zh: string }, text: string }[]}
 */
export function mcpSnippetsFor(manifest, { target = '<name>', dev = null, version = '<version>', tool = 'all' } = {}) {
  const m = manifest?.mcp
  if (manifest?.[MANIFEST_FIELD] !== undefined || mcpFieldProblem(m, dev)) return []
  const endpoint = m.endpoint
  const srv = serverNameOf(target, dev)
  const args = ['-y', `--package=https://github.com/BruceLanLan/tapeapi/releases/download/v${version}/tapeapi-sdk-${version}.tgz`, 'tapeapi-mcp', ...(dev ? ['--dev', dev] : [target])]
  const out = []
  const add = (t, via, en, zh, text) => out.push({ tool: t, format: 'mcp', via, verifies: via !== 'direct', title: { en, zh }, text })
  add('claude-code', 'stdio', 'Claude Code, through tapeapi-mcp (stdio: every answer checked on this machine, the tools pinned)', 'Claude Code，经 tapeapi-mcp（stdio：每个回答在本机核验，工具钉住）',
    `claude mcp add ${shq(srv)} -- npx ${args.map(shq).join(' ')}`)
  add('claude-desktop', 'stdio', 'Claude Desktop, through tapeapi-mcp (claude_desktop_config.json: Settings > Developer > Edit Config)', 'Claude Desktop，经 tapeapi-mcp（claude_desktop_config.json：设置 > 开发者 > 编辑配置）',
    JSON.stringify({ mcpServers: { [srv]: { command: 'npx', args } } }, null, 2))
  // Direct: a tools/call sent to the endpoint is not a call under the MCP tools draft (TAPs #16 §4.2): its answer is not
  // a signed envelope, and a client must not present it as signed or verified. Only tapeapi-mcp (above) checks answers.
  // 直连：发给端点的 tools/call 不是 MCP 工具草案（TAPs #16 §4.2）意义上的调用：回答不是签名信封，客户端不得当作已签名或已核验。
  // 只有经 tapeapi-mcp（上面）才核验回答。
  add('claude-code', 'direct', 'Claude Code, the declared endpoint direct (MCP Streamable HTTP): not checked here; a direct answer is not a signed envelope, do not treat it as signed or verified (only tapeapi-mcp, above, checks answers)', 'Claude Code，直连声明的端点（MCP Streamable HTTP）：这里不核验；直连的回答不是签名信封，不要当作已签名或已核验（只有经上面的 tapeapi-mcp 才核验回答）',
    `claude mcp add --transport http ${shq(srv)} ${shq(endpoint)}`)
  add('claude-desktop', 'direct', 'Claude Desktop, the declared endpoint direct (Settings > Connectors > Add custom connector): not checked here; a direct answer is not a signed envelope, do not treat it as signed or verified', 'Claude Desktop，直连声明的端点（设置 > 连接器 > 添加自定义连接器）：这里不核验；直连的回答不是签名信封，不要当作已签名或已核验',
    `Name: ${srv}\nURL: ${endpoint}`)
  return tool && tool !== 'all' ? out.filter((x) => x.tool === tool) : out
}

// The MCP half of connectReport: the card fields, the gate, the settings. / connectReport 的 MCP 部分。
function mcpReport(r, svc, { target, dev, tool, format, version }) {
  const problem = mcpFieldProblem(svc.manifest.mcp, dev)
  if (problem) { r.status = 'mcp-invalid'; r.reason = WHY['mcp-invalid']; r.detail = problem; return r }
  r.kind = 'mcp'
  const { endpoint, toolsSha256 } = svc.manifest.mcp
  r.service.mcp = { endpoint, toolsSha256: toolsSha256.toLowerCase() }
  // the free methods, as tapeapi-mcp generates its tools (review R-3) / 免费方法，与 tapeapi-mcp 生成工具的方式相同（审查 R-3）
  r.service.tools = Array.isArray(svc.manifest.methods) ? manifestToTools(svc.manifest, { prefix: '' }).tools.map((t) => t.method) : []
  const missing = (need, label) => {
    r.exitCode = 2; r.status = 'not-declared'
    r.reason = T(`this service's manifest does not declare ${need.join(' or ')}, so no ${label} settings are generated`, `该服务的清单没有声明 ${need.join(' 或 ')}，所以不生成 ${label} 的配置`)
    return r
  }
  if (tool && tool !== 'all' && !MCP_SNIPPET_TOOLS.includes(tool)) return missing(SNIPPET_TOOLS[tool], TOOL_LABEL[tool])
  if (format) return missing([format], format)
  r.snippets = mcpSnippetsFor(svc.manifest, { target, dev, version, tool })
  r.ok = true; r.exitCode = 0; r.status = 'ok'
  return r
}

/**
 * @experimental The service card as terminal text (no trailing newline). `lang`: 'en' | 'zh' | 'both' (English line, then
 * Chinese); `color`: ANSI colors on the status words and headings only, so that removing them gives the uncolored text;
 * `now`: Unix seconds, for the days left; `next`: the command for the last line (any exit status other than 0).
 * @experimental 服务卡片的终端文本。lang 为 en / zh / both；color 只给状态词与小标题上色，去色后与无色文本相同；next 为最后一行的命令。
 */
export function renderConnect(r, { lang = 'both', color = false, version = '', now = Math.floor(Date.now() / 1000), next = null, nextHint = null } = {}) {
  const L = (en, zh) => (lang === 'en' ? en : lang === 'zh' ? zh : `${en} / ${zh}`)
  const P = (t) => (lang === 'en' ? [t.en] : lang === 'zh' ? [t.zh] : [t.en, t.zh])
  const paint = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s)
  const red = paint('31'), green = paint('32'), yellow = paint('33'), bold = paint('1')
  const out = []
  // Columns by display width: a CJK character takes two cells. / 按显示宽度对齐：中日韩字符占两格。
  const cells = (t) => [...t].reduce((n, ch) => n + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1), 0)
  const indent = lang === 'en' ? 14 : lang === 'zh' ? 12 : 22
  const row = (label, value) => out.push(`${label}${' '.repeat(Math.max(1, indent - cells(label)))}${value}`)
  const cont = (value) => out.push(`${' '.repeat(indent)}${value}`)
  const s = r.service
  out.push(`tapeapi connect ${version} (${L('experimental', '实验性')})`)
  out.push(r.dev ? L('resolution: development (--dev): the identity is NOT checked on chain', '解析：开发模式（--dev）：不在链上核对身份')
    : L("resolution: TAP-10 / TAP-11 (conform: 'tap10')", "解析：TAP-10 / TAP-11（conform: 'tap10'）"))
  out.push('')
  if (s) {
    row(L('service', '服务'), [s.name !== null && s.name !== undefined ? JSON.stringify(s.name) : null, s.tapeName, r.dev ? r.target : s.chain].filter(Boolean).join('   '))
    if (s.container) row(L('container', '容器'), s.container)
    if (s.holder) row(L('holder', '持有人'), s.holder)
    if (s.signer) {
      const d = s.delegationExpires
      const days = d === null || d === undefined ? null : Math.floor((d - now) / 86_400)
      row(L('signer', '签名钥匙'), `${s.signer}${days === null ? '' : `   ${L('delegation until', '委托到')} ${new Date(d * 1000).toISOString().slice(0, 10)} (${days} ${L('days', '天')})`}`)
    }
    if (s.activation) row(L('activation', '激活'), s.activation.live ? `${L('active', '已激活')} (${s.activation.isLive ? 'isLive' : 'isContainerLive'})` : red(L('not active', '未激活')))
  } else {
    row(L('service', '服务'), r.target)
  }
  if (!r.ok && r.status !== 'not-declared') {
    const en = `${r.exitCode === 3 ? 'COULD NOT BE READ' : r.exitCode === 2 ? 'NOT USED' : 'UNAVAILABLE'}: ${r.status} — ${r.reason.en}`
    const zh = `${r.exitCode === 3 ? '读不到' : r.exitCode === 2 ? '未使用' : '不可用'}：${r.status} —— ${r.reason.zh}`
    if (lang === 'zh') row(L('status', '状态'), red(zh))
    else { row(L('status', '状态'), red(en)); if (lang === 'both') cont(red(zh)) }
    if (r.detail && r.detail !== r.reason.en) row(L('detail', '详情'), r.detail)
    row(L('snippets', '配置片段'), L('not generated: the service cannot be used (above)', '不生成：服务无法使用（见上）'))
  } else if (s && r.kind === 'mcp') {
    row(L('status', '状态'), green(L('usable: an MCP tool service (experimental)', '可用：MCP 工具服务（实验性）')))
    row(L('mcp', 'MCP 端点'), `${s.mcp.endpoint}   (${L('MCP Streamable HTTP, as the manifest declares', 'MCP Streamable HTTP，按清单声明')})`)
    const n = s.tools.length
    // methods, not tools: which free methods are tools only tools/list at the endpoint says (TAPI-20 §3.8), and this
    // command does not read it (2.4). / 是方法，不是工具：哪些免费方法是工具只有端点的 tools/list 说了算，本命令不读取它（2.4）。
    row(L('methods', '方法'), `${n} (${L("the manifest's free methods; the tools are the ones tools/list names", '清单里的免费方法；工具是其中 tools/list 列出的')})   toolsSha256 ${s.mcp.toolsSha256.slice(0, 8)}…`)
    if (n) cont(`${s.tools.slice(0, 10).join(', ')}${n > 10 ? `  … ${L(`${n - 10} more (--json lists all)`, `另有 ${n - 10} 个（--json 列出全部）`)}` : ''}`)
    out.push('')
    out.push(...P(MCP_NOTES.receipt), ...P(MCP_NOTES.tools))
    out.push('')
    if (r.status === 'not-declared') {
      row(L('snippets', '配置片段'), `${L('not generated', '不生成')}: ${lang === 'zh' ? r.reason.zh : r.reason.en}`)
      if (lang === 'both') cont(r.reason.zh)
    } else {
      out.push(`${bold(L('configure your MCP client', '配置你的 MCP 客户端'))}   (${L("this service's manifest declares mcp: an endpoint and toolsSha256", '该服务的清单声明了 mcp：端点与 toolsSha256')})`)
      for (const sn of r.snippets) {
        out.push(`  ${sn.verifies ? '' : yellow('! ')}${L(sn.title.en, sn.title.zh)}:`)
        for (const line of sn.text.split('\n')) out.push(`    ${line}`)
      }
    }
    out.push(...P(MCP_NOTES.boundary))
  } else if (s && s.endpoints.length) {
    row(L('status', '状态'), green(L('usable', '可用')))
    s.endpoints.forEach((e, i) => (i ? cont : (v) => row(L('formats', '格式'), v))(`${e.format} -> ${e.baseUrl}`))
    row(L('models', '模型'), r.dev ? L('per 1M tokens, as the local manifest says', '每百万 token，按本地清单') : L('per 1M tokens, as published on chain', '每百万 token，按链上声明'))
    const shown = s.models.slice(0, 10)
    const w = Math.min(40, Math.max(...shown.map((m) => m.id.length)))
    for (const m of shown) {
      const p = m.prices[0]
      const extra = ['cacheRead', 'cacheWrite', 'reasoning'].filter((k) => p[k] !== undefined).map((k) => `${k} ${p[k]}`)
      out.push(`  ${m.id.padEnd(w)}  ${p.currency.padEnd(4)}  in ${p.input}  out ${p.output}${extra.length ? `  ${extra.join('  ')}` : ''}${m.prices.length > 1 ? `  (+${m.prices.length - 1} ${L('currencies', '种币种')})` : ''}${m.aliases ? `  ${L('aliases', '别名')} ${m.aliases.join(', ')}` : ''}`)
    }
    if (s.models.length > shown.length) out.push(`  … ${L(`${s.models.length - shown.length} more (--json lists all)`, `另有 ${s.models.length - shown.length} 个（--json 列出全部）`)}`)
    out.push('')
    out.push(...P(NOTES.receipt), ...P(NOTES.prices))
    out.push('')
    const decl = r.formats.length === 1 ? L(`this service's manifest declares ${r.formats[0]} only`, `该服务的清单只声明了 ${r.formats[0]}`) : L(`this service's manifest declares ${r.formats.join(', ')}`, `该服务的清单声明了 ${r.formats.join('、')}`)
    if (r.status === 'not-declared') {
      row(L('snippets', '配置片段'), `${L('not generated', '不生成')}: ${lang === 'zh' ? r.reason.zh : r.reason.en}`)
      if (lang === 'both') cont(r.reason.zh)
    } else {
      out.push(`${bold(L('configure your client', '配置你的客户端'))}   (${decl})`)
      for (const sn of r.snippets) {
        out.push(`  ${sn.verifies ? '' : yellow('! ')}${L(sn.title.en, sn.title.zh)}:`)
        for (const line of sn.text.split('\n')) out.push(`    ${line}`)
      }
      out.push(...P(NOTES.token))
    }
    out.push(...P(NOTES.boundary))
  }
  if (r.exitCode !== 0 && next) {
    if (nextHint) out.push(L(nextHint.en, nextHint.zh))
    out.push(`${bold(L('next:', '下一条命令:'))} ${next}`)
  }
  return out.join('\n')
}
