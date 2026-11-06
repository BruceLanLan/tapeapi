// The buyer-side checks of `tapeapi reconcile` (@experimental; pure, no file and no network): facts about what the
// receipts claim, set against what the buyer knows about each request, against a mandate's caps and against a local
// policy file. Each fact names the receipt line it comes from (and the bill line or request file when one is used). None
// of it is a verdict: a receipt proves only what its signer said (who signed which request and response bytes, and what
// usage and price were claimed). It does not prove which model ran, and nothing here can tell which model ran.
// tapeapi reconcile 的买家侧检查（实验性；纯函数，不读文件、不联网）：回执声称的内容，与买家自己知道的请求事实、授权书的上限、
// 本地策略文件逐项对照。每条事实都带回执行（用到账单行或请求文件时也带上）。都不是结论：回执只证明签名方说了什么（谁签了哪些
// 请求与回答字节、声称了多少用量与价格），不证明实际运行的是哪个模型，这里也无法判断实际运行的是哪个模型。
import { sha256Hex, modelEntryOf, formatOfMethod, MANIFEST_FIELD, completionLimitOf } from './ai.js'
import { normalizeMandate } from './agent-sig.js'
import { PAYMENT_TOKENS } from './chains.js'

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const ZERO = '0x0000000000000000000000000000000000000000'
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const uint = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null)

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
    format: formatOfMethod(e.method)?.name, model: typeof r.model === 'string' ? r.model : null, modelMatchedBy: typeof r.modelMatchedBy === 'string' ? r.modelMatchedBy : null,
    stream: typeof r.stream === 'boolean' ? r.stream : null, prompt: uint(u.prompt_tokens), completion: uint(u.completion_tokens), reasoning: uint(u.reasoning_tokens),
    prices: Array.isArray(r.prices) ? r.prices.filter(isObj) : null, t: Number.isSafeInteger(e.ts) ? e.ts : null,
    requestSha256: typeof e.params?.requestSha256 === 'string' ? e.params.requestSha256.toLowerCase() : null,
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Request facts / 请求事实
// ---------------------------------------------------------------------------------------------------------------
/**
 * The request members left out of a request's class: they choose the model, the delivery and the length of the answer,
 * not the text of the prompt. Two requests whose other members are equal (as JSON values, key order aside) are in the
 * same class, whatever model, stream flag or output limit each asked for.
 * 请求类别不计的成员：它们决定模型、送达方式与回答长度，不决定提示词文本。其余成员（作为 JSON 值，不计键序）相同的两个请求属同一类别。
 */
export const CLASS_IGNORES = Object.freeze(['model', 'stream', 'stream_options', 'max_tokens', 'max_completion_tokens', 'max_output_tokens', 'temperature', 'top_p', 'seed', 'user', 'metadata'])
/**
 * The members a request's output limit is read from, per format. The limit itself is `ai.completionLimitOf`, the rule a
 * billing layer sizes its hold with (2.5): Chat Completions the larger of `max_completion_tokens` and `max_tokens`, times
 * `n` (every choice is billed); Responses `max_output_tokens`; Messages `max_tokens`; Embeddings 0; undeclared, null.
 * 各格式读取输出上限的字段。上限本身用 `ai.completionLimitOf` 计算，与计费层估冻结额度的规则相同（2.5）：Chat 取
 * `max_completion_tokens` 与 `max_tokens` 中较大者再乘 `n`（每个选项都计费）；Responses 取 `max_output_tokens`；Messages 取
 * `max_tokens`；Embeddings 为 0；没声明为 null。
 */
export const LIMIT_FIELDS = Object.freeze({
  'openai-chat': ['max_completion_tokens', 'max_tokens'], 'openai-responses': ['max_output_tokens'], 'anthropic-messages': ['max_tokens'], 'openai-embeddings': [],
})
const stable = (v) => (Array.isArray(v) ? `[${v.map(stable).join(',')}]` : isObj(v) ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}` : JSON.stringify(v))

/**
 * What the bytes of one request say: { sha256, bytes, requestedModel, limit, limitField, limitN, classKey, json }. `limit`
 * is `ai.completionLimitOf(body, format)`; `limitField` names the member it comes from (for Chat, the larger one;
 * `embeddings` for Embeddings) and `limitN` is `n` when the limit was multiplied by it (n > 1), else null. A body that is
 * not a JSON object gives its hash and size only. The hash is over the bytes as they are: it equals a receipt's
 * requestSha256 only for the exact bytes that were sent (tapeapi-verify salts a request unless --no-salt).
 * 一个请求字节所表达的事实。不是 JSON 对象的请求体只给哈希与大小。哈希按原样字节计算：只有发出的确切字节才等于回执的 requestSha256。
 */
export function requestFacts(bytes, format) {
  const b = bytes instanceof Uint8Array ? bytes : new TextEncoder().encode(String(bytes))
  const out = { sha256: sha256Hex(b), bytes: b.length, requestedModel: null, limit: null, limitField: null, limitN: null, classKey: null, json: false }
  let body
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(b)) } catch { return out }
  if (!isObj(body)) return out
  out.json = true
  if (typeof body.model === 'string' && body.model) out.requestedModel = body.model
  const limit = completionLimitOf(body, format)
  if (limit !== null) {
    out.limit = limit
    if (format === 'openai-embeddings') out.limitField = 'embeddings'
    else {
      // The member the limit comes from: the larger one (on a tie, the first listed). / 上限来自的字段：较大者（相等取先列出的）。
      let field = null
      for (const f of LIMIT_FIELDS[format] ?? []) if (uint(body[f]) !== null && (field === null || body[f] > body[field])) field = f
      out.limitField = field
      if (format === 'openai-chat' && Number.isSafeInteger(body.n) && body.n > 1) out.limitN = body.n
    }
  }
  const rest = Object.fromEntries(Object.entries(body).filter(([k]) => !CLASS_IGNORES.includes(k)))
  out.classKey = sha256Hex(stable(rest)).slice(0, 16)
  return out
}

// ---------------------------------------------------------------------------------------------------------------
// The three patterns / 三类模式
// ---------------------------------------------------------------------------------------------------------------
/** The finding kinds, in the order they are listed. / 发现的种类，按列出顺序。 */
export const FINDING_KINDS = Object.freeze(['prompt-tokens-spread', 'prompt-tokens-above-request-bytes', 'completion-above-request-limit', 'model-names-vary', 'model-name-differs-from-bill'])

const view = (c) => ({
  receipt: c.source, id: c.id, model: c.model, stream: c.stream, prompt_tokens: c.prompt, completion_tokens: c.completion,
  ...(c.reasoning !== null ? { reasoning_tokens: c.reasoning } : {}),
  ...(c.req ? { request: c.req.file, requestBytes: c.req.bytes, requestedModel: c.req.requestedModel, ...(c.req.limit !== null ? { limit: c.req.limit, limitField: c.req.limitField, ...(c.req.limitN ? { limitN: c.req.limitN } : {}) } : {}) } : {}),
  ...(c.row ? { bill: c.row.source } : {}),
})

/**
 * The pattern checks over `claims` (claimOf, each with `req`: the request facts its requestSha256 matched, or null, and
 * `row`: the bill row it was joined to, or null). o: toleranceTokens (same model, default 0), promptSpread (across
 * models, default 16), manifests (receipts-cli snapshots: aliases), sameModel(c, name) (the join's rule).
 * Returns { findings, checked } where checked says, per kind, how many receipts had what the check needs.
 * 对 claims 做三类检查。返回 findings 与 checked（每类检查有多少张回执具备所需的输入）。
 */
export function patternChecks(claims, o = {}) {
  const { toleranceTokens = 0, promptSpread = 16, manifests = [], sameModel = null } = o
  const findings = []
  const checked = { requestClass: 0, requestBytes: 0, requestLimit: 0, requestedModel: 0, manifestEntry: 0, joinedBill: 0 }
  // The request a claim belongs to: its bytes' class, else the bill's request column, else its exact hash (only a
  // --no-salt log repeats one). / 请求类别：字节类别，否则账单的 request 列，否则确切哈希。
  const classOf = (c) => (c.req?.classKey ? { basis: 'request-bytes', key: c.req.classKey } : c.row?.request ? { basis: 'bill-request-column', key: c.row.request } : c.requestSha256 ? { basis: 'request-sha256', key: c.requestSha256 } : null)
  const groups = new Map()
  for (const c of claims) {
    const k = classOf(c)
    if (!k || c.prompt === null) continue
    const id = `${k.basis}\u0000${k.key}`
    if (!groups.has(id)) groups.set(id, { ...k, members: [] })
    groups.get(id).members.push(c)
  }
  for (const g of groups.values()) {
    if (g.members.length < 2) continue
    checked.requestClass += g.members.length
    const byModel = new Map()
    for (const c of g.members) { const m = c.model ?? '(none)'; if (!byModel.has(m)) byModel.set(m, []); byModel.get(m).push(c) }
    for (const [model, list] of byModel) {
      if (list.length < 2) continue
      const ps = list.map((c) => c.prompt), lo = Math.min(...ps), hi = Math.max(...ps)
      if (hi - lo > toleranceTokens) findings.push({ kind: 'prompt-tokens-spread', scope: 'same-model', basis: g.basis, requestClass: g.key, model, min: lo, max: hi, tolerance: toleranceTokens, items: list.map(view) })
    }
    if (byModel.size > 1) {
      const ps = g.members.map((c) => c.prompt), lo = Math.min(...ps), hi = Math.max(...ps)
      if (hi - lo > promptSpread) findings.push({ kind: 'prompt-tokens-spread', scope: 'across-models', basis: g.basis, requestClass: g.key, models: [...byModel.keys()], min: lo, max: hi, tolerance: promptSpread, items: g.members.map(view) })
    }
  }
  // More input tokens claimed than the request had bytes. / 声称的输入 token 多于请求字节数。
  for (const c of claims) {
    const size = c.req ? c.req.bytes : uint(c.row?.requestBytes)
    if (size === null || c.prompt === null) continue
    checked.requestBytes++
    if (c.prompt > size) findings.push({ kind: 'prompt-tokens-above-request-bytes', basis: c.req ? 'request-bytes' : 'bill-request-bytes-column', requestBytes: size, prompt_tokens: c.prompt, items: [view(c)] })
  }
  // More output tokens claimed than the request's limit. / 声称的输出 token 多于请求的上限。
  for (const c of claims) {
    const limit = c.req?.limit ?? uint(c.row?.maxTokens)
    if (limit === null || limit === undefined || c.completion === null) continue
    checked.requestLimit++
    if (c.completion > limit) {
      findings.push({ kind: 'completion-above-request-limit', basis: c.req?.limit !== null && c.req?.limit !== undefined ? 'request-bytes' : 'bill-max-tokens-column', limit, limitField: c.req?.limitField ?? 'max_tokens', ...(c.req?.limit !== null && c.req?.limit !== undefined && c.req.limitN ? { limitN: c.req.limitN } : {}), completion_tokens: c.completion,
        reasoning_tokens: c.reasoning, ratio: limit > 0 ? Math.round((c.completion / limit) * 100) / 100 : null, items: [view(c)] })
    }
  }
  // Model names: per container and requested model (the request's bytes, else the joined bill row's model), the names the
  // receipts carry, by stream flag; without either, per price-table entry of a snapshot. / 模型名：按容器与请求的模型分组。
  const named = new Map()
  const add = (basis, key, label, c) => { const id = `${basis}\u0000${key}`; if (!named.has(id)) named.set(id, { basis, label, members: [] }); named.get(id).members.push(c) }
  for (const c of claims) {
    if (c.model === null) continue
    const requested = c.req?.requestedModel ?? (c.row?.model || null)
    if (requested) { checked.requestedModel++; add(c.req?.requestedModel ? 'requested-model' : 'bill-model-column', `${(c.container ?? '').toLowerCase()}\u0000${requested}`, requested, c); continue }
    const entry = entryFor(manifests, c)
    if (entry) { checked.manifestEntry++; add('manifest-entry', `${(c.container ?? '').toLowerCase()}\u0000${entry.id}`, entry.id, c) }
  }
  for (const g of named.values()) {
    const names = [...new Set(g.members.map((c) => c.model))]
    if (names.length < 2) continue
    const split = names.map((n) => {
      const of = g.members.filter((c) => c.model === n)
      return { name: n, receipts: of.length, stream: of.filter((c) => c.stream === true).length, nonStream: of.filter((c) => c.stream === false).length }
    })
    findings.push({ kind: 'model-names-vary', basis: g.basis, ...(g.basis === 'manifest-entry' ? { entry: g.label } : { requested: g.label }), names: split, items: g.members.map(view) })
  }
  // A receipt and the bill row it was joined to name the model differently, though a snapshot makes them aliases (the
  // join counts them as the same model, so the mismatch list does not show it). / 回执与账单行的模型名不同但互为别名。
  for (const c of claims) {
    if (!c.row) continue
    checked.joinedBill++
    if (c.row.model && c.model !== null && c.model !== c.row.model && sameModel && sameModel(c, c.row.model)) {
      findings.push({ kind: 'model-name-differs-from-bill', receiptModel: c.model, billModel: c.row.model, items: [view(c)] })
    }
  }
  findings.sort((a, b) => FINDING_KINDS.indexOf(a.kind) - FINDING_KINDS.indexOf(b.kind))
  return { findings, checked }
}
function entryFor(manifests, c) {
  for (const s of manifests) {
    if (typeof c.container !== 'string' || s.manifest?.container?.toLowerCase() !== c.container.toLowerCase()) continue
    const e = modelEntryOf(s.manifest?.[MANIFEST_FIELD]?.models, c.model, c.format)
    if (e && typeof e.id === 'string') return e
  }
  return null
}

// ---------------------------------------------------------------------------------------------------------------
// Amounts / 金额
// ---------------------------------------------------------------------------------------------------------------
const SCALE = 8
/** A decimal string with at most 8 places as an integer of 1e-8 units, or null. / 至多 8 位小数的十进制串，换成 1e-8 单位的整数。 */
export function units8(s) {
  if (typeof s !== 'string' || !/^\d+(\.\d{1,8})?$/.test(s.trim())) return null
  const [i, f = ''] = s.trim().split('.')
  return BigInt(i) * 10n ** BigInt(SCALE) + BigInt((f + '0'.repeat(SCALE)).slice(0, SCALE))
}
/** 1e-8 units back to a decimal string, trailing zeros kept to 8 places. / 1e-8 单位换回十进制串。 */
export const fromUnits8 = (n) => { const s = n.toString().padStart(SCALE + 1, '0'); return `${s.slice(0, -SCALE)}.${s.slice(-SCALE)}` }
const priceIn = (c, currency) => { const p = c.prices?.find((x) => x.currency === currency); return p ? units8(typeof p.amount === 'string' ? p.amount : '') : null }

// ---------------------------------------------------------------------------------------------------------------
// Mandate / 授权书
// ---------------------------------------------------------------------------------------------------------------
/** A mandate file: a Mandate object, or { mandate, ... } (a signed one: its signature is not read). / 授权书文件。 */
export function mandateOf(value) {
  const m = isObj(value) && isObj(value.mandate) ? value.mandate : value
  return normalizeMandate(m, { wire: true })
}
/**
 * The spend the receipts claim, set against a mandate's scope (agent-sig normalizeMandate): per scope item, the receipts
 * of its provider (the container the receipt names) signed in [notBefore, expires), their sum in `currency`, and the cap
 * (base units of the item's token, `tokenDecimals` places). No signature is checked and nothing is enforced: a phase-0
 * mandate names no funds (every cap 0), and then the spend is listed and not compared. o: currency (default: the label of
 * a listed payment token, BEM or USDT), tokenDecimals (null: caps not compared), near (fraction of a cap, default 0.8).
 * 回执声称的花费与授权书 scope 对照：每项取其 provider（回执里的容器）在 [notBefore, expires) 内签的回执、按币种求和，与上限
 * （该项代币的基本单位，tokenDecimals 位小数）比较。不核签名、不执行任何限制；阶段 0 授权书不写金额，只列花费不比较。
 */
export function mandateSpend(claims, mandate, o = {}) {
  const m = normalizeMandate(mandate)
  const near = o.near ?? 0.8
  const decimals = o.tokenDecimals ?? null
  const phase0 = m.scope.every((s) => s.cap === '0' && s.token === ZERO) && m.feeCap === '0'
  const inPeriod = [], outside = []
  for (const c of claims) (c.t !== null && c.t >= m.notBefore && c.t < m.expires ? inPeriod : outside).push(c)
  const scope = m.scope.map((s) => {
    const label = PAYMENT_TOKENS[56]?.[s.token.toLowerCase()]?.label ?? null
    const currency = o.currency ?? (label ? label.split(' ')[0] : null)
    const mine = inPeriod.filter((c) => c.container && c.container.toLowerCase() === s.provider.toLowerCase())
    const priced = currency ? mine.filter((c) => priceIn(c, currency) !== null) : []
    const unpriced = currency ? mine.filter((c) => priceIn(c, currency) === null) : mine
    const sum = priced.reduce((a, c) => a + priceIn(c, currency), 0n)
    const item = { provider: s.provider, token: s.token, tokenLabel: label, cap: s.cap, currency, receipts: mine.length, priced: priced.length, unpriced: unpriced.map((c) => c.source),
      spent: currency ? fromUnits8(sum) : null, sources: mine.map((c) => c.source), status: null, why: null }
    if (s.cap === '0') { item.status = 'not-compared'; item.why = phase0 ? 'phase-0-no-funds' : 'cap-zero' }
    else if (!currency) { item.status = 'not-compared'; item.why = 'no-currency' }
    else if (decimals === null) { item.status = 'not-compared'; item.why = 'no-token-decimals' }
    else {
      // compare at max(decimals, 8) places, exactly / 在 max(decimals, 8) 位小数上精确比较
      const p = Math.max(decimals, SCALE)
      const cap = BigInt(s.cap) * 10n ** BigInt(p - decimals), spent = sum * 10n ** BigInt(p - SCALE)
      item.capInCurrency = decimals === 0 ? s.cap : `${(BigInt(s.cap) / 10n ** BigInt(decimals)).toString()}.${(BigInt(s.cap) % 10n ** BigInt(decimals)).toString().padStart(decimals, '0').replace(/(\d)0+$/, '$1')}`
      const nearAt = (cap * BigInt(Math.round(near * 1e6))) / 1000000n
      item.status = spent > cap ? 'above-cap' : spent === cap ? 'at-cap' : spent >= nearAt ? 'near-cap' : 'below-cap'
      item.share = cap > 0n ? Number((spent * 10000n) / cap) / 100 : null
    }
    return item
  })
  const scoped = new Set(m.scope.map((s) => s.provider.toLowerCase()))
  const others = new Map()
  for (const c of inPeriod) {
    const k = (c.container ?? '(none)').toLowerCase()
    if (scoped.has(k)) continue
    if (!others.has(k)) others.set(k, { container: c.container, receipts: 0, sources: [], spent: {} })
    const x = others.get(k)
    x.receipts++; x.sources.push(c.source)
    for (const p of c.prices ?? []) { const u = units8(typeof p.amount === 'string' ? p.amount : ''); if (u !== null && typeof p.currency === 'string') x.spent[p.currency] = (x.spent[p.currency] ?? 0n) + u }
  }
  return {
    principal: m.principal, agent: m.agent, agentKey: m.agentKey, notBefore: m.notBefore, expires: m.expires, phase0, near, tokenDecimals: decimals,
    scope, outOfScope: [...others.values()].map((x) => ({ ...x, spent: Object.fromEntries(Object.entries(x.spent).map(([k, v]) => [k, fromUnits8(v)])) })),
    outsidePeriod: { receipts: outside.length, sources: outside.map((c) => c.source) }, signatureChecked: false,
  }
}

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
const windowOf = (period, t) => {
  if (period === 'total') return 'total'
  if (t === null) return null
  const d = new Date(t * 1000).toISOString()
  return period === 'day' ? d.slice(0, 10) : period === 'month' ? d.slice(0, 7) : null
}
/**
 * Each rule set against the receipts it matches: per window (one call, a UTC day or month, or the whole file), the
 * receipts, amount and tokens they claim, and the limits they go over. Facts only: nothing was enforced when the calls
 * were made. Returns [{ rule, receipts, windows, over: [{ window, limit, value, max, sources }] }].
 * 每条规则与它匹配的回执对照：按窗口（单次、UTC 日或月、全部）列出回执、声称的金额与 token 以及超出的限额。只列事实：调用时没有执行任何限制。
 */
export function policyCheck(claims, rules) {
  return rules.map((rule) => {
    const mine = claims.filter((c) => (rule.service === '*' || (c.container && c.container.toLowerCase() === rule.service.toLowerCase())) && (rule.model === '*' || c.model === rule.model))
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
