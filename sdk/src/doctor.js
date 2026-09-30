// @experimental The provider-side diagnosis behind tapeapi-doctor: given a TapeOut name, a container address or a
// sidecar's URL, check in order what an AI service needs before users can verify receipts, and say for every check what
// passed or failed, why, and what to do next, in English and Chinese. Not in the package's exports; the shape may change.
// @experimental tapeapi-doctor 背后的服务方诊断：按顺序检查 AI 服务在用户能核验回执之前需要的一切，用中英双语说明结论与下一步。
//
// Order / 顺序:  name -> circuit -> container -> manifest-file -> manifest-format -> delegation -> ai-field -> prices ->
//                endpoints -> reach -> cors -> receipt -> receipt-lookup
// A check that cannot run because an earlier one failed is `skip`, naming that one. / 因前项失败而无法运行的检查记为 skip。
//
// The receipt check sends each endpoint one request with a key that cannot be valid: the sidecar signs the refusal too
// (TAP-21 §3.5), which proves the path at no cost (a gateway that accepts any key answers, at a few tokens; it warns).
// The operator's own `key` goes only to the host being checked, over https, and shows as *** in the report.
// 回执检查用无效密钥：旁路为拒绝同样签回执，不花钱即证明整条路径。运营者自己的 key 只发往被检查的主机、只走 https、报告里为 ***。

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

/** The release package of the SDK (it carries tapeapi-doctor since 1.2.0). / SDK 的发布包（1.2.0 起带 tapeapi-doctor）。 */
export const releaseTgz = (version) => `https://github.com/BruceLanLan/tapeapi/releases/download/v${version}/tapeapi-sdk-${version}.tgz`
const shellWord = (s) => (/[\s"'$`\\]/.test(s) ? JSON.stringify(s) : s)
/**
 * The commands the hints name, written the way the doctor was run (ONB2-1): a checkout (a path relative to the working
 * directory), npx from the release package, or an install of it. The trial exists only in a checkout.
 * 提示里的命令按诊断的运行方式书写：检出（相对路径）、经 npx 从发布包、或安装后。本地试跑只在检出里有。
 * @param {{ run?: 'checkout'|'npx'|'installed', bin?: string, trial?: string, version?: string }} [how]
 */
export function doctorCommands({ run = 'checkout', bin = 'sdk/bin/tapeapi-doctor.js', trial = 'examples/relay-trial/trial.mjs', version = '' } = {}) {
  const doctor = run === 'npx' && version ? `npx -y --package=${releaseTgz(version)} tapeapi-doctor`
    : run === 'checkout' ? `node ${shellWord(bin)}` : 'npx tapeapi-doctor'
  return Object.freeze({
    run,
    doctor: (t) => `${doctor} ${t}`,
    trial: run === 'checkout' ? `node ${shellWord(trial)}` : 'git clone https://github.com/BruceLanLan/tapeapi.git && cd tapeapi && npm ci --no-audit --no-fund && node examples/relay-trial/trial.mjs',
    console: 'https://tapeapi.fun/console/',
    tapeout: 'https://tapeout.net',
  })
}
/** Default: from a checkout, at its root. / 默认：从检出的根目录运行。 */
export const CMD = doctorCommands()

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

const TLS_WORDS = [
  [/SELF_SIGNED|DEPTH_ZERO|self.signed/i, 'the certificate is self-signed, so no client trusts it', '证书是自签名的，客户端不会信任它'],
  [/EXPIRED/i, 'the certificate has expired', '证书已过期'],
  [/NOT_YET_VALID/i, 'the certificate is not valid yet (check the server clock)', '证书尚未生效（检查服务器时钟）'],
  [/ALTNAME|HOSTNAME|IP.*not in the cert/i, 'the certificate names another host', '证书上的域名与这个地址不符'],
  [/UNABLE_TO_VERIFY_LEAF|UNABLE_TO_GET_ISSUER|CHAIN/i, 'the certificate chain is incomplete (an intermediate certificate is missing)', '证书链不完整（缺少中间证书）'],
  [/EPROTO|wrong version number|packet length/i, 'this port does not speak TLS (https pointed at a plain http port?)', '这个端口不是 TLS（是不是把 https 指到了 http 端口？）'],
]
// A network failure, in words an operator can act on. / 网络失败，用运营者能照着做的话说出来。
export function netProblem(e, host) {
  const code = e?.cause?.code || e?.code || ''
  const msg = String(e?.cause?.message || e?.message || e)
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return { code: 'TIMEOUT', why: T(`${host} did not answer in time`, `${host} 没有按时回答`), fix: T('Check that the sidecar runs and that your reverse proxy forwards to it (and does not buffer).', '检查旁路在运行，反向代理转发到了它（且没有开缓冲）。') }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return { code, why: T(`the host name ${host} does not resolve (DNS)`, `域名 ${host} 解析不到（DNS）`), fix: T('Add the DNS record for this host, or publish the host you actually use.', '为这个域名加 DNS 记录，或发布你实际使用的域名。') }
  if (code === 'ECONNREFUSED') return { code, why: T(`${host} refused the connection`, `${host} 拒绝连接`), fix: T('Start the sidecar, or point your reverse proxy at it (default 127.0.0.1:8080).', '启动旁路，或把反向代理指向它（默认 127.0.0.1:8080）。') }
  if (/CERT|SSL|TLS|self.signed|altname|UNABLE_TO_(VERIFY|GET_ISSUER)|EPROTO|wrong version number/i.test(code + ' ' + msg)) {
    // In words, not the OpenSSL code (ONB2-4) / 用人话，不露出原码
    const what = TLS_WORDS.find(([re]) => re.test(code + ' ' + msg)) ?? [null, 'the certificate is not trusted', '证书不受信任']
    return { code: code || 'TLS', why: T(`TLS to ${host} failed: ${what[1]}`, `到 ${host} 的 TLS 失败：${what[2]}`), fix: T(`Install a valid certificate for this exact host name in your reverse proxy (Caddy and 1Panel can issue one automatically), then run the doctor again.`, '在反向代理里为这个确切的域名装有效证书（Caddy、1Panel 可以自动签发），然后重新运行诊断。') }
  }
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
 * @param {object} [o.commands]  the commands the hints name (doctorCommands(); default: from a checkout, at its root)
 * @returns {Promise<{ target: string, mode: 'name'|'container'|'url', ok: boolean, exitCode: number, counts: object, checks: object[], manifest: object|null }>}
 * Every check has `detail` in English and, for what did not pass, `detailZh` in Chinese. / detail 为英文，未通过的另有中文 detailZh。
 */
export async function diagnose(input, o = {}) {
  const fetchImpl = o.fetch ?? globalThis.fetch.bind(globalThis)
  const now = o.now ?? (() => Math.floor(Date.now() / 1000))
  const timeoutMs = o.timeoutMs ?? 15_000
  const origin = o.origin ?? 'https://example.org'
  const cmd = o.commands ?? CMD
  const checks = []
  const done = new Map()   // id -> status / 各项结果
  // Every text of the report passes here, so the operator's key never does (DOCR-1); a detail is a string or T(en, zh).
  // 报告的每段文字都经过这里，密钥不会进入报告；detail 是字符串或 T(en, zh)。
  const add = (id, status, detail, extra = {}) => {
    const d = detail && typeof detail === 'object' ? { detail: detail.en, detailZh: detail.zh } : { detail: detail ?? '' }
    const c = redactSecret({ id, status, title: TITLES[id], ...d, ...extra }, o.key)
    checks.push(c); done.set(id, status); o.onCheck?.(c); return c
  }
  const pass = (id, detail, extra) => add(id, 'pass', detail, extra)
  const warn = (id, detail, fix, extra) => add(id, 'warn', detail, { fix, ...extra })
  const fail = (id, detail, fix, next, extra) => add(id, 'fail', detail, { fix, ...(next ? { next } : {}), ...extra })
  const skip = (id, why) => add(id, 'skip', why)
  const en = (d) => (typeof d === 'object' ? d.en : d), zh = (d) => (typeof d === 'object' ? d.zh : d)
  // a network failure worth retrying: undecided (exit 3), with the network hint / 值得重试的网络失败：未判定（退出码 3），附网络提示
  const retry = (id, detail, fix) => add(id, 'error', T(`could not decide: ${en(detail)}`, `无法判定：${zh(detail)}`), { fix: T(`${fix.en} This is a network failure: run the doctor again (exit code 3 means: retry).`, `${fix.zh} 这是网络故障：重新运行诊断（退出码 3 表示：重试）。`) })
  const error = (id, e) => add(id, 'error', T(`could not decide: ${e?.code ? `${e.code} ` : ''}${e?.message || e}`, `无法判定：${e?.code ? `${e.code} ` : ''}${e?.message || e}`), { fix: T('The chain or the network could not be read; run the doctor again (exit code 3 means: retry).', '链或网络读不到；重新运行诊断（退出码 3 表示：重试）。') })
  const firstNotPassed = () => [...done].find(([, s]) => s !== 'pass' && s !== 'skip')?.[0]
  const blocked = (ids, by) => { for (const id of ids) skip(id, T(`not checked: "${by}" did not pass`, `未检查："${by}" 未通过`)) }
  const http = async (url, init = {}) => fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), ...init })
  const host = (u) => { try { return new URL(u).host } catch { return String(u) } }
  const place = (u) => { try { const x = new URL(u); return (x.origin + x.pathname).replace(/\/+$/, '').toLowerCase() } catch { return String(u).toLowerCase() } }

  let mode, manifest = null, chainId = 56, capi = o.api ?? null, identity = null, served = null, allowHttp = !!o.allowHttp, given = null
  const trialHint = T(`No service of your own yet? Run the local trial first (no key, no circuit, no cost): ${cmd.trial}`, `还没有自己的服务？先跑本地试跑（不需要密钥、电路，也不花钱）：${cmd.trial}`)

  // ------------------------------------------------------------------ target / 目标
  const parsed = parseTapeName(input)
  if (parsed && !parsed.error) { mode = 'name'; chainId = parsed.chainId }
  else if (ADDRESS_RE.test(input)) mode = 'container'
  else if (/^https?:\/\//i.test(input)) mode = 'url'
  else {
    const shown = String(input).slice(0, 80)
    throw new TapeAPIError('INVALID_ARGUMENT', parsed?.error
      ? `"${shown}" is not a TapeOut name in canonical form (42.1013.tape; with the area code on X Layer or Base: 1.2.344.tape)\n“${shown}”不是规范形式的 TapeOut 名字（如 42.1013.tape；X Layer、Base 带区号，如 1.2.344.tape）`
      : `"${shown}" is not a TapeOut name (42.1013.tape), a container address (0x...) or a sidecar URL (https://...)\n“${shown}”不是 TapeOut 名字、容器地址或旁路地址`)
  }
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
        fail('circuit', T(`circuit #${tokenId} of ${circuits} has not been minted: ownerOf reverts`, `${circuits} 的 #${tokenId} 号电路尚未铸造：ownerOf 回退`), T(`Tape out a circuit on ${cmd.tapeout} (you buy it; the price is TapeOut's), then use its name. The documentation's 42.1013.tape is an example name.`, `在 ${cmd.tapeout} 购买一枚电路（由你自己购买，价格以 TapeOut 为准），再用它的名字。文档里的 42.1013.tape 只是示例名。`), cmd.trial, { hint: trialHint })
        return false
      }
      error('circuit', e); return false
    }
    pass('circuit', `holder ${holder}`)
    // container / 容器
    let container, code
    try { container = await capi.chain.accountOf(circuits, tokenId); code = await capi.rpc.call('eth_getCode', [container, 'latest']) } catch (e) { error('container', e); return false }
    if (expected && !eq(expected, container)) { fail('container', T(`hub.accountOf(${circuits}, ${tokenId}) is ${container}, the manifest names ${expected}`, `hub.accountOf(${circuits}, ${tokenId}) 是 ${container}，清单写的是 ${expected}`), T('The manifest names another container: publish the manifest the console builds for this circuit (step 5).', '清单写的是别的容器：发布操作台为这枚电路生成的清单（第 5 步）。'), cmd.console); return false }
    if (!code || /^0x0*$/i.test(code)) {
      fail('container', T(`container ${container} has no code: it has not been opened`, `容器 ${container} 没有代码：尚未开通`), T(`Open the circuit's container on ${cmd.tapeout} (a one-time on-chain transaction; you pay its gas). Then run: ${cmd.doctor(input)}`, `在 ${cmd.tapeout} 开通这枚电路的容器（一次链上交易，gas 由你支付）。然后运行：${cmd.doctor(input)}`), cmd.doctor(input))
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
    if (!info.sha256Hash || /^0x0*$/.test(info.sha256Hash)) return { problem: T(`${MANIFEST_PATH} has no on-chain SHA-256 (fileInfo.sha256Hash is zero)`, `${MANIFEST_PATH} 在链上没有 SHA-256（fileInfo.sha256Hash 为零）`) }
    let bytes
    try { bytes = hexToBytes(await capi.chain.readFile(container, MANIFEST_KEY)) } catch (e) { if (isRevert(e)) return { missing: true }; error('manifest-file', e); return null }
    const digest = toHex(sha256(bytes))
    if (bytes.length !== Number(info.size)) return { problem: T(`read ${bytes.length} bytes, fileInfo.size declares ${info.size}`, `读到 ${bytes.length} 字节，fileInfo.size 声明 ${info.size}`) }
    if (digest !== String(info.sha256Hash).toLowerCase()) return { problem: T(`sha256 of the bytes is ${digest}, fileInfo declares ${info.sha256Hash}`, `字节的 sha256 是 ${digest}，fileInfo 声明 ${info.sha256Hash}`) }
    return { bytes, size: bytes.length }
  }

  const publishFix = T(`Publish the sidecar's manifest on chain: holder console ${cmd.console} step 5 (one transaction; you pay its gas).`, `把旁路的清单发布上链：持有人操作台 ${cmd.console} 第 5 步（一笔交易，gas 由你支付）。`)
  // Nothing published yet: the steps in order, not straight to step 5 (ONB2-4) / 尚未发布：按顺序列出各步
  const SIDECAR = '<your sidecar URL>', SIDECAR_ZH = '<你的旁路地址>'
  const firstPublishFix = T(`Nothing is published yet. In order: run the sidecar in front of your gateway (guide step 3), then in the holder console ${cmd.console} generate the service key (step 3), sign the delegation (step 4) and publish the manifest (step 5; your gas). Check the sidecar first: ${cmd.doctor(SIDECAR)}`,
    `还没有发布任何东西。按顺序：在网关前面运行旁路（指南第 3 步），再在持有人操作台 ${cmd.console} 生成服务密钥（第 3 步）、签委托（第 4 步）、发布清单（第 5 步，gas 自付）。先检查旁路：${cmd.doctor(SIDECAR_ZH)}`)
  const notSidecarFix = T('This address does not reach a TapeAPI sidecar. Check your reverse proxy and its port: every path of this host must go to the sidecar (default 127.0.0.1:8080), not to a default web page or the gateway. A sidecar always answers /tapeapi/v1/health.',
    '这个地址到不了 TapeAPI 旁路。检查反向代理与端口：这个域名的所有路径都要转发到旁路（默认 127.0.0.1:8080），而不是默认网页或网关。旁路总会回答 /tapeapi/v1/health。')

  // The expiry, not yet recorded: the signature check may still fail it. / 到期情况，尚未记录。
  function delegationExpiry(m) {
    if (!m.delegation) return { status: 'fail', detail: T('no delegation', '没有委托'), fix: T('Sign the delegation: console step 4.', '签委托：操作台第 4 步。') }
    const left = Number(m.delegation.expires) - now()
    const days = Math.floor(left / 86_400)
    const until = new Date(Number(m.delegation.expires) * 1000).toISOString().slice(0, 10)
    const renew = T(`Renew: console step 4 "Renew" (same service key), set DELEGATION_EXPIRES and DELEGATION_SIG, restart the sidecar, publish again (step 5).`, '续期：操作台第 4 步“续期”（服务密钥不变），填入新的 DELEGATION_EXPIRES 与 DELEGATION_SIG，重启旁路，再发布一次（第 5 步）。')
    if (left <= 0) return { status: 'fail', detail: T(`expired on ${until}`, `已于 ${until} 过期`), fix: renew }
    if (left > MAX_DELEGATION_S) return { status: 'fail', detail: T(`expires ${until}, more than 366 days ahead: clients refuse it (TAP-20 §3.4)`, `${until} 到期，超过 366 天：客户端会拒绝（TAP-20 §3.4）`), fix: T('Sign a delegation of at most 366 days (the console signs 90).', '签一份不超过 366 天的委托（操作台签 90 天）。') }
    if (days < RENEW_DAYS) return { status: 'warn', detail: T(`${days} day(s) left, until ${until}`, `还剩 ${days} 天，到 ${until}`), fix: renew, days }
    return { status: 'pass', detail: T(`${days} days left, until ${until}`, `还剩 ${days} 天，到 ${until}`), days }
  }
  const record = (d, more = T('', '')) => {
    const detail = T(d.detail.en + more.en, d.detail.zh + more.zh)
    return d.status === 'fail' ? fail('delegation', detail, d.fix, cmd.console) : d.status === 'warn' ? warn('delegation', detail, d.fix) : pass('delegation', detail)
  }
  const resignFix = T('Sign the delegation again with the wallet that holds the circuit: console step 4, then set DELEGATION_EXPIRES and DELEGATION_SIG, restart the sidecar and publish again (step 5).', '用持有电路的钱包重签委托：操作台第 4 步，然后填入 DELEGATION_EXPIRES 与 DELEGATION_SIG，重启旁路，再发布一次（第 5 步）。')
  // The SDK's resolve() is the final word on the delegation (ECDSA or EIP-1271, holder on chain). / 委托以 SDK 的 resolve() 为准。
  async function delegationByResolve(d, target) {
    try { return { svc: await capi.resolve(target) } } catch (e) {
      if (e instanceof TapeAPIError && e.code === 'DELEGATION_INVALID') fail('delegation', T(e.message, `委托无效：${e.message}`), resignFix, cmd.console)
      else if (undecided(e)) error('delegation', e)
      else fail('delegation', T(e.message, `解析失败：${e.message}`), publishFix, cmd.console)
      return null
    }
  }


  if (mode === 'name' || mode === 'container') {
    // name / 名字
    let circuits, tokenId
    if (mode === 'name') {
      try { circuits = await capi.chain.cpuAt(parsed.processor) } catch (e) {
        const chainName = CHAINS[chainId]?.name ?? `chain ${chainId}`
        if (e instanceof TapeAPIError && e.code === 'NOT_FOUND') fail('name', T(`${parsed.name}: processor ${parsed.processor} does not exist on ${chainName}`, `${parsed.name}：${chainName} 上没有 ${parsed.processor} 号处理器`), T('Check the name: <#ID>.<processor>.tape, as tapeout.net shows it.', '检查名字：<#ID>.<处理器>.tape，以 tapeout.net 显示的为准。'))
        else error('name', e)
        blocked([...IDENTITY, ...SERVICE], 'name')
        return finish()
      }
      tokenId = BigInt(parsed.tokenId)
      const chainName = CHAINS[chainId]?.name ?? `chain ${chainId}`
      pass('name', `${parsed.name} -> processor ${parsed.processor} = ${circuits} on ${chainName}`)
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
        if (e instanceof TapeAPIError && (e.code === 'NOT_FOUND' || e.code === 'CHANNEL_INVALID')) fail('name', T(`${input} is not a TapeOut container on this chain (${e.message})`, `${input} 不是这条链上的 TapeOut 容器（${e.message}）`), T('Use the TapeOut name of your circuit (as tapeout.net shows it) instead.', '改用你的电路的 TapeOut 名字（以 tapeout.net 显示的为准）。'))
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
      fail('manifest-file', T(`no file at ${MANIFEST_PATH} for ${identity.container}`, `${identity.container} 在 ${MANIFEST_PATH} 没有文件`), firstPublishFix, cmd.doctor(SIDECAR), { hint: trialHint })
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
      fail('manifest-format', T(e.message, `清单不合规：${e.message}`), T(`Republish the manifest the sidecar serves (console step 5); the console checks it before asking your wallet.`, '重新发布旁路提供的清单（操作台第 5 步）；操作台会在请求钱包之前检查它。'), cmd.console)
      blocked(['delegation', ...SERVICE], 'manifest-format'); return finish()
    }
    pass('manifest-format', `"${String(manifest.name).slice(0, 60)}", signer ${manifest.signer}, ${manifest.methods.length} method(s)`)
    // delegation: expiry arithmetic, then the SDK's own resolve() as the final word / 委托：先算到期，再以 SDK 的 resolve() 为准
    const d = delegationExpiry(manifest)
    if (d.status === 'fail') { record(d); blocked(SERVICE, 'delegation'); return finish() }
    const got = await delegationByResolve(d, mode === 'name' ? parsed.name : input)
    if (!got) { blocked(SERVICE, 'delegation'); return finish() }
    const by = got.svc.verified?.holder ?? identity.holder
    record(d, T(`; signed by the holder ${by}`, `；由持有人 ${by} 签名`))
    // resolve() drops an invalid ai field; keep it for the next check. / 保留发布的 ai 字段供下一项检查。
    manifest = got.svc.aiProblems ? { ...got.svc.manifest, [ai.MANIFEST_FIELD]: manifest[ai.MANIFEST_FIELD] } : got.svc.manifest
  } else {
    // ---------------------------------------------------------------- URL mode / 地址模式
    let url = input.replace(/\/+$/, '')
    const manifestUrl = /\.json$/i.test(url) ? url : url + MANIFEST_PATH
    try { if (LOOPBACK.test(new URL(url).hostname)) allowHttp = true } catch { throw new TapeAPIError('INVALID_ARGUMENT', `${input} is not a URL\n${input} 不是网址`) }
    // Every probe goes to the address given (ONB2-5) / 所有探测都打给出的地址
    given = url.replace(/\/\.well-known\/tapeapi\.json$/i, '')
    skip('name', T('URL mode: a sidecar address, no name', '地址模式：旁路地址，没有名字'))
    const stop = () => { blocked(['circuit', 'container', 'manifest-file', 'delegation', ...SERVICE], 'manifest-format'); return finish() }
    // Is a sidecar answering here? Its health check says. / 这里是旁路吗？看 health。
    const health = async () => { try { const h = await (await http(given + '/tapeapi/v1/health', { headers: { accept: 'application/json' } })).json(); return h && typeof h === 'object' && (h.setup !== undefined || typeof h.signer === 'string' || typeof h.ok === 'boolean') ? h : null } catch { return null } }
    let res
    try { res = await http(manifestUrl, { headers: { accept: 'application/json' } }) } catch (e) {
      const p = netProblem(e, host(manifestUrl))
      const detail = T(`${manifestUrl}: ${p.why.en}`, `${manifestUrl}：${p.why.zh}`)
      if (isTransient(p)) retry('manifest-format', detail, p.fix)
      else fail('manifest-format', detail, p.fix, cmd.doctor(input))
      return stop()
    }
    let text = ''
    try { text = await res.text() } catch { /* empty */ }
    if (res.status !== 200) {
      // Setup mode: 503 for the manifest, what is missing in health. / 设置模式：清单 503，health 列出缺项。
      const h = await health()
      if (h?.setup) {
        const what = h.problem || `missing ${(h.missing || []).join(', ')}`, whatZh = h.problem || `缺少 ${(h.missing || []).join('、')}`
        fail('manifest-format', T(`the sidecar is in SETUP MODE: ${what}${h.signer ? `; its signing address is ${h.signer}` : ''}`, `旁路处于设置模式：${whatZh}${h.signer ? `；它的签名地址是 ${h.signer}` : ''}`),
          T(`Normal before the identity is complete. Set what is missing in .env (the holder console ${cmd.console} gives the values: step 3 the service key, step 4 the delegation, which reads the signing address from this sidecar), then restart the sidecar.`, `身份补齐之前这是正常的。在 .env 里补上缺的变量（持有人操作台 ${cmd.console} 给出这些值：第 3 步服务密钥，第 4 步委托，它从这个旁路读取签名地址），然后重启旁路。`), cmd.doctor(input))
        return stop()
      }
      if (res.status >= 300 && res.status < 400) {
        const to = res.headers.get('location')
        fail('manifest-format', T(`${manifestUrl}: HTTP ${res.status} (a redirect to ${to})`, `${manifestUrl}：HTTP ${res.status}（重定向到 ${to}）`), T('Serve the sidecar at this exact address: the doctor, the sidecar and the verifiers never follow redirects. Publish the address users call, or point the reverse proxy here at the sidecar.', '让旁路就在这个确切的地址上应答：诊断、旁路与核验方都不跟随重定向。发布用户实际调用的地址，或把这里的反向代理指向旁路。'), cmd.doctor(input))
        return stop()
      }
      if (h) {
        fail('manifest-format', T(`${manifestUrl}: HTTP ${res.status}, while ${given}/tapeapi/v1/health is the sidecar's: the reverse proxy does not forward ${MANIFEST_PATH}`, `${manifestUrl}：HTTP ${res.status}，而 ${given}/tapeapi/v1/health 是旁路在回答：反向代理没有转发 ${MANIFEST_PATH}`),
          T('Forward every path of this host name to the sidecar, not only /v1: clients read /.well-known/tapeapi.json and /tapeapi/v1/* too.', '把这个域名的所有路径都转发到旁路，而不只是 /v1：客户端还会读 /.well-known/tapeapi.json 与 /tapeapi/v1/*。'), cmd.doctor(input))
        return stop()
      }
      fail('manifest-format', T(`${manifestUrl}: HTTP ${res.status}, and no TapeAPI sidecar answers at ${given}/tapeapi/v1/health`, `${manifestUrl}：HTTP ${res.status}，且 ${given}/tapeapi/v1/health 没有 TapeAPI 旁路应答`), notSidecarFix, `curl -s ${given}/tapeapi/v1/health`)
      return stop()
    }
    let raw
    try { raw = safeParseJSON(text, { code: 'MANIFEST_INVALID' }); manifest = validateManifest(raw, { requireDelegation: false, allowHttp }); manifest = { ...manifest, ...(raw[ai.MANIFEST_FIELD] !== undefined ? { [ai.MANIFEST_FIELD]: raw[ai.MANIFEST_FIELD] } : {}) } } catch (e) {
      // The sidecar validates what it serves: an invalid one means something else answered. / 清单不合规多半是别的服务在回答。
      const h = await health()
      const html = /^\s*</.test(text) || /html/i.test(res.headers.get('content-type') || '')
      if (!h) fail('manifest-format', T(`${manifestUrl}: ${html ? 'an HTML page (a web server\'s default page?)' : e.message}, not a TapeAPI manifest; no sidecar answers at ${given}/tapeapi/v1/health`, `${manifestUrl}：${html ? '一个 HTML 网页（网站服务器的默认页？）' : e.message}，不是 TapeAPI 清单；${given}/tapeapi/v1/health 也没有旁路应答`), notSidecarFix, `curl -s ${given}/tapeapi/v1/health`)
      else fail('manifest-format', T(`${manifestUrl}: ${e.message}`, `${manifestUrl}：清单不合规：${e.message}`), T('Fix the variables the sidecar reports in its log and in /tapeapi/v1/health, then restart it.', '按旁路日志与 /tapeapi/v1/health 报告的问题改正环境变量，然后重启旁路。'), cmd.doctor(input))
      return stop()
    }
    served = raw
    pass('manifest-format', `served by ${host(manifestUrl)}: "${String(manifest.name).slice(0, 60)}", signer ${manifest.signer}`)
    const throwaway = raw.dev === true || eq(manifest.circuits, ZERO)
    if (o.offline || throwaway || !capi) {
      const why = throwaway ? T('a dev manifest (no on-chain identity)', '本地或一次性身份（dev 清单）') : o.offline ? T('--offline', '--offline') : T('no chain client', '没有链客户端')
      for (const id of ['circuit', 'container', 'manifest-file']) skip(id, T(`not read on chain: ${why.en}`, `未读链：${why.zh}`))
      if (manifest.delegation) {
        const d = delegationExpiry(manifest)
        if (d.status === 'fail') { record(d); blocked(SERVICE, 'delegation'); return finish() }
        // Offline: the signature must recover; the holder is not read. / 离线：签名须能恢复，不读持有人。
        let who = null
        if (manifest.delegation.sig.length === 132) {
          try { who = recoverAddress(delegationDigest(chainId, capi?.addresses?.hub ?? CHAINS[56].hub, { container: manifest.container, signer: manifest.signer, expires: manifest.delegation.expires }), manifest.delegation.sig) } catch (e) {
            fail('delegation', T(`the delegation signature does not recover: ${e.message}`, `委托签名无法恢复出地址：${e.message}`), resignFix, cmd.console); blocked(SERVICE, 'delegation'); return finish()
          }
        }
        record(d, T(`; ${who ? `signed by ${who}` : 'a contract signature (EIP-1271)'}, holder not checked (${throwaway ? 'dev identity' : 'offline'})`, `；${who ? `由 ${who} 签名` : '合约签名（EIP-1271）'}，未核对持有人（${throwaway ? '一次性身份' : '离线'}）`))
      } else skip('delegation', T('no delegation in a dev manifest', 'dev 清单没有委托'))
    } else {
      // The chain of the manifest's container, else the home chain. / 清单容器所在的链，否则主链。
      try {
        const where = typeof capi.chainOfContainer === 'function' ? await capi.chainOfContainer(manifest.container) : null
        if (where !== null && Number(where) !== chainId && typeof capi.forChain === 'function') { chainId = Number(where); capi = capi.forChain(chainId) }
      } catch { /* the identity checks below read again and report / 下面的身份检查会再读并报告 */ }
      if (!(await chainIdentity({ circuits: manifest.circuits, tokenId: BigInt(manifest.tokenId), container: manifest.container }))) {
        const by = firstNotPassed(); blocked(['manifest-file', 'delegation'].filter((x) => !done.has(x)), by); blocked(SERVICE, by); return finish()
      }
      const file = await chainManifestFile(identity.container)
      if (file?.missing) warn('manifest-file', T('not published on chain yet', '尚未发布上链'), publishFix)
      else if (file?.problem) fail('manifest-file', file.problem, publishFix)
      else if (file) {
        let same = false
        try { same = canonicalJSON(JSON.parse(new TextDecoder().decode(file.bytes))) === canonicalJSON(raw) } catch { /* not JSON */ }
        if (same) pass('manifest-file', 'the on-chain manifest is the one this sidecar serves')
        else warn('manifest-file', T('the on-chain manifest differs from the one this sidecar serves (models.json or the address changed?)', '链上清单与这个旁路提供的不同（models.json 或地址改过？）'), T('Publish again (console step 5) so users see the prices the sidecar signs.', '重新发布（操作台第 5 步），用户看到的价目表才与旁路签的一致。'))
      }
      if (!manifest.delegation) { fail('delegation', T('the served manifest carries no delegation', '旁路提供的清单没有委托'), T('Complete console step 4 and set DELEGATION_EXPIRES and DELEGATION_SIG.', '完成操作台第 4 步并填入 DELEGATION_EXPIRES 与 DELEGATION_SIG。'), cmd.console); blocked(SERVICE, 'delegation'); return finish() }
      const d = delegationExpiry(manifest)
      if (d.status === 'fail') { record(d); blocked(SERVICE, 'delegation'); return finish() }
      // A dev-sourced resolve still checks the holder on chain. / dev 来源解析仍核对链上持有人。
      const got = await delegationByResolve(d, { dev: manifestUrl })
      if (!got) { blocked(SERVICE, 'delegation'); return finish() }
      if (got.svc.verified?.checked === false) { fail('delegation', T('the holder could not be read on chain', '链上读不到持有人'), resignFix, cmd.console); blocked(SERVICE, 'delegation'); return finish() }
      record(d, T(`; signed by the holder ${identity.holder}`, `；由持有人 ${identity.holder} 签名`))
    }
  }

  // ------------------------------------------------------------------ the AI service / AI 服务
  const rawField = mode === 'url' ? served?.[ai.MANIFEST_FIELD] : manifest[ai.MANIFEST_FIELD]
  if (rawField === undefined) {
    const methods = manifest.methods?.length ? `: ${manifest.methods.slice(0, 4).map((m) => m.name).join(', ')}${manifest.methods.length > 4 ? ', ...' : ''}` : ''
    fail('ai-field', T(`the manifest has no ${ai.MANIFEST_FIELD} field: this service is not an AI service${methods ? ` (it serves ${manifest.methods.length} TapeAPI method(s)${methods})` : ''}`, `清单没有 ${ai.MANIFEST_FIELD} 字段：这不是 AI 服务${methods ? `（它提供 ${manifest.methods.length} 个 TapeAPI 方法${methods}）` : ''}`),
      T(`An AI service publishes its endpoints and price table in the ai field: run the sidecar in front of your gateway (examples/new-api-sidecar, examples/litellm-sidecar or examples/ai-proxy) and publish its manifest (console step 5).`, '要做 AI 服务，就要在 ai 字段里发布端点与价目表：把旁路放在你的网关前面（examples/new-api-sidecar、examples/litellm-sidecar 或 examples/ai-proxy），再发布它的清单（操作台第 5 步）。'), cmd.trial, { hint: trialHint })
    blocked(SERVICE.slice(1), 'ai-field'); return finish()
  }
  let field
  try { field = ai.validateAIField(rawField, { allowHttp }) } catch (e) {
    fail('ai-field', T(e.message, `ai 字段不合规：${e.message}`), T('Fix models.json (the sidecar validates it with the same rules and says which entry is wrong), restart the sidecar and publish again (console step 5).', '改正 models.json（旁路用同样的规则校验并指出哪一条不对），重启旁路，再发布一次（操作台第 5 步）。'), cmd.console)
    blocked(SERVICE.slice(1), 'ai-field'); return finish()
  }
  manifest = { ...manifest, [ai.MANIFEST_FIELD]: field }
  pass('ai-field', `${field.endpoints.length} endpoint(s), ${field.models.length} model(s)`)
  // prices / 价目表
  const all = priceHints(field), hints = all.filter((h) => !h.info), infos = all.filter((h) => h.info)
  if (hints.length) warn('prices', T(hints.map((h) => h.en).join('; '), hints.map((h) => h.zh).join('；')), T(`Check these prices in models.json (hints only; nothing is refused): ${hints.map((h) => h.en).join('; ')}`, `核对 models.json 里的这些价格（只是提示，不会被拒绝）：${hints.map((h) => h.zh).join('；')}`))
  else {
    const list = `${field.models.slice(0, 4).map((m) => `${m.id} ${m.prices.map((p) => `${p.input}/${p.output} ${p.currency}`).join(', ')}`).join('; ')}${field.models.length > 4 ? '; ...' : ''}`
    pass('prices', `${field.models.length} model(s): ${list} (per 1M tokens, published, not settled)${infos.map((h) => `; note: ${h.en}`).join('')}`)
  }
  // endpoints / 端点
  const eps = []
  const epProblems = []
  for (const e of field.endpoints) {
    const format = ai.FORMATS.find((f) => f.name === e.format)
    if (!format) { epProblems.push(T(`${e.format}: not a format this version knows; clients ignore it`, `${e.format}：这个版本不认识的格式，客户端会忽略`)); continue }
    const root = ai.rootOf(e.baseUrl, format)
    if (root === null) { epProblems.push(T(`${e.format}: ${e.baseUrl} should end with ${format.baseSuffix}; clients ignore it`, `${e.format}：${e.baseUrl} 应以 ${format.baseSuffix} 结尾；客户端会忽略`)); continue }
    if (format.baseSuffix === '' && /\/v1$/.test(e.baseUrl)) { epProblems.push(T(`${e.format}: ${e.baseUrl} is the service root itself, without /v1 (the SDKs add /v1)`, `${e.format}：${e.baseUrl} 应是服务根地址本身，不带 /v1（SDK 会自己加 /v1）`)); continue }
    eps.push({ format: e.format, baseUrl: e.baseUrl, root: root.replace(/\/+$/, '') })
  }
  const endpointsFix = T('Publish the endpoints the sidecar builds from PUBLIC_URL (console step 5).', '发布旁路按 PUBLIC_URL 生成的端点（操作台第 5 步）。')
  if (!eps.length) {
    fail('endpoints', epProblems.length ? T(epProblems.map((p) => p.en).join('; '), epProblems.map((p) => p.zh).join('；')) : T('no usable endpoint', '没有可用的端点'), endpointsFix, cmd.console)
    blocked(['reach', 'cors', 'receipt', 'receipt-lookup'], 'endpoints'); return finish()
  }
  // URL mode probes the address given, not the published one, and warns when they differ (ONB2-5).
  // 地址模式探测给出的地址而非发布的地址，两者不同时警告。
  let endpointsFixNow = endpointsFix
  if (mode === 'url') {
    const elsewhere = [...new Set(eps.filter((e) => place(e.root) !== place(given)).map((e) => e.root))]
    if (elsewhere.length) {
      epProblems.push(T(`the manifest publishes ${elsewhere.join(', ')}, not the address you gave (${given}); the checks below probe ${given}, while your users will call the published address`, `清单发布的是 ${elsewhere.join('、')}，不是你给出的地址（${given}）；下面的检查探测的是 ${given}，而你的用户会调用发布的地址`))
      endpointsFixNow = T(`Set PUBLIC_URL to the address your users call, restart the sidecar and publish again (console step 5); or run the doctor against the published address: ${cmd.doctor(elsewhere[0])}`, `把 PUBLIC_URL 设为用户实际调用的地址，重启旁路并重新发布（操作台第 5 步）；或者对发布的地址运行诊断：${cmd.doctor(elsewhere[0])}`)
    }
    for (const e of eps) e.root = given
  }
  if (epProblems.length) warn('endpoints', T(epProblems.map((p) => p.en).join('; '), epProblems.map((p) => p.zh).join('；')), endpointsFixNow)
  else pass('endpoints', eps.map((e) => `${e.format} ${e.baseUrl}`).join('; '))
  // reach / 可访问
  const roots = [...new Set(eps.map((e) => e.root))]
  const reachable = new Set()
  const reachProblems = [], reachWarnings = []
  for (const root of roots) {
    let r
    try { r = await http(root + '/tapeapi/v1/health', { headers: { accept: 'application/json' } }) } catch (e) { const p = netProblem(e, host(root)); reachProblems.push({ detail: T(`${root}: ${p.why.en}`, `${root}：${p.why.zh}`), fix: p.fix, transient: isTransient(p) }); continue }
    if (r.status >= 300 && r.status < 400) { reachProblems.push({ detail: T(`${root}/tapeapi/v1/health answers HTTP ${r.status} (a redirect to ${r.headers.get('location')})`, `${root}/tapeapi/v1/health 回答 HTTP ${r.status}（重定向到 ${r.headers.get('location')}）`), fix: T('Publish the exact address users must call: the sidecar and the verifiers never follow redirects.', '发布用户必须调用的确切地址：旁路与核验方都不跟随重定向。') }); continue }
    let h = null
    try { h = await r.json() } catch { /* not JSON */ }
    if (h?.setup) { reachProblems.push({ detail: T(`${root}: the sidecar is in SETUP MODE (${h.problem || `missing ${(h.missing || []).join(', ')}`})`, `${root}：旁路处于设置模式（${h.problem || `缺少 ${(h.missing || []).join('、')}`}）`), fix: T('Set the missing variables in .env (console steps 3 and 4 give them) and restart the sidecar.', '在 .env 里补上缺的变量（操作台第 3、4 步给出），重启旁路。') }); continue }
    if (!h || r.status !== 200) { reachProblems.push({ detail: T(`${root}/tapeapi/v1/health answers HTTP ${r.status}${h ? '' : ', not JSON'}: is this the sidecar?`, `${root}/tapeapi/v1/health 回答 HTTP ${r.status}${h ? '' : '，不是 JSON'}：这是旁路吗？`), fix: notSidecarFix }); continue }
    if (h.signer && !eq(h.signer, manifest.signer)) { reachProblems.push({ detail: T(`${root}: the sidecar signs as ${h.signer}, the manifest names ${manifest.signer}`, `${root}：旁路以 ${h.signer} 签名，清单写的是 ${manifest.signer}`), fix: T('The sidecar runs another key: set SIGNER_KEY to the service key the delegation names, or sign a new delegation (console step 4) and publish again.', '旁路用的是另一把密钥：把 SIGNER_KEY 设为委托所指的服务密钥，或重签委托（操作台第 4 步）再发布。') }); continue }
    if (h.ok === false) { reachProblems.push({ detail: T(`${root}: the sidecar reports ok: false (its delegation has lapsed)`, `${root}：旁路报告 ok: false（委托已失效）`), fix: T('Renew the delegation (console step 4, Renew) and restart the sidecar.', '续期委托（操作台第 4 步“续期”），重启旁路。') }); continue }
    if (mode !== 'url' && served === null) {
      try {
        const s = await (await http(root + MANIFEST_PATH, { headers: { accept: 'application/json' } })).json()
        if (canonicalJSON(s?.[ai.MANIFEST_FIELD] ?? null) !== canonicalJSON(rawField)) reachWarnings.push({ detail: T(`${root}: the sidecar serves a different ${ai.MANIFEST_FIELD} field than the chain (models.json changed and not republished?)`, `${root}：旁路提供的 ${ai.MANIFEST_FIELD} 字段与链上不同（models.json 改过但没有重新发布？）`), fix: T('Publish again (console step 5) so the prices on chain are the ones the sidecar signs.', '重新发布（操作台第 5 步），链上价目表才与旁路签的一致。') })
      } catch { /* the health answered; the manifest is optional here / health 已答，这里清单可选 */ }
    }
    reachable.add(root)
  }
  const joinT = (list) => T(list.map((p) => p.detail.en).join('; '), list.map((p) => p.detail.zh).join('；'))
  // only network failures: undecided, retry (exit 3); any other problem fails (exit 1) / 只有网络故障：未判定、重试；其它问题则失败
  if (reachProblems.length && reachProblems.every((p) => p.transient)) retry('reach', joinT(reachProblems), reachProblems[0].fix)
  else if (reachProblems.length) { const first = reachProblems.find((p) => !p.transient); fail('reach', joinT(reachProblems), first.fix, cmd.doctor(input)) }
  else if (reachWarnings.length) warn('reach', joinT(reachWarnings), reachWarnings[0].fix)
  else pass('reach', roots.map((r) => `${r} ${r.startsWith('https:') ? 'TLS ok, ' : ''}sidecar ready`).join('; '))
  const live = eps.filter((e) => reachable.has(e.root))
  if (!live.length) { blocked(['cors', 'receipt', 'receipt-lookup'], 'reach'); return finish() }

  // cors + receipt, per endpoint / 每个端点的 CORS 与回执
  const corsProblems = [], receiptFails = [], receiptWarns = [], receiptPasses = [], receiptNet = []
  // DOCR-2: the operator's key goes to the host given (URL mode) or the hosts of the signed endpoints.live, nowhere
  // else. / 密钥只发往被检查的主机。
  const keyHosts = new Set()
  if (mode === 'url') keyHosts.add(host(input).toLowerCase())
  else for (const u of manifest.endpoints?.live ?? []) keyHosts.add(host(u).toLowerCase())
  const keyRefusal = (url) => {
    let u
    try { u = new URL(url) } catch { return T('not a URL', '不是网址') }
    if (!keyHosts.has(u.host.toLowerCase())) { const hosts = [...keyHosts].join(', ') || 'none'; return T(`${u.host} is not the host being checked (${hosts}); the manifest cannot send your key elsewhere`, `${u.host} 不是被检查的主机（${hosts}）；清单不能把你的密钥发往别处`) }
    if (u.protocol === 'https:') return null
    if (u.protocol === 'http:' && LOOPBACK.test(u.hostname) && o.allowHttp === true) return null
    const lb = LOOPBACK.test(u.hostname)
    return T(`${u.host} is plain http: your key goes only over https (${lb ? 'pass --allow-http to send it to this loopback sidecar' : 'http is allowed only to a loopback sidecar with --allow-http'})`, `${u.host} 是明文 http：你的密钥只走 https（${lb ? '' : '仅对回环地址上的旁路，'}加 --allow-http 才允许 http）`)
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
      if (r.status >= 300 || !allowOrigin) corsProblems.push(T(`${e.format}: the preflight answered HTTP ${r.status}${allowOrigin ? '' : ' without Access-Control-Allow-Origin'}`, `${e.format}：预检回答 HTTP ${r.status}${allowOrigin ? '' : '，没有 Access-Control-Allow-Origin'}`))
      else {
        const missing = allowHeaders === '*' ? [] : wants.filter((w) => !allowHeaders.split(/\s*,\s*/).includes(w))
        if (missing.length) corsProblems.push(T(`${e.format}: the preflight does not allow ${missing.join(', ')}`, `${e.format}：预检不允许 ${missing.join('、')}`))
      }
    } catch (err) { const p = netProblem(err, host(url)); corsProblems.push(T(`${e.format}: ${p.why.en}`, `${e.format}：${p.why.zh}`)) }
    // a request with an invalid key: the gateway refuses, the sidecar signs the refusal / 无效密钥请求：网关拒绝，旁路为拒绝签回执
    const runs = [{ key: INVALID_KEY, real: false }, ...(o.key ? [{ key: o.key, real: true }] : [])]
    for (const run of runs) {
      const label = `${e.format}${run.real ? ' (your key)' : ''}`, labelZh = `${e.format}${run.real ? '（你的密钥）' : ''}`
      if (run.real) {
        const why = keyRefusal(url)
        if (why) { receiptWarns.push({ detail: T(`${label}: not sent: ${why.en}`, `${labelZh}：未发送：${why.zh}`), fix: T('Your key is sent only to the host you name, over https. Run the doctor against the sidecar that serves these endpoints, or publish endpoints on the host you run.', '你的密钥只发往你指定的主机、只走 https。请对提供这些端点的旁路运行诊断，或把端点发布在你运行的主机上。') }); continue }
      }
      const body = new TextEncoder().encode(JSON.stringify(probe.body(modelFor(e.format))))
      let r, bytes
      try {
        r = await http(url, { method: 'POST', headers: { 'content-type': 'application/json', origin, ...authHeaders(e.format, run.key) }, body })
        bytes = new Uint8Array(await r.arrayBuffer())
      } catch (err) {
        const p = netProblem(err, host(url))
        ;(isTransient(p) ? receiptNet : receiptFails).push({ detail: T(`${label}: ${p.why.en}`, `${labelZh}：${p.why.zh}`), fix: p.fix }); continue
      }
      if (!run.real) {
        const expose = (r.headers.get('access-control-expose-headers') || '').toLowerCase()
        if (!expose.includes(ai.RECEIPT_HEADER) && expose !== '*') corsProblems.push(T(`${e.format}: the answer does not expose ${ai.RECEIPT_HEADER} (Access-Control-Expose-Headers), so browser clients cannot read receipts`, `${e.format}：回答没有暴露 ${ai.RECEIPT_HEADER}（Access-Control-Expose-Headers），浏览器客户端读不到回执`))
      }
      if (r.headers.get(ai.SIDECAR_ERROR_HEADER) === '1' && !r.headers.get(ai.RECEIPT_HEADER)) {
        let why = ''
        try { why = String(JSON.parse(new TextDecoder().decode(bytes))?.error?.message ?? '') } catch { /* not JSON */ }
        const fix = r.status === 502 || r.status === 504 ? T('The sidecar cannot reach your gateway: check UPSTREAM_BASE_URL (for the compose package: http://new-api:3000/v1) and that the gateway runs.', '旁路连不上你的网关：检查 UPSTREAM_BASE_URL（compose 包里是 http://new-api:3000/v1），并确认网关在运行。')
          : r.status === 503 ? T('The sidecar is in setup mode: set the variables it names in /tapeapi/v1/health.', '旁路处于设置模式：补上 /tapeapi/v1/health 列出的变量。')
            : T('The sidecar refused the request itself; its log says why.', '旁路自己拒绝了请求；原因见它的日志。')
        receiptFails.push({ detail: T(`${label}: HTTP ${r.status} from the sidecar itself, no receipt (${why.slice(0, 160)})`, `${labelZh}：旁路自己回答了 HTTP ${r.status}，没有回执（${why.slice(0, 160)}）`), fix }); continue
      }
      const header = r.headers.get(ai.RECEIPT_HEADER)
      const stream = (r.headers.get('content-type') || '').toLowerCase().includes('text/event-stream')
      let envelope = null
      try { envelope = header ? ai.decodeReceiptHeader(header) : stream ? ai.readSseReceipt(new TextDecoder().decode(bytes)) : null } catch (err) { receiptFails.push({ detail: T(`${label}: the receipt header does not decode: ${err.message}`, `${labelZh}：回执头无法解码：${err.message}`), fix: T('Run the sidecar from this repository unchanged.', '使用本仓库原样的旁路。') }); continue }
      if (!envelope) {
        receiptFails.push({ detail: T(`${label}: HTTP ${r.status} with no ${ai.RECEIPT_HEADER} header: this address does not go through the sidecar`, `${labelZh}：HTTP ${r.status}，没有 ${ai.RECEIPT_HEADER} 头：这个地址没有经过旁路`), fix: T(`Point the published host at the sidecar (default 127.0.0.1:8080), not at the gateway, and check that the reverse proxy passes the x-tapeapi-* headers through; then run ${cmd.doctor(input)}`, `把发布的域名指向旁路（默认 127.0.0.1:8080），而不是网关，并确认反向代理原样透传 x-tapeapi-* 头；然后运行 ${cmd.doctor(input)}`) })
        continue
      }
      const v = ai.verifyUsageReceipt({ envelope, manifest, requestBytes: body, responseBytes: bytes, path: probe.path, status: r.status, stream, maxSkewS: 300, now: now() })
      if (!v.ok) { receiptFails.push({ detail: T(`${label}: the receipt does not verify: ${v.problems.join('; ')}`, `${labelZh}：回执核验不通过：${v.problems.join('; ')}`), fix: v.problems.some((p) => p.startsWith('signed by')) ? T('The sidecar signs with a key the manifest does not name: set SIGNER_KEY to the delegated service key, or publish again.', '旁路签名用的密钥不是清单写的：把 SIGNER_KEY 设为受委托的服务密钥，或重新发布。') : v.problems.some((p) => p.startsWith('signed at')) ? T('The sidecar clock is off: turn on NTP time sync on the server.', '旁路服务器时钟不准：打开 NTP 时间同步。') : T('Something between the client and the sidecar changes the bytes (a proxy that rewrites or compresses bodies): pass them through unchanged.', '客户端与旁路之间有东西改动了字节（改写或压缩正文的代理）：请原样透传。') }); continue }
      const res = envelope.result
      if (!run.real) {
        if (r.status === 401 || r.status === 403) receiptPasses.push(`${e.format}: HTTP ${r.status} to an invalid key, receipt verified (signer ${manifest.signer}; no tokens used)`)
        else if (r.status >= 200 && r.status < 300) { const out = e.format === 'openai-responses' ? 16 : 1; receiptWarns.push({ detail: T(`${e.format}: the gateway answered an invalid key with HTTP ${r.status} (receipt verified; this probe cost you a few input tokens and ${out} output token(s))`, `${e.format}：网关对无效密钥回答了 HTTP ${r.status}（回执核验通过；这次探测花了你几个输入 token 与 ${out} 个输出 token）`), fix: T('Your gateway accepted a key that cannot be valid: check its authentication. Until you do, every run of the doctor costs a few tokens per endpoint.', '你的网关接受了一个不可能有效的密钥：检查它的鉴权。在修好之前，每次运行诊断每个端点都会花掉几个 token。') }) }
        else receiptPasses.push(`${e.format}: HTTP ${r.status} to an invalid key, receipt verified (no tokens used)`)
        lookup ??= { root: e.root, id: envelope.id, sig: envelope.sig, requestSha256: envelope.params.requestSha256 }
      } else {
        const said = new TextDecoder().decode(bytes).slice(0, 160)
        if (r.status !== 200) receiptWarns.push({ detail: T(`${label}: HTTP ${r.status} (receipt verified): ${said}`, `${labelZh}：HTTP ${r.status}（回执核验通过）：${said}`), fix: T('Check the model and the key with your gateway (use --model to pick another model).', '在你的网关核对模型与密钥（可用 --model 换一个模型）。') })
        else if (!res.prices) receiptWarns.push({ detail: T(`${label}: receipt verified, but the upstream reported model ${res.model}, which is not in the price table`, `${labelZh}：回执核验通过，但上游报告的模型 ${res.model} 不在价目表里`), fix: T(`Add ${res.model} to models.json as an id or an alias, restart the sidecar and publish again.`, `把 ${res.model} 作为 id 或别名加进 models.json，重启旁路并重新发布。`) })
        else { const s = `model ${res.model}, tokens ${res.usage ? `${res.usage.prompt_tokens}+${res.usage.completion_tokens}` : '-'}, ${res.prices.map((p) => `${p.amount} ${p.currency}`).join(' / ')}`; receiptPasses.push(`${label}: HTTP 200, ${s}, receipt verified`) }
      }
      if (v.warnings.length && run.real) receiptWarns.push({ detail: T(`${label}: ${v.warnings.join('; ')}`, `${labelZh}：${v.warnings.join('; ')}`), fix: T('See the warning; the receipt itself verified.', '见警告；回执本身核验通过。') })
    }
  }
  if (corsProblems.length) warn('cors', T(corsProblems.map((p) => p.en).join('; '), corsProblems.map((p) => p.zh).join('；')), T('Only browser clients need this. Put the sidecar in front unchanged: it answers preflights and exposes the receipt header; do not let the reverse proxy strip Access-Control-* headers.', '只有浏览器客户端需要。让旁路原样处在最前面：它回答预检并暴露回执头；不要让反向代理去掉 Access-Control-* 头。'))
  else pass('cors', `preflight allowed from ${origin}; ${ai.RECEIPT_HEADER} exposed`)
  const joinR = (list) => T(list.map((x) => x.detail?.en ?? x).join('; '), list.map((x) => x.detail?.zh ?? x).join('；'))
  // a failure or a retry still names the warnings (a key not sent, and why) / 失败或重试时仍列出警告（例如密钥未发送及原因）
  if (receiptFails.length) fail('receipt', joinR([...receiptFails, ...receiptNet, ...receiptWarns]), receiptFails[0].fix, cmd.doctor(input))
  else if (receiptNet.length) retry('receipt', joinR([...receiptPasses, ...receiptNet, ...receiptWarns]), receiptNet[0].fix)
  else if (receiptWarns.length) warn('receipt', joinR([...receiptPasses, ...receiptWarns]), receiptWarns[0].fix)
  else pass('receipt', receiptPasses.join('; '))
  // receipt lookup / 取回执
  if (!lookup) skip('receipt-lookup', T('no receipt to look up', '没有可取的回执'))
  else {
    try {
      const r = await http(lookup.root + `/tapeapi/v1/${ai.RECEIPT_METHOD}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'tapeapi-doctor', method: ai.RECEIPT_METHOD, params: { id: lookup.id, requestSha256: lookup.requestSha256 } }) })
      const j = await r.json().catch(() => null)
      if (r.status === 429) warn('receipt-lookup', T('rate limited (the free receipt method allows a few lookups per minute per IP)', '被限流（免费的回执方法每个 IP 每分钟只允许几次查询）'), T('Run the doctor again in a minute.', '一分钟后再运行诊断。'))
      else if (j?.ok && j.result?.sig === lookup.sig) pass('receipt-lookup', `receipt ${lookup.id} returned, same signature`)
      else warn('receipt-lookup', T(`the free receipt method did not return the receipt (HTTP ${r.status}${j?.error ? `, ${j.error.code}` : ''})`, `免费的回执方法没有返回这份回执（HTTP ${r.status}${j?.error ? `，${j.error.code}` : ''}）`), T('Users can still read the receipt from the answer; check that /tapeapi/v1/* reaches the sidecar.', '用户仍可从回答里读到回执；检查 /tapeapi/v1/* 是否到达旁路。'))
    } catch (e) { const p = netProblem(e, host(lookup.root)); warn('receipt-lookup', p.why, p.fix) }
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

/** Plain-text report. lang 'en' or 'zh' prints that language only (ONB2-7), 'both' both. / 纯文本报告。 */
export function formatReport(report, { lang = 'both', version = '' } = {}) {
  const L = (t) => (lang === 'en' ? t.en : lang === 'zh' ? t.zh : `${t.en} / ${t.zh}`)
  const mark = { pass: 'PASS', warn: 'WARN', fail: 'FAIL', skip: 'SKIP', error: 'ERR ' }
  const chainName = CHAINS[report.chainId]?.name ?? `chain ${report.chainId}`
  const what = report.mode === 'url' ? T('sidecar URL', '旁路地址') : report.mode === 'name' ? T(`TapeOut name, ${chainName}`, `TapeOut 名字，${chainName}`) : T('container', '容器')
  const lines = [`tapeapi-doctor${version ? ` ${version}` : ''}: ${report.target} (${L(what)})`]
  report.checks.forEach((c, i) => {
    lines.push(`${String(i + 1).padStart(2)} ${mark[c.status]}  ${L(c.title)}`)
    const dz = c.detailZh ?? c.detail
    if (lang === 'en' && c.detail) lines.push(`         ${c.detail}`)
    else if (lang === 'zh' && dz) lines.push(`         ${dz}`)
    else if (c.detail) {
      // both: a skip on one line, otherwise one line each / 双语：skip 一行，其余各一行
      if (dz === c.detail) lines.push(`         ${c.detail}`)
      else if (c.status === 'skip') lines.push(`         ${c.detail} / ${dz}`)
      else lines.push(`         ${c.detail}`, `         ${dz}`)
    }
    if (c.fix && c.status !== 'pass') {
      if (lang !== 'zh') lines.push(`         fix:  ${c.fix.en}`)
      if (lang !== 'en') lines.push(`         修复: ${c.fix.zh}`)
    }
    if (c.hint && c.status === 'fail') {
      if (lang !== 'zh') lines.push(`         note: ${c.hint.en}`)
      if (lang !== 'en') lines.push(`         提示: ${c.hint.zh}`)
    }
    if (c.next && c.status === 'fail') lines.push(`         ${L(T('next:', '下一条命令:'))} ${c.next}`)
  })
  const k = report.counts
  lines.push(L(T(`result: ${k.pass} passed, ${k.warn} warned, ${k.fail} failed, ${k.skip} skipped${k.error ? `, ${k.error} undecided` : ''}; exit ${report.exitCode}`,
    `结果：${k.pass} 项通过，${k.warn} 项警告，${k.fail} 项失败，${k.skip} 项跳过${k.error ? `，${k.error} 项无法判定` : ''}；退出码 ${report.exitCode}`)))
  return lines.join('\n')
}
