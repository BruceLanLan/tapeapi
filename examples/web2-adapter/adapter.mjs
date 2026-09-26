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

export const expandEnv = (s, env = process.env) => String(s).replace(/\$\{([A-Z0-9_]+)\}/g, (_, k) => env[k] ?? '')

// 头部只来自配置（可展开 ${ENV}），调用方参数永远不进入头部 / headers come from config only, never from caller params.
export function buildHeaders(layers, env = process.env) {
  const out = {}
  for (const layer of layers) {
    if (!layer || typeof layer !== 'object') continue
    for (const [k, v] of Object.entries(layer)) {
      if (!/^[A-Za-z0-9-]+$/.test(k)) throw new TapeAPIError('INTERNAL', `bad header name in adapter config: ${k}`)
      const val = expandEnv(v, env)
      if (val === '') continue // 空值（未设置的 env）丢弃 / drop empty (unset env) headers
      if (!HEADER_VALUE_RE.test(val)) throw new TapeAPIError('INTERNAL', `bad header value for ${k}`)
      out[k.toLowerCase()] = val
    }
  }
  return out
}
export const pickPath = (obj, path) => path.split('.').reduce((o, k) => (o == null || k === '__proto__' || k === 'constructor' || k === 'prototype' ? undefined : o[k]), obj)

// 解析模板：静态前缀必须是完整 origin + 路径前缀；{param} 不能出现在 origin 里 / parse a template: the static prefix
// (everything before the first `{`) must already be a full URL, so a parameter can never change the origin.
export function parseTemplate(url) {
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) throw new TapeAPIError('INTERNAL', `adapter url must be http(s): ${url}`)
  const cut = url.indexOf('{')
  const staticPart = cut < 0 ? url : url.slice(0, cut)
  let base
  try { base = new URL(staticPart) } catch { throw new TapeAPIError('INTERNAL', `adapter url template must start with a full origin and static path: ${url}`) }
  if (cut >= 0 && staticPart.length <= base.origin.length + 1) throw new TapeAPIError('INTERNAL', `adapter url template must not place {param} in the origin: ${url}`)
  if (base.search || base.hash) throw new TapeAPIError('INTERNAL', `adapter url must not contain query/fragment; use "query": ${url}`)
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
export function makeHandler(name, m, { config = {}, fetch: fetchImpl = globalThis.fetch, env = process.env, log = () => {} } = {}) {
  const tpl = parseTemplate(m.url)
  const upstreamHeaders = config.upstream?.headers
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
    const headers = buildHeaders([upstreamHeaders, m.headers], env) // never caller-supplied / 永远不来自调用方
    let body
    if (method !== 'GET' && method !== 'HEAD') {
      const payload = m.body === '*'
        ? Object.fromEntries(Object.keys(m.params || {}).filter(k => p[k] !== undefined).map(k => [k, p[k]])) // "*" = declared params only
        : Object.fromEntries(Object.entries(m.body || {}).filter(([, param]) => p[param] !== undefined).map(([k, param]) => [k, p[param]]))
      body = JSON.stringify(payload); headers['content-type'] = 'application/json'
    }
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeoutMs)
    let res, text
    try { res = await fetchImpl(url, { method, headers, body, signal: ac.signal }); text = await res.text() }
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
