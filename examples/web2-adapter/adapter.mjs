// Web2 适配器核心：把 adapter.config.json 的一个方法映射成 (params) => result 处理器。与 HTTP 服务器分离以便测试。
// Web2 adapter core: turns one adapter.config.json method into a (params) => result handler. Kept separate from the
// server bootstrap so the URL templating / parameter rules can be unit-tested (review H-04, M-13).
import { TapeAPIError } from '@tapeapi/sdk'

const bad = (msg) => { throw new TapeAPIError('BAD_REQUEST', msg) }
const isPrimitive = (v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
const PARAM_RE = /\{([A-Za-z0-9_]+)\}/g
// 路径段里禁止的内容：分隔符、点段、查询/片段起始符、控制字符 / never allowed inside a path segment
const PATH_SEGMENT_BAD = /[/\\?#\x00-\x1f\x7f]|\.\./
// 头部值只允许可打印 ASCII / header values: printable ASCII only
const HEADER_VALUE_RE = /^[\x20-\x7e]*$/

const ENV_RE = /\$\{([A-Z0-9_]+)\}/g
// ${NAME} expands only from the env object the caller passes, never from process.env or a Worker's bindings: on a
// shared host a header "${KEK_V1}" would otherwise send a platform secret upstream (FIXED H-HOSTED-1). A name that is
// not a key of env is a config error; a key whose value is undefined drops the header, as before.
// ${NAME} 只从调用方显式传入的 env 对象展开，绝不读 process.env 或 Worker 绑定：否则在共享主机上，头部 "${KEK_V1}" 会把平台密钥
// 发给上游（FIXED H-HOSTED-1）。env 里没有这个键是配置错误；有键但值为 undefined 时照旧丢弃该头部。
export const expandEnv = (s, env = {}) => String(s).replace(ENV_RE, (_, k) => {
  if (!env || !Object.prototype.hasOwnProperty.call(env, k)) throw new TapeAPIError('INTERNAL', `adapter config uses \${${k}} but it is not in the env passed to the adapter`)
  return env[k] ?? ''
})
export const envNames = (layers) => layers.flatMap((l) => l && typeof l === 'object' ? Object.values(l).flatMap((v) => [...String(v).matchAll(ENV_RE)].map((m) => m[1])) : [])

// ---- upstream policy / 上游策略 ----
// 'open' (self-hosted, the default) keeps the historical rules: http(s), any host. 'hosted' is for a platform running
// other people's configs: https on 443 only, no IP literal, no userinfo, no local or platform host, at most 3 hosts,
// no redirects, a header allow-list, a fixed User-Agent and, when a resolver is given, no private or reserved address.
// 'open'（自托管，默认）保留原规则。'hosted' 用于替别人运行配置的平台：只许 443 端口的 https、不许 IP 字面量与 userinfo、
// 不许本地或平台主机、最多 3 个主机、不跟随跳转、头部白名单、固定 User-Agent；给了解析器时还拒绝私有与保留地址。
export const HOSTED_POLICY = Object.freeze({
  name: 'hosted', httpsOnly: true, maxHosts: 3, maxBodyBytes: 256 * 1024, redirects: false,
  denyHosts: ['tapeapi.fun'], userAgent: 'TapeAPI-Hosting (+https://tapeapi.fun/abuse)',
  headers: ['accept', 'accept-language', 'authorization', 'x-api-key', 'api-key', 'x-api-token', 'x-auth-token'],
})
export const OPEN_POLICY = Object.freeze({ name: 'open', httpsOnly: false, maxHosts: Infinity, maxBodyBytes: 1024 * 1024, redirects: true, denyHosts: [], userAgent: null, headers: null })
const LOCAL_SUFFIXES = ['localhost', 'local', 'internal', 'arpa', 'lan', 'home', 'corp', 'intranet', 'test', 'invalid', 'example']
const endsWithHost = (host, d) => host === d || host.endsWith('.' + d)

/** Throws INTERNAL when a configured upstream URL is not allowed under the policy. / 上游网址不被策略允许时抛 INTERNAL。 */
export function checkUpstreamUrl(u, policy = OPEN_POLICY) {
  const url = u instanceof URL ? u : new URL(u)
  const no = (why) => { throw new TapeAPIError('INTERNAL', `upstream ${url.origin} not allowed: ${why}`) }
  if (url.protocol !== 'https:' && (policy.httpsOnly || url.protocol !== 'http:')) no('https only')
  if (policy.name === 'open') return url
  if (url.port !== '') no('port 443 only')
  if (url.username || url.password) no('no user:password@ in the URL')
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  // The URL parser already turns 0x7f.1, 2130706433 and 0177.0.0.1 into 127.0.0.1, and IPv6 keeps its brackets.
  // URL 解析器已把 0x7f.1、2130706433、0177.0.0.1 规范成 127.0.0.1，IPv6 保留方括号。
  if (host.startsWith('[') || /^\d+\.\d+\.\d+\.\d+$/.test(host)) no('an IP address; use a host name')
  if (!host.includes('.')) no('a single-label host')
  for (const d of [...LOCAL_SUFFIXES, ...policy.denyHosts]) if (endsWithHost(host, d)) no(`${d} is not reachable from here`)
  return url
}

/** Private, loopback, link-local, CGNAT, multicast and reserved addresses, IPv4 and IPv6. / 私有、回环、链路本地等保留地址。 */
export function isPrivateIp(ip) {
  const s = String(ip).toLowerCase()
  const v4 = s.match(/^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (v4) {
    const [a, b] = [+v4[1], +v4[2]]
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19))
  }
  if (!s.includes(':')) return true   // not an address at all: refuse / 根本不是地址：拒绝
  return s === '::' || s === '::1' || /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || /^ff/.test(s) || s.startsWith('64:ff9b:') || s.startsWith('2001:db8')
}

// Read a response body up to a byte cap; a larger body is an upstream error, never a memory spike on a shared isolate.
// 按字节上限读取响应体；超过上限就是上游错误，绝不在共享实例上吃光内存。
export async function readCapped(res, cap) {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > cap) throw new Error(`body of ${declared} bytes exceeds ${cap}`)
  if (!res.body) return ''
  const reader = res.body.getReader(); const chunks = []; let n = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    n += value.byteLength
    if (n > cap) { try { await reader.cancel() } catch {} ; throw new Error(`body exceeds ${cap} bytes`) }
    chunks.push(value)
  }
  const all = new Uint8Array(n); let o = 0
  for (const c of chunks) { all.set(c, o); o += c.byteLength }
  return new TextDecoder().decode(all)
}

// 头部只来自配置（可展开 ${ENV}），调用方参数永远不进入头部 / headers come from config only, never from caller params.
export function buildHeaders(layers, env = {}, policy = OPEN_POLICY) {
  const out = {}
  for (const layer of layers) {
    if (!layer || typeof layer !== 'object') continue
    for (const [k, v] of Object.entries(layer)) {
      if (!/^[A-Za-z0-9-]+$/.test(k)) throw new TapeAPIError('INTERNAL', `bad header name in adapter config: ${k}`)
      if (policy.headers && !policy.headers.includes(k.toLowerCase())) throw new TapeAPIError('INTERNAL', `header ${k} is not allowed here (allowed: ${policy.headers.join(', ')})`)
      const val = expandEnv(v, env)
      if (val === '') continue // 空值（未设置的 env）丢弃 / drop empty (unset env) headers
      if (!HEADER_VALUE_RE.test(val)) throw new TapeAPIError('INTERNAL', `bad header value for ${k}`)
      out[k.toLowerCase()] = val
    }
  }
  if (policy.userAgent) out['user-agent'] = policy.userAgent
  return out
}
export const pickPath = (obj, path) => path.split('.').reduce((o, k) => (o == null || k === '__proto__' || k === 'constructor' || k === 'prototype' ? undefined : o[k]), obj)

// 解析模板：静态前缀必须是完整 origin + 路径前缀；{param} 不能出现在 origin 里 / parse a template: the static prefix
// (everything before the first `{`) must already be a full URL, so a parameter can never change the origin.
export function parseTemplate(url, policy = OPEN_POLICY) {
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) throw new TapeAPIError('INTERNAL', `adapter url must be http(s): ${url}`)
  const cut = url.indexOf('{')
  const staticPart = cut < 0 ? url : url.slice(0, cut)
  let base
  try { base = new URL(staticPart) } catch { throw new TapeAPIError('INTERNAL', `adapter url template must start with a full origin and static path: ${url}`) }
  if (cut >= 0 && staticPart.length <= base.origin.length + 1) throw new TapeAPIError('INTERNAL', `adapter url template must not place {param} in the origin: ${url}`)
  if (base.search || base.hash) throw new TapeAPIError('INTERNAL', `adapter url must not contain query/fragment; use "query": ${url}`)
  checkUpstreamUrl(base, policy)
  const names = [...url.matchAll(PARAM_RE)].map(m => m[1])
  return { url, origin: base.origin, pathPrefix: base.pathname, names }
}

// 校验并编码一个路径参数值 / validate and encode one path-segment value (H-04)
export function pathSegment(name, v) {
  if (v == null) bad(`param "${name}" required`)
  if (!isPrimitive(v)) bad(`param "${name}" must be a string, number or boolean`)
  const s = String(v)
  if (s === '' || s === '.' || s.length > 256) bad(`param "${name}" must be a non-empty path segment (max 256 chars)`)
  if (PATH_SEGMENT_BAD.test(s)) bad(`param "${name}" must not contain "/", "\\\\", "..", "?", "#" or control characters`)
  return encodeURIComponent(s)
}

// 构造上游 URL 并断言 origin / 路径前缀未变 / build the upstream URL and assert origin + path prefix are unchanged
export function buildUrl(tpl, p, query) {
  const filled = tpl.url.replace(PARAM_RE, (_, k) => pathSegment(k, p[k]))
  const url = new URL(filled)
  if (url.origin !== tpl.origin || !url.pathname.startsWith(tpl.pathPrefix)) throw new TapeAPIError('INTERNAL', `templated URL escaped the configured prefix for ${tpl.url}`)
  for (const [q, param] of Object.entries(query || {})) {
    if (p[param] === undefined) continue
    if (!isPrimitive(p[param])) bad(`param "${param}" must be a string, number or boolean`)
    url.searchParams.set(q, String(p[param]))
  }
  return url
}

// 一个方法 → 处理器 / one config method -> handler
// env: the ONLY values ${NAME} may expand to, passed explicitly (no process.env default). policy: OPEN_POLICY or
// HOSTED_POLICY. resolve: optional async (host) => [ip, ...], checked against isPrivateIp before every call.
// env：${NAME} 唯一可展开的值，必须显式传入（不再默认 process.env）。policy：OPEN_POLICY 或 HOSTED_POLICY。
// resolve：可选的 async (host) => [ip, ...]，每次调用前用 isPrivateIp 检查。
export function makeHandler(name, m, { config = {}, fetch: fetchImpl = globalThis.fetch, env = {}, log = () => {}, policy = OPEN_POLICY, resolve } = {}) {
  const tpl = parseTemplate(m.url, policy)
  const upstreamHeaders = config.upstream?.headers
  // Config errors surface when the service is created, not on its first call. / 配置错误在创建服务时暴露，而不是第一次调用时。
  for (const k of envNames([upstreamHeaders, m.headers])) expandEnv(`\${${k}}`, env)
  buildHeaders([upstreamHeaders, m.headers], Object.fromEntries(envNames([upstreamHeaders, m.headers]).map((k) => [k, 'x'])), policy)
  const timeoutMs = m.timeoutMs ?? config.upstream?.timeoutMs ?? 8000
  const method = (m.method || 'GET').toUpperCase()
  const declared = new Set([...Object.keys(m.params || {}), ...Object.values(m.query || {}), ...Object.values(typeof m.body === 'object' && m.body ? m.body : {}), ...tpl.names, ...Object.keys(m.defaults || {})])
  return async (params) => {
    if (!params || typeof params !== 'object' || Array.isArray(params)) bad('params must be object')
    // 只接受清单里声明过的参数 / only declared params are honoured; anything else is ignored, never forwarded
    const p = { ...(m.defaults || {}) }
    for (const k of declared) if (Object.prototype.hasOwnProperty.call(params, k) && params[k] !== undefined) p[k] = params[k]
    for (const r of m.required || []) if (p[r] === undefined || p[r] === null || p[r] === '') bad(`param "${r}" required`)
    const url = buildUrl(tpl, p, m.query)
    const headers = buildHeaders([upstreamHeaders, m.headers], env, policy) // never caller-supplied / 永远不来自调用方
    let body
    if (method !== 'GET' && method !== 'HEAD') {
      const payload = m.body === '*'
        ? Object.fromEntries(Object.keys(m.params || {}).filter(k => p[k] !== undefined).map(k => [k, p[k]])) // "*" = declared params only
        : Object.fromEntries(Object.entries(m.body || {}).filter(([, param]) => p[param] !== undefined).map(([k, param]) => [k, p[param]]))
      body = JSON.stringify(payload); headers['content-type'] = 'application/json'
    }
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeoutMs)
    let res, text
    try {
      if (resolve) {
        const ips = await resolve(url.hostname)
        if (!Array.isArray(ips) || !ips.length || ips.some(isPrivateIp)) throw new Error(`${url.hostname} resolves to a private or reserved address (${ips})`)
      }
      res = await fetchImpl(url, { method, headers, body, signal: ac.signal, redirect: policy.redirects ? 'follow' : 'manual' })
      if (!policy.redirects && (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400))) throw new Error(`redirect (http ${res.status}) refused`)
      text = await readCapped(res, policy.maxBodyBytes)
    }
    catch (e) { log(`upstream ${name} unreachable`, e.cause?.message || e.message); throw new TapeAPIError('INTERNAL', `upstream ${name} unreachable`) }
    finally { clearTimeout(t) }
    let json; try { json = JSON.parse(text) } catch { json = null }
    if (!res.ok) {
      // 上游错误文本只进日志，不透传给调用者（M-13）/ upstream error text goes to the log only, never to the caller
      log(`upstream ${name} http ${res.status}`, text.slice(0, 500))
      if (res.status >= 400 && res.status < 500) bad(`upstream ${name} rejected the request (http ${res.status})`)
      throw new TapeAPIError('INTERNAL', `upstream ${name} http ${res.status}`)
    }
    if (json === null || typeof json !== 'object') throw new TapeAPIError('INTERNAL', `upstream ${name} did not return JSON`)
    if (!m.pick) return json
    const out = {}
    for (const [k, path] of Object.entries(m.pick)) { const v = pickPath(json, path); out[k] = v === undefined ? null : v } // undefined 不能签名 / undefined is not canonical JSON
    return out
  }
}

export function buildMethods(config, opts = {}) {
  const policy = opts.policy || OPEN_POLICY
  const hosts = new Set(Object.values(config.methods || {}).map((m) => new URL(parseTemplate(m.url, policy).origin).hostname))
  if (hosts.size > policy.maxHosts) throw new TapeAPIError('INTERNAL', `adapter config names ${hosts.size} upstream hosts; at most ${policy.maxHosts} here`)
  return Object.fromEntries(Object.entries(config.methods).map(([name, m]) => [name, makeHandler(name, m, { ...opts, config })]))
}

// 从配置生成 manifest.methods / manifest.methods generated from the adapter config
export function manifestMethods(config) {
  return Object.entries(config.methods).map(([name, m]) => ({
    name, priceBEM: String(m.priceBEM ?? '0'),
    params: m.params || Object.fromEntries([...Object.values(m.query || {}), ...Object.values(typeof m.body === 'object' && m.body ? m.body : {}), ...[...String(m.url).matchAll(PARAM_RE)].map(x => x[1])].map(p => [p, 'string'])),
    returns: m.returns || {},
  }))
}
