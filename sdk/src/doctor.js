// @experimental The provider-side diagnosis behind tapeapi-doctor (sdk/bin/tapeapi-doctor.js): given a TapeOut name, a
// container address or the URL of a signing sidecar, check in order everything an AI service needs before its users can
// verify receipts, and say for every check what passed or failed, why, and what to do next, in English and Chinese.
// Not part of the package's exports yet (only the CLI and the repository's tools import it); the shape may change.
// @experimental tapeapi-doctor 背后的服务方诊断：给一个 TapeOut 名字、容器地址或签名旁路的地址，按顺序检查 AI 服务在用户能核验
// 回执之前需要的一切，并对每一项用中英双语说明通过或失败、原因、下一步做什么。尚未进入包的导出（只有命令行与仓库工具引用它），形状可能变化。
//
// Order / 顺序:  name -> circuit -> container -> manifest-file -> manifest-format -> delegation -> ai-field -> prices ->
//                endpoints -> reach -> cors -> receipt -> receipt-lookup
// A check that cannot run because an earlier one failed is `skip`, naming that one; it never fails in its turn.
// 前面某项失败导致无法运行的检查记为 skip 并写明依赖哪一项，不会跟着失败。
//
// The receipt check costs nothing when the gateway checks keys: it sends one minimal request per endpoint with a key that
// cannot be valid. The gateway refuses it (HTTP 401) and the sidecar signs a receipt for that refusal too (TAP-21 §3.5:
// status, complete false, no usage, no price), which is enough to prove the whole path: the base URL reaches the sidecar,
// the sidecar signs with the delegated key, and the receipt verifies against the manifest. A gateway that accepts ANY key
// answers it instead, at the operator's cost: a few input tokens and 1 output token (16 for openai-responses, whose
// minimum is 16) per endpoint, and the check warns about that gateway. `key` (the operator's own key) adds one real call
// per endpoint, the same size, at whatever the operator's gateway charges for it. That key is sent only to the host being
// checked (the URL given, or the hosts of the manifest's signed endpoints.live for a name or container), only over https
// (plain http only to a loopback host with allowHttp), and it is replaced by *** in every text the report carries.
// 网关会校验密钥时回执检查不花钱：每个端点发一个最小请求，带一个不可能有效的密钥。网关拒绝（HTTP 401），旁路对这个拒绝同样签回执
// （TAP-21 §3.5：有 status、complete 为 false、没有用量与价格），这足以证明整条路径：base URL 到达旁路、旁路用受委托的密钥签名、
// 回执能按清单核验。网关若接受**任意**密钥，就会真的作答，费用由运营者承担：每个端点几个输入 token 加 1 个输出 token
// （openai-responses 为 16 个，这是它的下限），检查也会就此警告。给了 key（运营者自己的密钥）时每个端点再做一次同样大小的真实调用，
// 费用按运营者自己的网关计。这把密钥只发往被检查的主机（给出的 URL；名字或容器则为清单中已签名的 endpoints.live 的主机），只走 https
// （仅对回环地址且显式 allowHttp 时允许 http），并在报告携带的每段文字里替换为 ***。

import { TapeAPIError, validateManifest, safeParseJSON, parseTapeName, CHAINS, MANIFEST_PATH, MANIFEST_KEY, canonicalJSON } from './index.js'
import * as ai from './ai.js'
import { delegationDigest, recoverAddress } from './sig.js'
import { sha256 } from '@noble/hashes/sha256'
import { toHex, hexToBytes } from './abi.js'

export const DOCTOR_CHECKS = Object.freeze(['name', 'circuit', 'container', 'manifest-file', 'manifest-format', 'delegation', 'ai-field', 'prices', 'endpoints', 'reach', 'cors', 'receipt', 'receipt-lookup'])
/** A delegation with fewer days left than this is a warning (the sidecars log RENEW from the same point). / 少于这么多天即警告。 */
export const RENEW_DAYS = 30
export const INVALID_KEY = 'sk-tapeapi-doctor-invalid-key-0000000000'
const MAX_DELEGATION_S = 366 * 86_400
const ZERO = '0x0000000000000000000000000000000000000000'
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])$/
const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()
const T = (en, zh) => ({ en, zh })

// Commands the hints point to. Until tapeapi-doctor ships in a release, it runs from a checkout of the repository.
// 提示里给出的命令。tapeapi-doctor 进入发布包之前，从仓库检出里运行。
export const CMD = Object.freeze({
  doctor: (t) => `node sdk/bin/tapeapi-doctor.js ${t}`,
  trial: 'node examples/relay-trial/trial.mjs',
  console: 'https://tapeapi.fun/console/',
  tapeout: 'https://tapeout.net',
})

const TITLES = {
  name: T('Name resolves to a processor', '名字能解析到处理器'),
  circuit: T('Circuit exists (has a holder)', '电路存在（有持有人）'),
  container: T('Container is opened', '容器已开通'),
  'manifest-file': T('Manifest file on chain', '链上有清单文件'),
  'manifest-format': T('Manifest format (TAP-20)', '清单格式合规（TAP-20）'),
  delegation: T('Delegation valid', '委托有效'),
  'ai-field': T('ai field (TAP-20 §3.9)', 'ai 字段（TAP-20 §3.9）'),
  prices: T('Price table', '价目表'),
  endpoints: T('AI endpoints', 'AI 端点'),
  reach: T('Endpoint reachable (TLS, sidecar ready)', '端点可访问（TLS、旁路就绪）'),
  cors: T('CORS for browser clients', '浏览器跨域（CORS）'),
  receipt: T('A real request gets a verifiable receipt', '真实请求拿到可核验的回执'),
  'receipt-lookup': T('Receipt lookup by id (free method)', '按 id 取回执（免费方法）'),
}

// Metered path and the smallest request body per format; the model is filled in. / 每种格式的计量路径与最小请求体。
const PROBES = {
  'openai-chat': { path: '/v1/chat/completions', body: (model) => ({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }) },
  'openai-responses': { path: '/v1/responses', body: (model) => ({ model, input: 'ping', max_output_tokens: 16 }) },
  'anthropic-messages': { path: '/v1/messages', body: (model) => ({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }) },
  'openai-embeddings': { path: '/v1/embeddings', body: (model) => ({ model, input: 'ping' }) },
}
const authHeaders = (format, key) => (format === 'anthropic-messages' ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : { authorization: `Bearer ${key}` })
const corsWants = (format) => (format === 'anthropic-messages' ? ['x-api-key', 'anthropic-version', 'content-type'] : ['authorization', 'content-type'])

const isRevert = (e) => e instanceof TapeAPIError && e.code === 'RPC_ERROR' && /revert/i.test(e.message)
// An answer from the chain decides; anything else (nodes down, nodes disagreeing) does not. / 链上的回答才算定论。
const undecided = (e) => !(e instanceof TapeAPIError) || ['RPC_UNAVAILABLE', 'RPC_DISAGREE', 'RPC_ERROR', 'TIMEOUT', 'PROVIDER_UNAVAILABLE'].includes(e.code)

// Price hints (the holder console's, per 1M tokens): they warn, never refuse. / 价目表提示（与持有人操作台一致）：只警告不拒绝。
const HUGE = { USDT: '1000', USDC: '1000', USD1: '1000', USD: '1000', BNB: '2', ETH: '0.5', BEM: '100000' }
const units = (s) => { const [i, f = ''] = String(s).split('.'); return BigInt(i + (f + '00000000').slice(0, 8)) }
export function priceHints(field) {
  const out = []
  const usd = []
  for (const m of field.models) {
    const emb = Array.isArray(m.formats) && m.formats.length === 1 && m.formats[0] === 'openai-embeddings'
    for (const p of m.prices) {
      if (p.currency === 'USD') usd.push(m.id)
      for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h', 'reasoning']) {
        if (p[k] === undefined) continue
        const u = units(p[k])
        if (u === 0n && !(k === 'output' && emb)) out.push(T(`${m.id}: the ${p.currency} ${k} price is 0 (free)`, `${m.id} 的 ${p.currency} ${k} 价格为 0（免费）`))
        if (HUGE[p.currency] && u > units(HUGE[p.currency])) out.push(T(`${m.id}: the ${p.currency} ${k} price ${p[k]} per 1M tokens is above ${HUGE[p.currency]}: a missing decimal point?`, `${m.id} 的 ${p.currency} ${k} 价格 ${p[k]}（每 1M tokens）高于 ${HUGE[p.currency]}：是不是漏了小数点？`))
      }
      if (!emb && units(p.output) < units(p.input)) out.push(T(`${m.id}: the ${p.currency} output price ${p.output} is below the input price ${p.input}: swapped?`, `${m.id} 的 ${p.currency} 输出价 ${p.output} 低于输入价 ${p.input}：是不是填反了？`))
      if (p.cacheRead !== undefined && units(p.cacheRead) > units(p.input)) out.push(T(`${m.id}: the ${p.currency} cache-read price is above the input price`, `${m.id} 的 ${p.currency} 缓存读价高于输入价`))
    }
  }
  if (usd.length) out.push({ ...T(`USD prices are for display only (no token stands behind them): ${[...new Set(usd)].slice(0, 5).join(', ')}`, `USD 价格只作展示（背后没有代币）：${[...new Set(usd)].slice(0, 5).join('、')}`), info: true })
  return out
}

// A network failure, in words an operator can act on. / 网络失败，用运营者能照着做的话说出来。
export function netProblem(e, host) {
  const code = e?.cause?.code || e?.code || ''
  const msg = String(e?.cause?.message || e?.message || e)
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return { code: 'TIMEOUT', why: T(`${host} did not answer in time`, `${host} 没有按时回答`), fix: T('Check that the sidecar runs and that your reverse proxy forwards to it (and does not buffer).', '检查旁路在运行，反向代理转发到了它（且没有开缓冲）。') }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return { code, why: T(`the host name ${host} does not resolve (DNS)`, `域名 ${host} 解析不到（DNS）`), fix: T('Add the DNS record for this host, or publish the host you actually use.', '为这个域名加 DNS 记录，或发布你实际使用的域名。') }
  if (code === 'ECONNREFUSED') return { code, why: T(`${host} refused the connection`, `${host} 拒绝连接`), fix: T('Start the sidecar, or point your reverse proxy at it (default 127.0.0.1:8080).', '启动旁路，或把反向代理指向它（默认 127.0.0.1:8080）。') }
  if (/CERT|SSL|TLS|self.signed|altname/i.test(code + ' ' + msg)) return { code: code || 'TLS', why: T(`TLS to ${host} failed: ${code || msg}`, `到 ${host} 的 TLS 失败：${code || msg}`), fix: T('Install a valid certificate for this exact host name in your reverse proxy (Caddy and 1Panel can issue one automatically).', '在反向代理里为这个确切的域名装有效证书（Caddy、1Panel 可以自动签发）。') }
  return { code: code || 'NETWORK', why: T(`${host} could not be reached: ${msg}`, `无法访问 ${host}：${msg}`), fix: T('Check the host, the port and your firewall.', '检查域名、端口和防火墙。') }
}
// A failure worth retrying (review DOCR-3): no answer in time, a refused connection, DNS, a reset. A TLS failure is a
// configuration problem and stays a failure. / 值得重试的失败：超时、拒绝连接、DNS、连接被重置。TLS 失败是配置问题，仍算失败。
const TRANSIENT = new Set(['TIMEOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'NETWORK', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET'])
export const isTransient = (p) => TRANSIENT.has(p.code)

/**
 * Every form in which a gateway could echo `key` back (review DOCR-1): as given, trimmed, without a "Bearer " prefix,
 * JSON-escaped, URL-encoded and base64. Shorter than 8 characters is not redacted (it would blank ordinary words).
 * 网关可能回显密钥的各种形式：原样、去空白、去掉 "Bearer " 前缀、JSON 转义、URL 编码、base64。短于 8 个字符的不替换（会误伤普通词）。
 */
export function secretForms(key) {
  if (typeof key !== 'string' || !key) return []
  const bare = key.trim().replace(/^bearer\s+/i, '').trim()
  const out = new Set()
  for (const k of [key, key.trim(), bare]) {
    out.add(k); out.add(JSON.stringify(k).slice(1, -1)); out.add(encodeURIComponent(k))
    out.add(Buffer.from(k).toString('base64')); out.add(Buffer.from(k).toString('base64').replace(/=+$/, ''))
  }
  return [...out].filter((x) => x.length >= 8).sort((a, b) => b.length - a.length)
}
/** Replace every form of `key` in every string of `value` (deeply) by ***. / 把 value 中所有字符串里的密钥（各种形式）替换为 ***。 */
export function redactSecret(value, key) {
  const forms = secretForms(key)
  if (!forms.length) return value
  const text = (t) => { let o = t; for (const f of forms) o = o.split(f).join('***'); return o }
  const walk = (v) => (typeof v === 'string' ? text(v) : Array.isArray(v) ? v.map(walk) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v)
  return walk(value)
}

/**
 * Diagnose a service. / 诊断一个服务。
 * @param {string} input  a TapeOut name, a container address, or an http(s) URL of a sidecar (its root or its manifest)
 * @param {object} o
 * @param {object} [o.api]       a createTapeAPI() client (with rpcUrls) for the chain reads; none: URL mode offline only
 * @param {Function} [o.fetch]   for the HTTP checks (default globalThis.fetch)
 * @param {boolean} [o.offline]  URL mode: do not read the chain (a local or throwaway identity)
 * @param {string} [o.key]       the operator's own API key: one real call per endpoint (costs what the gateway charges)
 * @param {string} [o.model]     the model for the probe requests (default: the first model of each format)
 * @param {string} [o.origin]    Origin for the CORS preflight
 * @param {boolean} [o.allowHttp]  accept http endpoints (tests, loopback); with `key`, also lets the key go over plain http
 *                                 to a loopback host (the CLI's --allow-http), and nowhere else
 * @param {number} [o.timeoutMs=15000]
 * @param {() => number} [o.now]  seconds
 * @param {(check: object) => void} [o.onCheck]  called as each check completes
 * @returns {Promise<{ target: string, mode: 'name'|'container'|'url', ok: boolean, exitCode: number, counts: object, checks: object[], manifest: object|null }>}
 */
export async function diagnose(input, o = {}) {
  const fetchImpl = o.fetch ?? globalThis.fetch.bind(globalThis)
  const now = o.now ?? (() => Math.floor(Date.now() / 1000))
  const timeoutMs = o.timeoutMs ?? 15_000
  const origin = o.origin ?? 'https://example.org'
  const checks = []
  const done = new Map()   // id -> status / 各项结果
  // Every text that enters the report passes here, so the operator's key never does, whatever a gateway echoes (DOCR-1)
  // 进入报告的每段文字都经过这里，无论网关回显什么，运营者的密钥都不会进入报告
  const add = (id, status, detail, extra = {}) => {
    const c = redactSecret({ id, status, title: TITLES[id], detail: detail ?? '', ...extra }, o.key)
    checks.push(c); done.set(id, status); o.onCheck?.(c); return c
  }
  const pass = (id, detail, extra) => add(id, 'pass', detail, extra)
  const warn = (id, detail, fix, extra) => add(id, 'warn', detail, { fix, ...extra })
  const fail = (id, detail, fix, next, extra) => add(id, 'fail', detail, { fix, ...(next ? { next } : {}), ...extra })
  const skip = (id, why) => add(id, 'skip', why)
  // a network failure worth retrying: undecided (exit 3), with the network hint / 值得重试的网络失败：未判定（退出码 3），附网络提示
  const retry = (id, detail, fix) => add(id, 'error', `could not decide: ${detail}`, { fix: T(`${fix.en} This is a network failure: run the doctor again (exit code 3 means: retry).`, `${fix.zh} 这是网络故障：重新运行诊断（退出码 3 表示：重试）。`) })
  const error = (id, e) => add(id, 'error', `could not decide: ${e?.code ? `${e.code} ` : ''}${e?.message || e}`, { fix: T('The chain or the network could not be read; run the doctor again (exit code 3 means: retry).', '链或网络读不到；重新运行诊断（退出码 3 表示：重试）。') })
  const firstNotPassed = () => [...done].find(([, s]) => s !== 'pass' && s !== 'skip')?.[0]
  const blocked = (ids, by) => { for (const id of ids) skip(id, `not checked: "${by}" did not pass / 未检查："${by}" 未通过`) }
  const http = async (url, init = {}) => fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), ...init })
  const host = (u) => { try { return new URL(u).host } catch { return String(u) } }

  let mode, manifest = null, chainId = 56, capi = o.api ?? null, identity = null, served = null, allowHttp = !!o.allowHttp
  const trialHint = T(`No service of your own yet? Run the local trial first (no key, no circuit, no cost): ${CMD.trial}`, `还没有自己的服务？先跑本地试跑（不需要密钥、电路，也不花钱）：${CMD.trial}`)

  // ------------------------------------------------------------------ target / 目标
  const parsed = parseTapeName(input)
  if (parsed && !parsed.error) { mode = 'name'; chainId = parsed.chainId }
  else if (ADDRESS_RE.test(input)) mode = 'container'
  else if (/^https?:\/\//i.test(input)) mode = 'url'
  else throw new TapeAPIError('INVALID_ARGUMENT', parsed?.error ?? `${String(input).slice(0, 80)} is not a TapeOut name (42.1013.tape), a container address (0x...) or a sidecar URL (https://...)`)
  if (mode !== 'url' && !capi) throw new TapeAPIError('INVALID_ARGUMENT', 'a name or a container needs a chain client (api)')
  if (capi && mode === 'name' && typeof capi.forChain === 'function') capi = capi.forChain(chainId)

  const IDENTITY = ['circuit', 'container', 'manifest-file', 'manifest-format', 'delegation']
  const SERVICE = ['ai-field', 'prices', 'endpoints', 'reach', 'cors', 'receipt', 'receipt-lookup']

  // ------------------------------------------------------------------ on-chain identity / 链上身份
  async function chainIdentity({ circuits, tokenId, container: expected }) {
    // circuit / 电路
    let holder
    try { holder = await capi.chain.ownerOf(circuits, tokenId) } catch (e) {
      if (isRevert(e)) {
        fail('circuit', `circuit #${tokenId} of ${circuits} has not been minted: ownerOf reverts`, T(`Tape out a circuit on ${CMD.tapeout} (you buy it; the price is TapeOut's), then use its name. The documentation's 42.1013.tape is an example name.`, `在 ${CMD.tapeout} 购买一枚电路（由你自己购买，价格以 TapeOut 为准），再用它的名字。文档里的 42.1013.tape 只是示例名。`), CMD.trial, { hint: trialHint })
        return false
      }
      error('circuit', e); return false
    }
    pass('circuit', `holder ${holder}`)
    // container / 容器
    let container, code
    try { container = await capi.chain.accountOf(circuits, tokenId); code = await capi.rpc.call('eth_getCode', [container, 'latest']) } catch (e) { error('container', e); return false }
    if (expected && !eq(expected, container)) { fail('container', `hub.accountOf(${circuits}, ${tokenId}) is ${container}, the manifest names ${expected}`, T('The manifest names another container: publish the manifest the console builds for this circuit (step 5).', '清单写的是别的容器：发布操作台为这枚电路生成的清单（第 5 步）。'), CMD.console); return false }
    if (!code || /^0x0*$/i.test(code)) {
      fail('container', `container ${container} has no code: it has not been opened`, T(`Open the circuit's container on ${CMD.tapeout} (a one-time on-chain transaction; you pay its gas). Then run: ${CMD.doctor(input)}`, `在 ${CMD.tapeout} 开通这枚电路的容器（一次链上交易，gas 由你支付）。然后运行：${CMD.doctor(input)}`), CMD.doctor(input))
      return false
    }
    pass('container', `${container}${CHAINS[chainId] ? ` on ${CHAINS[chainId].name}` : ''}`)
    identity = { circuits, tokenId: String(tokenId), container, holder }
    return true
  }

  async function chainManifestFile(container) {
    let info
    try { info = await capi.chain.fileInfo(container, MANIFEST_KEY) } catch (e) { error('manifest-file', e); return null }
    if (Number(info.size) === 0) return { missing: true }
    if (!info.sha256Hash || /^0x0*$/.test(info.sha256Hash)) return { problem: `${MANIFEST_PATH} has no on-chain SHA-256 (fileInfo.sha256Hash is zero)` }
    let bytes
    try { bytes = hexToBytes(await capi.chain.readFile(container, MANIFEST_KEY)) } catch (e) { if (isRevert(e)) return { missing: true }; error('manifest-file', e); return null }
    const digest = toHex(sha256(bytes))
    if (bytes.length !== Number(info.size)) return { problem: `read ${bytes.length} bytes, fileInfo.size declares ${info.size}` }
    if (digest !== String(info.sha256Hash).toLowerCase()) return { problem: `sha256 of the bytes is ${digest}, fileInfo declares ${info.sha256Hash}` }
    return { bytes, size: bytes.length }
  }

  const publishFix = T(`Publish the sidecar's manifest on chain: holder console ${CMD.console} step 5 (one transaction; you pay its gas).`, `把旁路的清单发布上链：持有人操作台 ${CMD.console} 第 5 步（一笔交易，gas 由你支付）。`)

  // The delegation's expiry, as a verdict not yet recorded: the signature check that follows may still fail it.
  // 委托到期情况，作为尚未记录的结论：随后的签名检查仍可能判它失败。
  function delegationExpiry(m) {
    if (!m.delegation) return { status: 'fail', detail: 'no delegation', fix: T('Sign the delegation: console step 4.', '签委托：操作台第 4 步。') }
    const left = Number(m.delegation.expires) - now()
    const days = Math.floor(left / 86_400)
    const until = new Date(Number(m.delegation.expires) * 1000).toISOString().slice(0, 10)
    const renew = T(`Renew: console step 4 "Renew" (same service key), set DELEGATION_EXPIRES and DELEGATION_SIG, restart the sidecar, publish again (step 5).`, '续期：操作台第 4 步“续期”（服务密钥不变），填入新的 DELEGATION_EXPIRES 与 DELEGATION_SIG，重启旁路，再发布一次（第 5 步）。')
    if (left <= 0) return { status: 'fail', detail: `expired on ${until}`, fix: renew }
    if (left > MAX_DELEGATION_S) return { status: 'fail', detail: `expires ${until}, more than 366 days ahead: clients refuse it (TAP-20 §3.4)`, fix: T('Sign a delegation of at most 366 days (the console signs 90).', '签一份不超过 366 天的委托（操作台签 90 天）。') }
    if (days < RENEW_DAYS) return { status: 'warn', detail: `${days} day(s) left, until ${until}`, fix: renew, days }
    return { status: 'pass', detail: `${days} days left, until ${until}`, days }
  }
  const record = (d, more = '') => (d.status === 'fail' ? fail('delegation', d.detail + more, d.fix, CMD.console) : d.status === 'warn' ? warn('delegation', d.detail + more, d.fix) : pass('delegation', d.detail + more))
  const resignFix = T('Sign the delegation again with the wallet that holds the circuit: console step 4, then set DELEGATION_EXPIRES and DELEGATION_SIG, restart the sidecar and publish again (step 5).', '用持有电路的钱包重签委托：操作台第 4 步，然后填入 DELEGATION_EXPIRES 与 DELEGATION_SIG，重启旁路，再发布一次（第 5 步）。')
  // The SDK's resolve() is the final word on the delegation (ECDSA or EIP-1271, holder on chain). / 委托以 SDK 的 resolve() 为准。
  async function delegationByResolve(d, target) {
    try { return { svc: await capi.resolve(target) } } catch (e) {
      if (e instanceof TapeAPIError && e.code === 'DELEGATION_INVALID') fail('delegation', e.message, resignFix, CMD.console)
      else if (undecided(e)) error('delegation', e)
      else fail('delegation', e.message, publishFix, CMD.console)
      return null
    }
  }


  if (mode === 'name' || mode === 'container') {
    // name / 名字
    let circuits, tokenId
    if (mode === 'name') {
      try { circuits = await capi.chain.cpuAt(parsed.processor) } catch (e) {
        if (e instanceof TapeAPIError && e.code === 'NOT_FOUND') fail('name', `${parsed.name}: processor ${parsed.processor} does not exist on ${CHAINS[chainId]?.name ?? `chain ${chainId}`}`, T('Check the name: <#ID>.<processor>.tape, as tapeout.net shows it.', '检查名字：<#ID>.<处理器>.tape，以 tapeout.net 显示的为准。'))
        else error('name', e)
        blocked([...IDENTITY, ...SERVICE], 'name')
        return finish()
      }
      tokenId = BigInt(parsed.tokenId)
      pass('name', `${parsed.name} -> processor ${parsed.processor} = ${circuits} on ${CHAINS[chainId]?.name ?? `chain ${chainId}`}`)
    } else {
      try {
        // An ERC-6551 address commits to its chain: find the one on which it answers token(). / 容器地址包含链号：找到它所在的链。
        const where = typeof capi.chainOfContainer === 'function' ? await capi.chainOfContainer(input) : chainId
        if (where === null) throw new TapeAPIError('NOT_FOUND', 'no supported chain has a container at this address (not a container, or not opened yet)')
        chainId = Number(where)
        if (typeof capi.forChain === 'function') capi = capi.forChain(chainId)
        const tok = await capi.chain.tokenOf(input)
        circuits = tok.circuits; tokenId = tok.tokenId
      } catch (e) {
        if (e instanceof TapeAPIError && (e.code === 'NOT_FOUND' || e.code === 'CHANNEL_INVALID')) fail('name', `${input} is not a TapeOut container on this chain (${e.message})`, T('Use the TapeOut name of your circuit (as tapeout.net shows it) instead.', '改用你的电路的 TapeOut 名字（以 tapeout.net 显示的为准）。'))
        else error('name', e)
        blocked([...IDENTITY, ...SERVICE], 'name')
        return finish()
      }
      pass('name', `container ${input} belongs to circuit #${tokenId} of ${circuits}`)
    }
    if (!(await chainIdentity({ circuits, tokenId }))) { const by = firstNotPassed(); blocked(IDENTITY.filter((x) => !done.has(x)), by); blocked(SERVICE, by); return finish() }
    // manifest file / 清单文件
    const file = await chainManifestFile(identity.container)
    if (!file) { blocked(['manifest-format', 'delegation', ...SERVICE], 'manifest-file'); return finish() }
    if (file.missing) {
      fail('manifest-file', `no file at ${MANIFEST_PATH} for ${identity.container}`, publishFix, CMD.trial, { hint: trialHint })
      blocked(['manifest-format', 'delegation', ...SERVICE], 'manifest-file'); return finish()
    }
    if (file.problem) { fail('manifest-file', file.problem, publishFix); blocked(['manifest-format', 'delegation', ...SERVICE], 'manifest-file'); return finish() }
    pass('manifest-file', `${file.size} bytes, SHA-256 matches the SiteRegistry index`)
    // manifest format / 清单格式
    try {
      const raw = safeParseJSON(new TextDecoder().decode(file.bytes), { code: 'MANIFEST_INVALID' })
      manifest = validateManifest(raw, { requireDelegation: true, allowHttp })
      if (!eq(manifest.container, identity.container)) throw new TapeAPIError('MANIFEST_INVALID', `manifest.container ${manifest.container} is not the container ${identity.container}`)
      if (!eq(manifest.circuits, circuits) || String(manifest.tokenId) !== String(tokenId)) throw new TapeAPIError('MANIFEST_INVALID', `manifest names circuit #${manifest.tokenId} of ${manifest.circuits}, not #${tokenId} of ${circuits}`)
      manifest = { ...manifest, ...(raw[ai.MANIFEST_FIELD] !== undefined ? { [ai.MANIFEST_FIELD]: raw[ai.MANIFEST_FIELD] } : {}) }
    } catch (e) {
      fail('manifest-format', e.message, T(`Republish the manifest the sidecar serves (console step 5); the console checks it before asking your wallet.`, '重新发布旁路提供的清单（操作台第 5 步）；操作台会在请求钱包之前检查它。'), CMD.console)
      blocked(['delegation', ...SERVICE], 'manifest-format'); return finish()
    }
    pass('manifest-format', `"${String(manifest.name).slice(0, 60)}", signer ${manifest.signer}, ${manifest.methods.length} method(s)`)
    // delegation: expiry arithmetic, then the SDK's own resolve() as the final word / 委托：先算到期，再以 SDK 的 resolve() 为准
    const d = delegationExpiry(manifest)
    if (d.status === 'fail') { record(d); blocked(SERVICE, 'delegation'); return finish() }
    const got = await delegationByResolve(d, mode === 'name' ? parsed.name : input)
    if (!got) { blocked(SERVICE, 'delegation'); return finish() }
    record(d, `; signed by the holder ${got.svc.verified?.holder ?? identity.holder}`)
    // resolve() drops an invalid ai field; keep the published one so the next check can say what is wrong with it.
    // resolve() 会丢弃无效的 ai 字段；保留发布的那份，下一项才能说出它哪里不对。
    manifest = got.svc.aiProblems ? { ...got.svc.manifest, [ai.MANIFEST_FIELD]: manifest[ai.MANIFEST_FIELD] } : got.svc.manifest
  } else {
    // ---------------------------------------------------------------- URL mode / 地址模式
    let url = input.replace(/\/+$/, '')
    const manifestUrl = /\.json$/i.test(url) ? url : url + MANIFEST_PATH
    try { if (LOOPBACK.test(new URL(url).hostname)) allowHttp = true } catch { throw new TapeAPIError('INVALID_ARGUMENT', `${input} is not a URL`) }
    skip('name', 'URL mode: a sidecar address, no name / 地址模式：旁路地址，没有名字')
    let res
    try { res = await http(manifestUrl, { headers: { accept: 'application/json' } }) } catch (e) {
      const p = netProblem(e, host(manifestUrl))
      if (isTransient(p)) retry('manifest-format', `${manifestUrl}: ${p.why.en}`, p.fix)
      else fail('manifest-format', `${manifestUrl}: ${p.why.en}`, p.fix, CMD.trial, { hint: trialHint })
      blocked(['circuit', 'container', 'manifest-file', 'delegation', ...SERVICE], 'manifest-format'); return finish()
    }
    let text = ''
    try { text = await res.text() } catch { /* empty */ }
    if (res.status !== 200) {
      // A sidecar in setup mode answers 503 for its manifest and names what is missing in its health check.
      // 设置模式下的旁路对清单回 503，并在 health 里列出缺了什么。
      let h = null
      try { h = await (await http(url.replace(/\/\.well-known\/tapeapi\.json$/i, '') + '/tapeapi/v1/health', { headers: { accept: 'application/json' } })).json() } catch { /* not a sidecar, or not reachable */ }
      if (h?.setup) {
        fail('manifest-format', `the sidecar is in SETUP MODE: ${h.problem || `missing ${(h.missing || []).join(', ')}`}${h.signer ? `; its signing address is ${h.signer}` : ''}`,
          T(`Normal before the identity is complete. Set what is missing in .env (the holder console ${CMD.console} gives the values: step 3 the service key, step 4 the delegation, which reads the signing address from this sidecar), then restart the sidecar.`, `身份补齐之前这是正常的。在 .env 里补上缺的变量（持有人操作台 ${CMD.console} 给出这些值：第 3 步服务密钥，第 4 步委托，它从这个旁路读取签名地址），然后重启旁路。`), CMD.doctor(input))
        blocked(['circuit', 'container', 'manifest-file', 'delegation', ...SERVICE], 'manifest-format'); return finish()
      }
      fail('manifest-format', `${manifestUrl}: HTTP ${res.status}${res.status >= 300 && res.status < 400 ? ` (a redirect to ${res.headers.get('location')})` : ''}`, T('Serve the sidecar at this address (the sidecar serves its manifest at /.well-known/tapeapi.json); a redirect is not followed.', '在这个地址上运行旁路（旁路在 /.well-known/tapeapi.json 提供清单）；重定向不会被跟随。'), CMD.trial)
      blocked(['circuit', 'container', 'manifest-file', 'delegation', ...SERVICE], 'manifest-format'); return finish()
    }
    let raw
    try { raw = safeParseJSON(text, { code: 'MANIFEST_INVALID' }); manifest = validateManifest(raw, { requireDelegation: false, allowHttp }); manifest = { ...manifest, ...(raw[ai.MANIFEST_FIELD] !== undefined ? { [ai.MANIFEST_FIELD]: raw[ai.MANIFEST_FIELD] } : {}) } } catch (e) {
      fail('manifest-format', `${manifestUrl}: ${e.message}`, T('Fix the variables the sidecar reports in its log and in /tapeapi/v1/health, then restart it.', '按旁路日志与 /tapeapi/v1/health 报告的问题改正环境变量，然后重启旁路。'))
      blocked(['circuit', 'container', 'manifest-file', 'delegation', ...SERVICE], 'manifest-format'); return finish()
    }
    served = raw
    pass('manifest-format', `served by ${host(manifestUrl)}: "${String(manifest.name).slice(0, 60)}", signer ${manifest.signer}`)
    const throwaway = raw.dev === true || eq(manifest.circuits, ZERO)
    if (o.offline || throwaway || !capi) {
      const why = throwaway ? 'a dev manifest (no on-chain identity)' : o.offline ? '--offline' : 'no chain client'
      for (const id of ['circuit', 'container', 'manifest-file']) skip(id, `not read on chain: ${why} / 未读链：${why === '--offline' ? '--offline' : '本地或一次性身份'}`)
      if (manifest.delegation) {
        const d = delegationExpiry(manifest)
        if (d.status === 'fail') { record(d); blocked(SERVICE, 'delegation'); return finish() }
        // Offline: the signature must at least recover under this chain's domain; who holds the circuit is not read.
        // 离线：签名至少要能在本链的域下恢复出地址；不读取电路的持有人。
        let who = null
        if (manifest.delegation.sig.length === 132) {
          try { who = recoverAddress(delegationDigest(chainId, capi?.addresses?.hub ?? CHAINS[56].hub, { container: manifest.container, signer: manifest.signer, expires: manifest.delegation.expires }), manifest.delegation.sig) } catch (e) {
            fail('delegation', `the delegation signature does not recover: ${e.message}`, resignFix, CMD.console); blocked(SERVICE, 'delegation'); return finish()
          }
        }
        record(d, `; ${who ? `signed by ${who}` : 'a contract signature (EIP-1271)'}, holder not checked (${throwaway ? 'dev identity' : 'offline'})`)
      } else skip('delegation', 'no delegation in a dev manifest / dev 清单没有委托')
    } else {
      // The chain the manifest's container lives on (an opened container answers token() there); else the home chain,
      // where the identity checks then say what is missing. / 清单容器所在的链；找不到就用主链，由身份检查说出缺什么。
      try {
        const where = typeof capi.chainOfContainer === 'function' ? await capi.chainOfContainer(manifest.container) : null
        if (where !== null && Number(where) !== chainId && typeof capi.forChain === 'function') { chainId = Number(where); capi = capi.forChain(chainId) }
      } catch { /* the identity checks below read again and report / 下面的身份检查会再读并报告 */ }
      if (!(await chainIdentity({ circuits: manifest.circuits, tokenId: BigInt(manifest.tokenId), container: manifest.container }))) {
        const by = firstNotPassed(); blocked(['manifest-file', 'delegation'].filter((x) => !done.has(x)), by); blocked(SERVICE, by); return finish()
      }
      const file = await chainManifestFile(identity.container)
      if (file?.missing) warn('manifest-file', 'not published on chain yet', publishFix)
      else if (file?.problem) fail('manifest-file', file.problem, publishFix)
      else if (file) {
        let same = false
        try { same = canonicalJSON(JSON.parse(new TextDecoder().decode(file.bytes))) === canonicalJSON(raw) } catch { /* not JSON */ }
        if (same) pass('manifest-file', 'the on-chain manifest is the one this sidecar serves')
        else warn('manifest-file', 'the on-chain manifest differs from the one this sidecar serves (models.json or the address changed?)', T('Publish again (console step 5) so users see the prices the sidecar signs.', '重新发布（操作台第 5 步），用户看到的价目表才与旁路签的一致。'))
      }
      if (!manifest.delegation) { fail('delegation', 'the served manifest carries no delegation', T('Complete console step 4 and set DELEGATION_EXPIRES and DELEGATION_SIG.', '完成操作台第 4 步并填入 DELEGATION_EXPIRES 与 DELEGATION_SIG。'), CMD.console); blocked(SERVICE, 'delegation'); return finish() }
      const d = delegationExpiry(manifest)
      if (d.status === 'fail') { record(d); blocked(SERVICE, 'delegation'); return finish() }
      // A dev-sourced resolve with a chain client still checks the signature against ownerOf (the holder on chain).
      // 带链客户端的 dev 来源解析仍按 ownerOf（链上持有人）核对签名。
      const got = await delegationByResolve(d, { dev: manifestUrl })
      if (!got) { blocked(SERVICE, 'delegation'); return finish() }
      if (got.svc.verified?.checked === false) { fail('delegation', 'the holder could not be read on chain', resignFix, CMD.console); blocked(SERVICE, 'delegation'); return finish() }
      record(d, `; signed by the holder ${identity.holder}`)
    }
  }

  // ------------------------------------------------------------------ the AI service / AI 服务
  const rawField = mode === 'url' ? served?.[ai.MANIFEST_FIELD] : manifest[ai.MANIFEST_FIELD]
  if (rawField === undefined) {
    fail('ai-field', `the manifest has no ${ai.MANIFEST_FIELD} field: this service is not an AI service${manifest.methods?.length ? ` (it serves ${manifest.methods.length} TapeAPI method(s): ${manifest.methods.slice(0, 4).map((m) => m.name).join(', ')}${manifest.methods.length > 4 ? ', ...' : ''})` : ''}`,
      T(`An AI service publishes its endpoints and price table in the ai field: run the sidecar in front of your gateway (examples/new-api-sidecar, examples/litellm-sidecar or examples/ai-proxy) and publish its manifest (console step 5).`, '要做 AI 服务，就要在 ai 字段里发布端点与价目表：把旁路放在你的网关前面（examples/new-api-sidecar、examples/litellm-sidecar 或 examples/ai-proxy），再发布它的清单（操作台第 5 步）。'), CMD.trial, { hint: trialHint })
    blocked(SERVICE.slice(1), 'ai-field'); return finish()
  }
  let field
  try { field = ai.validateAIField(rawField, { allowHttp }) } catch (e) {
    fail('ai-field', e.message, T('Fix models.json (the sidecar validates it with the same rules and says which entry is wrong), restart the sidecar and publish again (console step 5).', '改正 models.json（旁路用同样的规则校验并指出哪一条不对），重启旁路，再发布一次（操作台第 5 步）。'), CMD.console)
    blocked(SERVICE.slice(1), 'ai-field'); return finish()
  }
  manifest = { ...manifest, [ai.MANIFEST_FIELD]: field }
  pass('ai-field', `${field.endpoints.length} endpoint(s), ${field.models.length} model(s)`)
  // prices / 价目表
  const all = priceHints(field), hints = all.filter((h) => !h.info), notes = all.filter((h) => h.info).map((h) => `; note: ${h.en}`).join('')
  if (hints.length) warn('prices', hints.map((h) => h.en).join('; '), T(`Check these prices in models.json (hints only; nothing is refused): ${hints.map((h) => h.en).join('; ')}`, `核对 models.json 里的这些价格（只是提示，不会被拒绝）：${hints.map((h) => h.zh).join('；')}`))
  else pass('prices', `${field.models.length} model(s): ${field.models.slice(0, 4).map((m) => `${m.id} ${m.prices.map((p) => `${p.input}/${p.output} ${p.currency}`).join(', ')}`).join('; ')}${field.models.length > 4 ? '; ...' : ''} (per 1M tokens, published, not settled)${notes}`)
  // endpoints / 端点
  const eps = []
  const epProblems = []
  for (const e of field.endpoints) {
    const format = ai.FORMATS.find((f) => f.name === e.format)
    if (!format) { epProblems.push(`${e.format}: not a format this version knows; clients ignore it`); continue }
    const root = ai.rootOf(e.baseUrl, format)
    if (root === null) { epProblems.push(`${e.format}: ${e.baseUrl} should end with ${format.baseSuffix}; clients ignore it`); continue }
    if (format.baseSuffix === '' && /\/v1$/.test(e.baseUrl)) { epProblems.push(`${e.format}: ${e.baseUrl} is the service root itself, without /v1 (the SDKs add /v1)`); continue }
    eps.push({ format: e.format, baseUrl: e.baseUrl, root: root.replace(/\/+$/, '') })
  }
  if (!eps.length) {
    fail('endpoints', epProblems.join('; ') || 'no usable endpoint', T('Publish the endpoints the sidecar builds from PUBLIC_URL (console step 5).', '发布旁路按 PUBLIC_URL 生成的端点（操作台第 5 步）。'), CMD.console)
    blocked(['reach', 'cors', 'receipt', 'receipt-lookup'], 'endpoints'); return finish()
  }
  if (epProblems.length) warn('endpoints', epProblems.join('; '), T('Publish the endpoints the sidecar builds from PUBLIC_URL (console step 5).', '发布旁路按 PUBLIC_URL 生成的端点（操作台第 5 步）。'))
  else pass('endpoints', eps.map((e) => `${e.format} ${e.baseUrl}`).join('; '))
  // reach / 可访问
  const roots = [...new Set(eps.map((e) => e.root))]
  const reachable = new Set()
  const reachProblems = [], reachWarnings = []
  for (const root of roots) {
    let r
    try { r = await http(root + '/tapeapi/v1/health', { headers: { accept: 'application/json' } }) } catch (e) { const p = netProblem(e, host(root)); reachProblems.push({ detail: `${root}: ${p.why.en}`, fix: p.fix, transient: isTransient(p) }); continue }
    if (r.status >= 300 && r.status < 400) { reachProblems.push({ detail: `${root}/tapeapi/v1/health answers HTTP ${r.status} (a redirect to ${r.headers.get('location')})`, fix: T('Publish the exact address users must call: the sidecar and the verifiers never follow redirects.', '发布用户必须调用的确切地址：旁路与核验方都不跟随重定向。') }); continue }
    let h = null
    try { h = await r.json() } catch { /* not JSON */ }
    if (h?.setup) { reachProblems.push({ detail: `${root}: the sidecar is in SETUP MODE (${h.problem || `missing ${(h.missing || []).join(', ')}`})`, fix: T('Set the missing variables in .env (console steps 3 and 4 give them) and restart the sidecar.', '在 .env 里补上缺的变量（操作台第 3、4 步给出），重启旁路。') }); continue }
    if (!h || r.status !== 200) { reachProblems.push({ detail: `${root}/tapeapi/v1/health answers HTTP ${r.status}${h ? '' : ', not JSON'}: is this the sidecar?`, fix: T('Point this host at the sidecar (default 127.0.0.1:8080), not at the gateway behind it.', '把这个域名指向旁路（默认 127.0.0.1:8080），而不是它背后的网关。') }); continue }
    if (h.signer && !eq(h.signer, manifest.signer)) { reachProblems.push({ detail: `${root}: the sidecar signs as ${h.signer}, the manifest names ${manifest.signer}`, fix: T('The sidecar runs another key: set SIGNER_KEY to the service key the delegation names, or sign a new delegation (console step 4) and publish again.', '旁路用的是另一把密钥：把 SIGNER_KEY 设为委托所指的服务密钥，或重签委托（操作台第 4 步）再发布。') }); continue }
    if (h.ok === false) { reachProblems.push({ detail: `${root}: the sidecar reports ok: false (its delegation has lapsed)`, fix: T('Renew the delegation (console step 4, Renew) and restart the sidecar.', '续期委托（操作台第 4 步“续期”），重启旁路。') }); continue }
    if (mode !== 'url' && served === null) {
      try {
        const s = await (await http(root + MANIFEST_PATH, { headers: { accept: 'application/json' } })).json()
        if (canonicalJSON(s?.[ai.MANIFEST_FIELD] ?? null) !== canonicalJSON(rawField)) reachWarnings.push({ detail: `${root}: the sidecar serves a different ${ai.MANIFEST_FIELD} field than the chain (models.json changed and not republished?)`, fix: T('Publish again (console step 5) so the prices on chain are the ones the sidecar signs.', '重新发布（操作台第 5 步），链上价目表才与旁路签的一致。') })
      } catch { /* the health answered; the manifest is optional here / health 已答，这里清单可选 */ }
    }
    reachable.add(root)
  }
  // only network failures: undecided, retry (exit 3); any other problem fails (exit 1) / 只有网络故障：未判定、重试；其它问题则失败
  if (reachProblems.length && reachProblems.every((p) => p.transient)) retry('reach', reachProblems.map((p) => p.detail).join('; '), reachProblems[0].fix)
  else if (reachProblems.length) { const first = reachProblems.find((p) => !p.transient); fail('reach', reachProblems.map((p) => p.detail).join('; '), first.fix, CMD.doctor(input)) }
  else if (reachWarnings.length) warn('reach', reachWarnings.map((p) => p.detail).join('; '), reachWarnings[0].fix)
  else pass('reach', roots.map((r) => `${r} ${r.startsWith('https:') ? 'TLS ok, ' : ''}sidecar ready`).join('; '))
  const live = eps.filter((e) => reachable.has(e.root))
  if (!live.length) { blocked(['cors', 'receipt', 'receipt-lookup'], 'reach'); return finish() }

  // cors + receipt, per endpoint / 每个端点的 CORS 与回执
  const corsProblems = [], receiptFails = [], receiptWarns = [], receiptPasses = [], receiptNet = []
  // DOCR-2: the hosts the operator's key may go to: the one named on the command line (URL mode), or, for a name or a
  // container, the hosts of the manifest's endpoints.live, which the holder signed and resolve() checked. An ai endpoint
  // on any other host gets the invalid key only. / 运营者密钥允许发往的主机：命令行给出的那个（地址模式），名字或容器则为清单中
  // 持有人签名、resolve() 核对过的 endpoints.live 的主机。其它主机上的 ai 端点只收到无效密钥。
  const keyHosts = new Set()
  if (mode === 'url') keyHosts.add(host(input).toLowerCase())
  else for (const u of manifest.endpoints?.live ?? []) keyHosts.add(host(u).toLowerCase())
  const keyRefusal = (url) => {
    let u
    try { u = new URL(url) } catch { return 'not a URL' }
    if (!keyHosts.has(u.host.toLowerCase())) return `${u.host} is not the host being checked (${[...keyHosts].join(', ') || 'none'}); the manifest cannot send your key elsewhere`
    if (u.protocol === 'https:') return null
    if (u.protocol === 'http:' && LOOPBACK.test(u.hostname) && o.allowHttp === true) return null
    return `${u.host} is plain http: your key goes only over https (${LOOPBACK.test(u.hostname) ? 'pass --allow-http to send it to this loopback sidecar' : 'http is allowed only to a loopback sidecar with --allow-http'})`
  }
  let lookup = null
  const modelFor = (format) => o.model ?? field.models.find((m) => !m.formats || m.formats.includes(format))?.id ?? field.models[0].id
  for (const e of live) {
    const probe = PROBES[e.format]
    if (!probe) continue
    const url = e.root + probe.path
    // preflight / 预检
    try {
      const wants = corsWants(e.format)
      const r = await http(url, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': wants.join(',') } })
      const allowOrigin = r.headers.get('access-control-allow-origin')
      const allowHeaders = (r.headers.get('access-control-allow-headers') || '').toLowerCase()
      if (r.status >= 300 || !allowOrigin) corsProblems.push(`${e.format}: the preflight answered HTTP ${r.status}${allowOrigin ? '' : ' without Access-Control-Allow-Origin'}`)
      else {
        const missing = allowHeaders === '*' ? [] : wants.filter((w) => !allowHeaders.split(/\s*,\s*/).includes(w))
        if (missing.length) corsProblems.push(`${e.format}: the preflight does not allow ${missing.join(', ')}`)
      }
    } catch (err) { corsProblems.push(`${e.format}: ${netProblem(err, host(url)).why.en}`) }
    // a request with an invalid key: the gateway refuses, the sidecar signs the refusal / 无效密钥请求：网关拒绝，旁路为拒绝签回执
    const runs = [{ key: INVALID_KEY, real: false }, ...(o.key ? [{ key: o.key, real: true }] : [])]
    for (const run of runs) {
      if (run.real) {
        const why = keyRefusal(url)
        if (why) { receiptWarns.push({ detail: `${e.format} (your key): not sent: ${why}`, fix: T('Your key is sent only to the host you name, over https. Run the doctor against the sidecar that serves these endpoints, or publish endpoints on the host you run.', '你的密钥只发往你指定的主机、只走 https。请对提供这些端点的旁路运行诊断，或把端点发布在你运行的主机上。') }); continue }
      }
      const body = new TextEncoder().encode(JSON.stringify(probe.body(modelFor(e.format))))
      let r, bytes
      try {
        r = await http(url, { method: 'POST', headers: { 'content-type': 'application/json', origin, ...authHeaders(e.format, run.key) }, body })
        bytes = new Uint8Array(await r.arrayBuffer())
      } catch (err) {
        const p = netProblem(err, host(url))
        ;(isTransient(p) ? receiptNet : receiptFails).push({ detail: `${e.format}${run.real ? ' (your key)' : ''}: ${p.why.en}`, fix: p.fix }); continue
      }
      const label = `${e.format}${run.real ? ' (your key)' : ''}`
      if (!run.real) {
        const expose = (r.headers.get('access-control-expose-headers') || '').toLowerCase()
        if (!expose.includes(ai.RECEIPT_HEADER) && expose !== '*') corsProblems.push(`${e.format}: the answer does not expose ${ai.RECEIPT_HEADER} (Access-Control-Expose-Headers), so browser clients cannot read receipts`)
      }
      if (r.headers.get(ai.SIDECAR_ERROR_HEADER) === '1' && !r.headers.get(ai.RECEIPT_HEADER)) {
        let why = ''
        try { why = String(JSON.parse(new TextDecoder().decode(bytes))?.error?.message ?? '') } catch { /* not JSON */ }
        const fix = r.status === 502 || r.status === 504 ? T('The sidecar cannot reach your gateway: check UPSTREAM_BASE_URL (for the compose package: http://new-api:3000/v1) and that the gateway runs.', '旁路连不上你的网关：检查 UPSTREAM_BASE_URL（compose 包里是 http://new-api:3000/v1），并确认网关在运行。')
          : r.status === 503 ? T('The sidecar is in setup mode: set the variables it names in /tapeapi/v1/health.', '旁路处于设置模式：补上 /tapeapi/v1/health 列出的变量。')
            : T('The sidecar refused the request itself; its log says why.', '旁路自己拒绝了请求；原因见它的日志。')
        receiptFails.push({ detail: `${label}: HTTP ${r.status} from the sidecar itself, no receipt (${why.slice(0, 160)})`, fix }); continue
      }
      const header = r.headers.get(ai.RECEIPT_HEADER)
      const stream = (r.headers.get('content-type') || '').toLowerCase().includes('text/event-stream')
      let envelope = null
      try { envelope = header ? ai.decodeReceiptHeader(header) : stream ? ai.readSseReceipt(new TextDecoder().decode(bytes)) : null } catch (err) { receiptFails.push({ detail: `${label}: the receipt header does not decode: ${err.message}`, fix: T('Run the sidecar from this repository unchanged.', '使用本仓库原样的旁路。') }); continue }
      if (!envelope) {
        receiptFails.push({ detail: `${label}: HTTP ${r.status} with no ${ai.RECEIPT_HEADER} header: this address does not go through the sidecar`, fix: T(`Point the published host at the sidecar (default 127.0.0.1:8080), not at the gateway; then run ${CMD.doctor(input)}`, `把发布的域名指向旁路（默认 127.0.0.1:8080），而不是网关；然后运行 ${CMD.doctor(input)}`) })
        continue
      }
      const v = ai.verifyUsageReceipt({ envelope, manifest, requestBytes: body, responseBytes: bytes, path: probe.path, status: r.status, stream, maxSkewS: 300, now: now() })
      if (!v.ok) { receiptFails.push({ detail: `${label}: the receipt does not verify: ${v.problems.join('; ')}`, fix: v.problems.some((p) => p.startsWith('signed by')) ? T('The sidecar signs with a key the manifest does not name: set SIGNER_KEY to the delegated service key, or publish again.', '旁路签名用的密钥不是清单写的：把 SIGNER_KEY 设为受委托的服务密钥，或重新发布。') : v.problems.some((p) => p.startsWith('signed at')) ? T('The sidecar clock is off: turn on NTP time sync on the server.', '旁路服务器时钟不准：打开 NTP 时间同步。') : T('Something between the client and the sidecar changes the bytes (a proxy that rewrites or compresses bodies): pass them through unchanged.', '客户端与旁路之间有东西改动了字节（改写或压缩正文的代理）：请原样透传。') }); continue }
      const res = envelope.result
      if (!run.real) {
        if (r.status === 401 || r.status === 403) receiptPasses.push(`${e.format}: HTTP ${r.status} to an invalid key, receipt verified (signer ${manifest.signer}; no tokens used)`)
        else if (r.status >= 200 && r.status < 300) receiptWarns.push({ detail: `${e.format}: the gateway answered an invalid key with HTTP ${r.status} (receipt verified; this probe cost you a few input tokens and ${e.format === 'openai-responses' ? 16 : 1} output token(s))`, fix: T('Your gateway accepted a key that cannot be valid: check its authentication. Until you do, every run of the doctor costs a few tokens per endpoint.', '你的网关接受了一个不可能有效的密钥：检查它的鉴权。在修好之前，每次运行诊断每个端点都会花掉几个 token。') })
        else receiptPasses.push(`${e.format}: HTTP ${r.status} to an invalid key, receipt verified (no tokens used)`)
        lookup ??= { root: e.root, id: envelope.id, sig: envelope.sig, requestSha256: envelope.params.requestSha256 }
      } else {
        if (r.status !== 200) receiptWarns.push({ detail: `${label}: HTTP ${r.status} (receipt verified): ${new TextDecoder().decode(bytes).slice(0, 160)}`, fix: T('Check the model and the key with your gateway (use --model to pick another model).', '在你的网关核对模型与密钥（可用 --model 换一个模型）。') })
        else if (!res.prices) receiptWarns.push({ detail: `${label}: receipt verified, but the upstream reported model ${res.model}, which is not in the price table`, fix: T(`Add ${res.model} to models.json as an id or an alias, restart the sidecar and publish again.`, `把 ${res.model} 作为 id 或别名加进 models.json，重启旁路并重新发布。`) })
        else receiptPasses.push(`${label}: HTTP 200, model ${res.model}, tokens ${res.usage ? `${res.usage.prompt_tokens}+${res.usage.completion_tokens}` : '-'}, ${res.prices.map((p) => `${p.amount} ${p.currency}`).join(' / ')}, receipt verified`)
      }
      if (v.warnings.length && run.real) receiptWarns.push({ detail: `${label}: ${v.warnings.join('; ')}`, fix: T('See the warning; the receipt itself verified.', '见警告；回执本身核验通过。') })
    }
  }
  if (corsProblems.length) warn('cors', corsProblems.join('; '), T('Only browser clients need this. Put the sidecar in front unchanged: it answers preflights and exposes the receipt header; do not let the reverse proxy strip Access-Control-* headers.', '只有浏览器客户端需要。让旁路原样处在最前面：它回答预检并暴露回执头；不要让反向代理去掉 Access-Control-* 头。'))
  else pass('cors', `preflight allowed from ${origin}; ${ai.RECEIPT_HEADER} exposed`)
  // a failure or a retry still names the warnings (a key not sent, and why) / 失败或重试时仍列出警告（例如密钥未发送及原因）
  if (receiptFails.length) fail('receipt', [...receiptFails, ...receiptNet, ...receiptWarns].map((f) => f.detail).join('; '), receiptFails[0].fix, CMD.doctor(input))
  else if (receiptNet.length) retry('receipt', [...receiptPasses, ...[...receiptNet, ...receiptWarns].map((f) => f.detail)].join('; '), receiptNet[0].fix)
  else if (receiptWarns.length) warn('receipt', [...receiptPasses, ...receiptWarns.map((w) => w.detail)].join('; '), receiptWarns[0].fix)
  else pass('receipt', receiptPasses.join('; '))
  // receipt lookup / 取回执
  if (!lookup) skip('receipt-lookup', 'no receipt to look up / 没有可取的回执')
  else {
    try {
      const r = await http(lookup.root + `/tapeapi/v1/${ai.RECEIPT_METHOD}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'tapeapi-doctor', method: ai.RECEIPT_METHOD, params: { id: lookup.id, requestSha256: lookup.requestSha256 } }) })
      const j = await r.json().catch(() => null)
      if (r.status === 429) warn('receipt-lookup', 'rate limited (the free receipt method allows a few lookups per minute per IP)', T('Run the doctor again in a minute.', '一分钟后再运行诊断。'))
      else if (j?.ok && j.result?.sig === lookup.sig) pass('receipt-lookup', `receipt ${lookup.id} returned, same signature`)
      else warn('receipt-lookup', `the free receipt method did not return the receipt (HTTP ${r.status}${j?.error ? `, ${j.error.code}` : ''})`, T('Users can still read the receipt from the answer; check that /tapeapi/v1/* reaches the sidecar.', '用户仍可从回答里读到回执；检查 /tapeapi/v1/* 是否到达旁路。'))
    } catch (e) { warn('receipt-lookup', netProblem(e, host(lookup.root)).why.en, netProblem(e, host(lookup.root)).fix) }
  }
  return finish()

  // ------------------------------------------------------------------
  function finish() {
    const counts = { pass: 0, warn: 0, fail: 0, skip: 0, error: 0 }
    for (const c of checks) counts[c.status]++
    const exitCode = counts.fail ? 1 : counts.error ? 3 : 0
    // Reported in the fixed order, whatever order they ran in. / 按固定顺序报告，不论运行先后。
    checks.sort((a, b) => DOCTOR_CHECKS.indexOf(a.id) - DOCTOR_CHECKS.indexOf(b.id))
    return redactSecret({ target: input, mode, chainId, ok: exitCode === 0, exitCode, counts, checks, manifest }, o.key)
  }
}

/** Plain-text report, one block per check. lang: 'en' | 'zh' | 'both'. / 纯文本报告。 */
export function formatReport(report, { lang = 'both', version = '' } = {}) {
  const L = (t) => (lang === 'en' ? t.en : lang === 'zh' ? t.zh : `${t.en} / ${t.zh}`)
  const mark = { pass: 'PASS', warn: 'WARN', fail: 'FAIL', skip: 'SKIP', error: 'ERR ' }
  const lines = [`tapeapi-doctor${version ? ` ${version}` : ''}: ${report.target} (${report.mode === 'url' ? 'sidecar URL' : report.mode === 'name' ? `TapeOut name, ${CHAINS[report.chainId]?.name ?? `chain ${report.chainId}`}` : 'container'})`]
  report.checks.forEach((c, i) => {
    lines.push(`${String(i + 1).padStart(2)} ${mark[c.status]}  ${L(c.title)}`)
    if (c.detail) lines.push(`         ${c.detail}`)
    if (c.fix && c.status !== 'pass') {
      if (lang !== 'zh') lines.push(`         fix:  ${c.fix.en}`)
      if (lang !== 'en') lines.push(`         修复: ${c.fix.zh}`)
    }
    if (c.hint && c.status === 'fail') {
      if (lang !== 'zh') lines.push(`         note: ${c.hint.en}`)
      if (lang !== 'en') lines.push(`         提示: ${c.hint.zh}`)
    }
    if (c.next && c.status === 'fail') lines.push(`         next / 下一条命令: ${c.next}`)
  })
  const k = report.counts
  lines.push(`result / 结果: ${k.pass} passed, ${k.warn} warned, ${k.fail} failed, ${k.skip} skipped${k.error ? `, ${k.error} undecided` : ''}; exit ${report.exitCode}`)
  return lines.join('\n')
}
