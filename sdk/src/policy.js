// A local policy file and the claims of receipts (@experimental; pure, no file and no network): what `tapeapi reconcile
// --policy` reports against and what a client-side budget (budget.js: createVerifyingFetch({ policy }), the agent kit's
// limiter) refuses with, read by the same code so the two count alike. Moved here from reconcile-checks.js (3.0) so that
// ai.js can use it without an import cycle; reconcile-checks.js re-exports every name. It imports only the format
// adapters (pure data) and the error type.
// 本地策略文件与回执的声称（实验性；纯函数，不读文件、不联网）：tapeapi reconcile --policy 据以报告、客户端预算（budget.js）据以拒绝，
// 两者用同一份代码计数。3.0 从 reconcile-checks.js 移到这里，使 ai.js 能用它而不形成循环引用；reconcile-checks.js 重新导出全部名字。
import { openaiChat } from './ai-openai-chat.js'
import { openaiResponses } from './ai-openai-responses.js'
import { anthropicMessages } from './ai-anthropic-messages.js'
import { openaiEmbeddings } from './ai-openai-embeddings.js'

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const uint = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null)
// the built-in formats by receipt method, as ai.formatOfMethod finds them / 按回执方法找内置格式，与 ai.formatOfMethod 相同
const BUILT_IN = [openaiChat, openaiResponses, anthropicMessages, openaiEmbeddings]
const formatNameOf = (method) => BUILT_IN.find((f) => f.method === method)?.name

// ---------------------------------------------------------------------------------------------------------------
// Claims: what one receipt claims, in the fields the checks use / 一张回执声称的内容
// ---------------------------------------------------------------------------------------------------------------
/**
 * The claim of one receipt record (a 2xx result with usage), or null. / 一条回执记录的声称（2xx 且带用量），否则为 null。
 */
export function claimOf(rec) {
  const e = rec?.envelope
  if (!isObj(e)) return null
  const r = e.result, u = r?.usage
  if (!(Number.isInteger(r?.status) && r.status >= 200 && r.status < 300 && isObj(u))) return null
  return {
    rec, source: rec.source, id: typeof e.id === 'string' ? e.id : '', container: typeof e.container === 'string' ? e.container : null,
    format: formatNameOf(e.method), model: typeof r.model === 'string' ? r.model : null, modelMatchedBy: typeof r.modelMatchedBy === 'string' ? r.modelMatchedBy : null,
    stream: typeof r.stream === 'boolean' ? r.stream : null, prompt: uint(u.prompt_tokens), completion: uint(u.completion_tokens), reasoning: uint(u.reasoning_tokens),
    prices: Array.isArray(r.prices) ? r.prices.filter(isObj) : null, t: Number.isSafeInteger(e.ts) ? e.ts : null,
    requestSha256: typeof e.params?.requestSha256 === 'string' ? e.params.requestSha256.toLowerCase() : null,
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Amounts / 金额
// ---------------------------------------------------------------------------------------------------------------
export const SCALE = 8
/** A decimal string with at most 8 places as an integer of 1e-8 units, or null. / 至多 8 位小数的十进制串，换成 1e-8 单位的整数。 */
export function units8(s) {
  if (typeof s !== 'string' || !/^\d+(\.\d{1,8})?$/.test(s.trim())) return null
  const [i, f = ''] = s.trim().split('.')
  return BigInt(i) * 10n ** BigInt(SCALE) + BigInt((f + '0'.repeat(SCALE)).slice(0, SCALE))
}
/** 1e-8 units back to a decimal string, trailing zeros kept to 8 places. / 1e-8 单位换回十进制串。 */
export const fromUnits8 = (n) => { const s = n.toString().padStart(SCALE + 1, '0'); return `${s.slice(0, -SCALE)}.${s.slice(-SCALE)}` }
/** A claim's price in `currency` as 1e-8 units, or null when it names none. / 声称在某币种下的价格（1e-8 单位），没有则为 null。 */
export const priceIn = (c, currency) => { const p = c.prices?.find((x) => x.currency === currency); return p ? units8(typeof p.amount === 'string' ? p.amount : '') : null }

// ---------------------------------------------------------------------------------------------------------------
// Policy file / 策略文件
// ---------------------------------------------------------------------------------------------------------------
export const POLICY_PERIODS = Object.freeze(['call', 'day', 'month', 'total'])
const RULE_KEYS = ['name', 'service', 'model', 'period', 'currency', 'maxAmount', 'maxCalls', 'maxPromptTokens', 'maxCompletionTokens']
/**
 * Read a policy file's value: { tapeapiPolicy: 1, rules: [{ name?, service?, model?, period, currency?, maxAmount?,
 * maxCalls?, maxPromptTokens?, maxCompletionTokens? }] }. service: a container address or "*"; model: a model name as
 * the receipts carry it, or "*"; period: call, day or month (UTC) or total; maxAmount (with currency) a decimal string of
 * at most 8 places. Any other key, or a rule with no limit, is an error (a misspelt limit must not pass silently).
 * Returns the rules, or throws an Error whose message says what is wrong. / 读取策略文件；未知键或没有任何限额的规则都是错误。
 */
export function policyOf(value) {
  const bad = (msg) => { throw Object.assign(new Error(msg), { policy: true }) }
  if (!isObj(value)) bad('a policy is a JSON object { "tapeapiPolicy": 1, "rules": [...] }')
  for (const k of Object.keys(value)) if (!['tapeapiPolicy', 'rules', 'note'].includes(k)) bad(`unknown key ${JSON.stringify(k)} (keys: tapeapiPolicy, rules, note)`)
  if (value.tapeapiPolicy !== 1) bad('"tapeapiPolicy" must be 1')
  if (!Array.isArray(value.rules) || !value.rules.length) bad('"rules" must be a non-empty array')
  return value.rules.map((r, i) => {
    const at = `rules[${i}]`
    if (!isObj(r)) bad(`${at} must be an object`)
    for (const k of Object.keys(r)) if (!RULE_KEYS.includes(k)) bad(`${at}: unknown key ${JSON.stringify(k)} (keys: ${RULE_KEYS.join(', ')})`)
    const service = r.service ?? '*', model = r.model ?? '*'
    if (service !== '*' && !(typeof service === 'string' && ADDRESS_RE.test(service))) bad(`${at}.service must be a container address (0x and 40 hex digits) or "*"`)
    if (typeof model !== 'string' || !model) bad(`${at}.model must be a model name or "*"`)
    if (!POLICY_PERIODS.includes(r.period)) bad(`${at}.period must be one of ${POLICY_PERIODS.join(', ')}`)
    if (r.name !== undefined && typeof r.name !== 'string') bad(`${at}.name must be a string`)
    const out = { name: r.name ?? at, service, model, period: r.period }
    if (r.maxAmount !== undefined) {
      if (units8(typeof r.maxAmount === 'string' ? r.maxAmount : '') === null) bad(`${at}.maxAmount must be a decimal string with at most 8 places, such as "2.5"`)
      if (typeof r.currency !== 'string' || !r.currency) bad(`${at}.maxAmount needs "currency": the currency the receipts price in (USD, BEM, ...)`)
      out.maxAmount = r.maxAmount.trim(); out.currency = r.currency
    } else if (r.currency !== undefined) bad(`${at}.currency applies with maxAmount only`)
    for (const k of ['maxCalls', 'maxPromptTokens', 'maxCompletionTokens']) {
      if (r[k] === undefined) continue
      if (uint(r[k]) === null) bad(`${at}.${k} must be a whole number, 0 or more`)
      out[k] = r[k]
    }
    if (!['maxAmount', 'maxCalls', 'maxPromptTokens', 'maxCompletionTokens'].some((k) => out[k] !== undefined)) bad(`${at} sets no limit: maxAmount, maxCalls, maxPromptTokens or maxCompletionTokens`)
    return out
  })
}
/**
 * The window a time falls in for a rule's period: 'total', the UTC day (2026-10-22) or month (2026-10); null for a call
 * (each call is its own window) or a missing time. / 某时间在规则周期下所属的窗口：total、UTC 日或月；单次或无时间为 null。
 */
export const windowOf = (period, t) => {
  if (period === 'total') return 'total'
  if (t === null || t === undefined) return null
  const d = new Date(t * 1000).toISOString()
  return period === 'day' ? d.slice(0, 10) : period === 'month' ? d.slice(0, 7) : null
}
/** Does a rule cover a claim: its service (any case) and its model name exactly, or "*". / 规则是否覆盖某条声称。 */
export const ruleCovers = (rule, c) => (rule.service === '*' || (!!c.container && c.container.toLowerCase() === rule.service.toLowerCase())) && (rule.model === '*' || c.model === rule.model)
/**
 * Each rule set against the receipts it matches: per window (one call, a UTC day or month, or the whole file), the
 * receipts, amount and tokens they claim, and the limits they go over. Facts only: nothing was enforced when the calls
 * were made. Returns [{ rule, receipts, windows, over: [{ window, limit, value, max, sources }] }].
 * 每条规则与它匹配的回执对照：按窗口（单次、UTC 日或月、全部）列出回执、声称的金额与 token 以及超出的限额。只列事实：调用时没有执行任何限制。
 */
export function policyCheck(claims, rules) {
  return rules.map((rule) => {
    const mine = claims.filter((c) => ruleCovers(rule, c))
    const wins = new Map()
    const noTime = []
    for (const c of mine) {
      const w = rule.period === 'call' ? c.source : windowOf(rule.period, c.t)
      if (w === null) { noTime.push(c.source); continue }
      if (!wins.has(w)) wins.set(w, [])
      wins.get(w).push(c)
    }
    const over = []
    for (const [w, list] of wins) {
      const facts = []
      if (rule.maxAmount !== undefined) {
        const priced = list.filter((c) => priceIn(c, rule.currency) !== null)
        const sum = priced.reduce((a, c) => a + priceIn(c, rule.currency), 0n)
        if (sum > units8(rule.maxAmount)) facts.push({ limit: 'maxAmount', value: `${fromUnits8(sum)} ${rule.currency}`, max: `${rule.maxAmount} ${rule.currency}`, unpriced: list.length - priced.length })
      }
      if (rule.maxCalls !== undefined && list.length > rule.maxCalls) facts.push({ limit: 'maxCalls', value: list.length, max: rule.maxCalls })
      for (const [k, f] of [['maxPromptTokens', 'prompt'], ['maxCompletionTokens', 'completion']]) {
        if (rule[k] === undefined) continue
        const sum = list.reduce((a, c) => a + (c[f] ?? 0), 0)
        if (sum > rule[k]) facts.push({ limit: k, value: sum, max: rule[k] })
      }
      for (const f of facts) over.push({ window: w, ...f, sources: list.map((c) => c.source) })
    }
    return { rule, receipts: mine.length, windows: wins.size, noTime, over }
  })
}
