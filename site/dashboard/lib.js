// "My services" dashboard: pure helpers, no DOM and no storage at module scope, so Node can test them offline
// (scripts/dashboard.test.mjs). / “我的服务”面板的纯函数：模块顶层不碰 DOM 与存储，Node 可离线测试。
import { chainByArea } from '../playground/vendor/8afe01483c/tapeapi-sdk/chains.js'

export const STORAGE_KEY = 'tapeapi.dashboard'
export const PUBLIC_EXAMPLES = Object.freeze(['11.1013.tape', '12.1013.tape'])
export const WARN_DAYS = 14          // same rule as site/status/ / 与状态页相同
export const MAX_SERVICES = 50       // a list is for people, not a crawler / 列表给人用，不是爬虫
export const HEALTH_PATH = '/tapeapi/v1/health'

// The SDK's own spellings: <#ID>.<processor>.tape (BNB Smart Chain), <#ID>.<area>.<processor>.tape (X Layer area 2,
// Base area 3), or a container address. / 与 SDK 的写法一致：BNB 名字不带区号，X Layer（2）与 Base（3）带区号。
const NAME_RE = /^(\d{1,15})\.(?:(\d{1,7})\.)?(\d{1,15})\.tape$/i
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/

/**
 * Read one entry typed by the user. Returns { kind: 'name', key, id, processor } (plus `area` and `chainId` for a name
 * on X Layer or Base) or { kind: 'container', key }, or null when it is neither (an unassigned area code included). `key` is the normalised form stored in the list (names without leading zeros and in
 * lower case, addresses in lower case) so the same service is never listed twice.
 * 读取用户输入的一项。返回名称或容器；都不是则为 null。key 是存进列表的规范形式，同一服务不会重复。
 */
export function parseInput(input) {
  if (typeof input !== 'string') return null
  const s = input.trim()
  if (s.length > 100) return null
  let m
  if ((m = NAME_RE.exec(s))) {
    const id = BigInt(m[1]), processor = BigInt(m[3])
    if (id < 1n) return null   // #ID starts at 1 / #ID 从 1 开始
    if (m[2] === undefined) return { kind: 'name', key: `${id}.${processor}.tape`, id: id.toString(), processor: processor.toString() }
    // area codes 0 and 1 are reserved and a BNB name carries none: only an assigned code names a chain / 只认已分配的区号
    const area = Number(m[2]), chain = area > 1 ? chainByArea(area) : null
    if (!chain) return null
    return { kind: 'name', key: `${id}.${area}.${processor}.tape`, id: id.toString(), processor: processor.toString(), area, chainId: chain.chainId }
  }
  if (ADDR_RE.test(s)) return { kind: 'container', key: s.toLowerCase() }
  return null
}

/**
 * Days until a delegation expires, and how worried to be. `expiresS` and `nowS` are unix seconds.
 * 'expired' when expires <= now; 'warn' under 14 days; 'ok' otherwise; 'unknown' when there is no number.
 * 委托还剩几天、该不该担心：过期、不足 14 天、正常、未知。
 */
export function classifyExpiry(expiresS, nowS = Math.floor(Date.now() / 1000)) {
  if (typeof expiresS !== 'number' || !Number.isFinite(expiresS)) return { days: null, state: 'unknown' }
  const days = Math.floor((expiresS - nowS) / 86400)
  if (expiresS <= nowS) return { days, state: 'expired' }
  return { days, state: days < WARN_DAYS ? 'warn' : 'ok' }
}

/**
 * The health URL for a manifest's live endpoint. Live endpoints look like https://host/tapeapi/v1; the provider
 * runtime answers GET /tapeapi/v1/health at the origin. Anything that is not an https URL (or http on a loopback
 * address) gives null.
 * 由清单的 live 端点得到健康检查地址。端点形如 https://host/tapeapi/v1，健康检查在 /tapeapi/v1/health。
 */
export function healthUrl(endpoint) {
  if (typeof endpoint !== 'string') return null
  let u
  try { u = new URL(endpoint.trim()) } catch { return null }
  const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]'
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) return null
  if (u.username || u.password) return null
  const base = u.pathname.replace(/\/+$/, '').replace(/\/tapeapi\/v1$/i, '')
  return `${u.origin}${base}${HEALTH_PATH}`
}

/** Same address, any letter case. / 同一地址，不分大小写。 */
export function sameAddress(a, b) {
  return typeof a === 'string' && typeof b === 'string' && ADDR_RE.test(a) && ADDR_RE.test(b) && a.toLowerCase() === b.toLowerCase()
}

/** Keep only entries that parse, normalised, first occurrence wins, at most MAX_SERVICES. / 只留能解析的项，去重、限量。 */
export function cleanList(list) {
  if (!Array.isArray(list)) return []
  const out = []
  for (const x of list) {
    const p = parseInput(x)
    if (p && !out.includes(p.key)) out.push(p.key)
    if (out.length >= MAX_SERVICES) break
  }
  return out
}

/**
 * Load the list from a storage-like object ({ getItem }). Missing, unreadable, or malformed data gives [] or the
 * readable part of it; it never throws (a private window's storage may throw on access).
 * 从类似 localStorage 的对象读取列表。缺失、读不了或格式不对都得到 [] 或其中可读的部分；绝不抛错。
 */
export function loadList(storage) {
  let raw
  try { raw = storage?.getItem(STORAGE_KEY) } catch { return [] }
  if (typeof raw !== 'string' || raw === '') return []
  let v
  try { v = JSON.parse(raw) } catch { return [] }
  // The stored shape is { v: 1, services: [...] }; a bare array is accepted too. / 存储格式为 { v, services }，也接受裸数组。
  if (v && typeof v === 'object' && !Array.isArray(v)) v = v.services
  return cleanList(v)
}

/** Save the cleaned list; returns what was saved, or null when storage refused. / 保存清理后的列表；存储拒绝时返回 null。 */
export function saveList(storage, list) {
  const services = cleanList(list)
  try { storage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, services })) } catch { return null }
  return services
}

/** Add one entry (by its normalised key) to the end, unless already there or the list is full. / 追加一项。 */
export function addTo(list, input) {
  const p = parseInput(input)
  const cur = cleanList(list)
  if (!p) return { list: cur, added: false, reason: 'bad' }
  if (cur.includes(p.key)) return { list: cur, added: false, reason: 'dup' }
  if (cur.length >= MAX_SERVICES) return { list: cur, added: false, reason: 'full' }
  return { list: [...cur, p.key], added: true, reason: null }
}

/** Remove one entry by key. / 按 key 删除一项。 */
export function removeFrom(list, key) {
  return cleanList(list).filter((k) => k !== key)
}
