// A client-side budget (@experimental, 3.0; pure, no file and no network): the caps of a local policy file (the same
// file `tapeapi reconcile --policy` reads, policy.js) checked BEFORE a call is sent, against what the receipts already
// recorded claim plus the worst case of the calls sent without a verified receipt. Used by createVerifyingFetch({ policy })
// and by the agent kit's limiter (createSpendLimiter().payer({ budget })).
//
// What it is: a convenience for the caller's own process. What it is not: an enforcement anyone else can rely on. The
// caller can turn it off, edit the store or run two processes on one store; a service is not bound by it; and it bounds
// the prices the receipts CLAIM, not what anyone pays (an off-chain bill, a channel's claimedOf). The worst case of a
// call is ai.maxAmountOf over the request's declared output limit (ai.completionLimitOf) and its size in bytes as the
// prompt bound: a hidden system prompt, images or tool definitions, a model that ignores max_tokens, or an answer priced
// on another reported model can make a receipt claim more; the next call then sees it and is refused.
//
// The store is one append-only JSON-lines text (budgetFileStore: a file, mode 600). Two kinds of line:
//   - a bare receipt envelope (as `tapeapi receipts` and `tapeapi reconcile --receipts` read it) for each answer whose
//     receipt verified;
//   - { "tapeapiSent": 1, ts, kind, container, format, models, requestSha256, worstCase, promptTokens, completionTokens },
//     written before the call leaves. A sent line whose requestSha256 a receipt line carries is counted as that receipt
//     claims; any other (no receipt, a receipt that did not verify, a crash in between, a voucher of the agent kit) is
//     counted at its worst case, also after a restart. The receipt readers skip sent lines.
//   - { "tapeapiReleased": 1, ts, id, why, status? } (3.0): the sent line `id` is no longer counted, because the call
//     ended in a definite failure that claims nothing (an HTTP 4xx or 5xx answered with no signed envelope), or a voucher
//     of the agent kit was released without being handed out. A timeout, a broken connection or an answer whose receipt
//     did not verify is not definite: the call keeps counting at its worst case.
// Two budgets on one file (two processes, or two createBudget / createVerifyingFetch({ policy }) in one process): each
// reads the lines the other appended before every admit (review BR-7), under the store's lock when it has one
// (budgetFileStore with writeFileSync and unlinkSync), so they decide one after the other. Without a lock, two calls
// admitted at the same moment by two budgets may each go over by up to their worst case. Share one with `budget:` across
// fetches and the agent kit's limiter. / 同一文件上的多个预算：每次 admit 之前在存储的锁之内读取对方追加的行，依次判定；
// 没有锁时，同一时刻放行的调用各自最多越过一次最坏情况；同一进程里请用 budget 选项共用同一个。
// 客户端预算（实验性，3.0；纯函数，不读文件、不联网）：在发出调用之前，用本地策略文件（与 tapeapi reconcile --policy 读的是同一个文件）
// 的上限，核对已记录的回执所声称的花费，加上已发出、却没有核验无误的回执的调用的最坏情况。它只是调用方自己进程里的便利，不是任何别人可以
// 依赖的执行：调用方可以关掉它、改存储、或在一个存储上跑两个进程；服务方不受它约束；它限制的是回执声称的价格，不是任何人实际付的钱。
import { TapeAPIError } from './errors.js'
import { claimOf, policyOf, units8, fromUnits8, priceIn, windowOf } from './policy.js'

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const HEX64 = /^[0-9a-f]{64}$/
export const BUDGET_SENT_VERSION = 1
/** The reasons a call is refused before it is sent: data.reason of BUDGET_EXCEEDED or INVALID_ARGUMENT. / 发出前拒绝的原因。 */
export const BUDGET_REFUSALS = Object.freeze(['budget-cap', 'budget-no-limit', 'budget-no-price', 'budget-no-currency', 'budget-unreadable-request', 'budget-store-unwritable'])

/**
 * The lines of a budget store (or of any receipt file): receipts (bare envelopes, or tapeapi-verify --log lines with a
 * receipt), sent lines and the lines that are neither. Each with its source `name:line`. / 读预算存储的各行。
 */
export function readBudgetLines(text, name = 'budget.jsonl') {
  const receipts = [], sent = [], skipped = [], released = []
  String(text ?? '').replace(/^\uFEFF/, '').split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return
    const source = `${name}:${i + 1}`
    let v
    try { v = JSON.parse(line) } catch { skipped.push(source); return }
    // A receipt-shaped line is a receipt, whatever other keys it carries: the signature does not cover the envelope's
    // top-level keys, so a service could add "tapeapiSent" to hide its receipt (FIXED BR-6). / 回执形状的行就是回执。
    if (isObj(v) && typeof v.sig === 'string' && isObj(v.result)) { receipts.push({ source, envelope: v }); return }
    const s = sentOf(v, source), x = s ? null : releasedOf(v, source)
    if (s) sent.push(s)
    else if (x) released.push(x)
    else if (isObj(v) && 'receipt' in v && 'ok' in v && isObj(v.receipt)) receipts.push({ source, envelope: v.receipt })
    else skipped.push(source)
  })
  return { receipts, sent, skipped, released }
}
/** A sent line, checked, or null. / 校验一条 sent 行，不是则为 null。 */
export function sentOf(v, source = null) {
  if (!isObj(v) || v.tapeapiSent !== BUDGET_SENT_VERSION || !Number.isSafeInteger(v.ts)) return null
  const n = (x) => (Number.isSafeInteger(x) && x >= 0 ? x : null)
  const worst = Array.isArray(v.worstCase) ? v.worstCase.filter((p) => isObj(p) && typeof p.currency === 'string' && units8(typeof p.amount === 'string' ? p.amount : '') !== null) : []
  return {
    source, id: typeof v.id === 'string' && v.id ? v.id : null, ts: v.ts, kind: v.kind === 'voucher' ? 'voucher' : 'ai', container: typeof v.container === 'string' ? v.container : null, format: typeof v.format === 'string' ? v.format : null,
    models: Array.isArray(v.models) ? v.models.filter((m) => typeof m === 'string') : [], requestSha256: typeof v.requestSha256 === 'string' && HEX64.test(v.requestSha256.toLowerCase()) ? v.requestSha256.toLowerCase() : null,
    worstCase: worst.map((p) => ({ currency: p.currency, amount: p.amount })), promptTokens: n(v.promptTokens), completionTokens: n(v.completionTokens),
  }
}
/** A released line, checked, or null. / 校验一条 released 行，不是则为 null。 */
export function releasedOf(v, source = null) {
  if (!isObj(v) || v.tapeapiReleased !== BUDGET_SENT_VERSION || typeof v.id !== 'string' || !v.id) return null
  return { source, id: v.id, ts: Number.isSafeInteger(v.ts) ? v.ts : null, why: typeof v.why === 'string' ? v.why : null, status: Number.isSafeInteger(v.status) ? v.status : null }
}
/** Why a sent line may be released. / 可以撤下 sent 行的原因。 */
export const BUDGET_RELEASES = Object.freeze(['http-error-no-receipt', 'sidecar-error', 'voucher-released'])
/**
 * The sent lines no receipt line answers (by requestSha256; a voucher line never has one) and no released line names
 * (by id): what the budget counts at its worst case. / 没有回执行对应、也没有被 released 行撤下的 sent 行：按最坏情况计。
 */
export function openSent(sent, receipts, released = []) {
  const answered = new Set()
  for (const r of receipts) { const h = r.envelope?.params?.requestSha256; if (typeof h === 'string') answered.add(h.toLowerCase()) }
  const gone = new Set(released.map((x) => x.id))
  return sent.filter((s) => !(s.requestSha256 && answered.has(s.requestSha256)) && !(s.id && gone.has(s.id)))
}

/**
 * What the budget counts (review BR-1, BR-4): one entry per sent line not released, and one per claim no sent line has.
 * A sent line answered by a verified receipt (one receipt per sent line, by requestSha256, in order) counts as that
 * receipt claims, windowed at the sent line's time (the budget's own clock, not the signer's), covered by the names the
 * request went by as well as the reported model; where the receipt claims nothing in a currency (no usage, a reported
 * model the price table lacks) it counts the sent line's worst case there. A receipt for a status outside 2xx claims
 * nothing and closes its line. Not what reconcile or the statement count: those list the claims as they are.
 * 预算计入的条目：有核验回执的 sent 行按回执声称计，但按 sent 行的时间分窗、按请求的名字与上报模型覆盖；回执在某币种没有声称时按最坏情况计。
 */
export function budgetEntries(sent, receipts, released = []) {
  const gone = new Set(released.map((x) => x.id))
  const byHash = new Map()
  for (const r of receipts) {
    const h = r.envelope?.params?.requestSha256
    if (typeof h !== 'string') continue
    const k = h.toLowerCase()
    if (!byHash.has(k)) byHash.set(k, [])
    byHash.get(k).push(r)
  }
  const used = new Set(), out = []
  const worst = (s) => ({ part: 'worstCase', t: s.ts, container: s.container, models: s.models, amount: (cur) => worstIn(s, cur), prompt: s.promptTokens ?? 0, completion: s.completionTokens ?? 0 })
  for (const s of sent) {
    if (s.id && gone.has(s.id)) continue
    const rec = s.requestSha256 ? (byHash.get(s.requestSha256) ?? []).find((r) => !used.has(r)) : undefined
    if (!rec) { out.push(worst(s)); continue }
    used.add(rec)
    const status = rec.envelope?.result?.status
    if (!(Number.isInteger(status) && status >= 200 && status < 300)) continue
    const c = claimOf(rec)
    if (!c) { out.push(worst(s)); continue }
    out.push({ part: 'claimed', t: s.ts, container: s.container ?? c.container, models: [...new Set([...s.models, ...(c.model ? [c.model] : [])])],
      amount: (cur) => priceIn(c, cur) ?? worstIn(s, cur), prompt: c.prompt ?? s.promptTokens ?? 0, completion: c.completion ?? s.completionTokens ?? 0 })
  }
  for (const r of receipts) {
    if (used.has(r)) continue
    const c = claimOf(r)
    if (c) out.push({ part: 'claimed', t: c.t, container: c.container, models: c.model ? [c.model] : [], amount: (cur) => priceIn(c, cur), prompt: c.prompt ?? 0, completion: c.completion ?? 0 })
  }
  return out
}
const held = (rule, entries, window) => {
  const z = () => ({ amount: 0n, calls: 0, prompt: 0, completion: 0 })
  const out = { claimed: z(), worstCase: z() }
  if (window === null) return out
  for (const e of entries) {
    if (!covers(rule, e) || windowOf(rule.period, e.t) !== window) continue
    const o = out[e.part]
    o.calls++
    if (rule.currency) o.amount += e.amount(rule.currency) ?? 0n
    o.prompt += e.prompt; o.completion += e.completion
  }
  return out
}

const covers = (rule, x) => (rule.service === '*' || (!!x.container && x.container.toLowerCase() === rule.service.toLowerCase())) &&
  (rule.model === '*' || (Array.isArray(x.models) ? x.models.includes(rule.model) : x.model === rule.model))
const worstIn = (s, currency) => { const p = s.worstCase?.find((x) => x.currency === currency); return p ? units8(p.amount) : null }
/**
 * What a rule's window holds now: the claims of the receipts (claimOf) and the open sent lines (their worst case) in
 * `window` (null: the whole store is not a window: a per-call rule counts nothing before the call). Amount in 1e-8
 * units of the rule's currency, calls, prompt and completion tokens; each split into claimed and worst-case parts.
 * 规则窗口里现有的量：回执的声称与未结的 sent 行（按最坏情况）；金额以规则币种的 1e-8 为单位。
 */
export function windowSpend(rule, claims, open, window) {
  const z = { amount: 0n, calls: 0, prompt: 0, completion: 0 }
  const out = { claimed: { ...z }, worstCase: { ...z } }
  if (window === null) return out
  for (const c of claims) {
    if (!covers(rule, c) || windowOf(rule.period, c.t) !== window) continue
    out.claimed.calls++
    if (rule.currency) out.claimed.amount += priceIn(c, rule.currency) ?? 0n
    out.claimed.prompt += c.prompt ?? 0; out.claimed.completion += c.completion ?? 0
  }
  for (const s of open) {
    if (!covers(rule, s) || windowOf(rule.period, s.ts) !== window) continue
    out.worstCase.calls++
    if (rule.currency) out.worstCase.amount += worstIn(s, rule.currency) ?? 0n
    out.worstCase.prompt += s.promptTokens ?? 0; out.worstCase.completion += s.completionTokens ?? 0
  }
  return out
}

/**
 * A memory store (the default): a restart forgets every call. / 内存存储（默认）：重启即忘记全部调用。
 */
export function memoryBudgetStore(initial = '') {
  let text = String(initial)
  return { read: () => text, append: (s) => { text += s } }
}
/**
 * A budget store in a file on this machine: one append-only JSON-lines file, created with mode 600 (and set to 600 when
 * it is read, if `fs.chmodSync` is given). `fs`: { readFileSync, appendFileSync, chmodSync?, writeFileSync?, unlinkSync? }
 * from node:fs (this module imports nothing Node-only). A missing file is an empty store.
 * With writeFileSync and unlinkSync, the store also has lock() (review BR-7): a lock file `<path>.lock`, created with flag
 * wx (O_EXCL) and holding { pid, ms }, around each admit's read, decision and append, so budgets in two processes on one
 * file decide one after the other. A lock older than `o.staleMs` (default 30 s; an admit holds it for milliseconds) is
 * taken to be left by a process that died and is removed; waiting longer than `o.waitMs` (default 10 s) refuses the call
 * (budget-store-unwritable). Residual: two waiters that both find the same stale lock may both remove it.
 * 本机文件里的预算存储：一个只追加的 JSON 行文件，权限 600。给了 writeFileSync 与 unlinkSync 时另有 lock()：在 admit 的读、判定与追加
 * 外面加一个 wx 创建的锁文件，两个进程的预算依次判定；超过 staleMs 的锁视为崩溃遗留而移除；等待超过 waitMs 即拒绝该调用。
 */
export function budgetFileStore(path, fs, { staleMs = 30_000, waitMs = 10_000 } = {}) {
  if (typeof path !== 'string' || !path) throw new TapeAPIError('INVALID_ARGUMENT', 'budgetFileStore needs a file path')
  if (typeof fs?.readFileSync !== 'function' || typeof fs?.appendFileSync !== 'function') throw new TapeAPIError('INVALID_ARGUMENT', 'budgetFileStore needs fs: { readFileSync, appendFileSync, chmodSync? } from node:fs')
  return {
    path,
    read() {
      let text
      try { text = fs.readFileSync(path, 'utf8') } catch (e) { if (e?.code === 'ENOENT') return ''; throw e }
      if (typeof fs.chmodSync === 'function') { try { fs.chmodSync(path, 0o600) } catch { /* not ours to fix: the read stands */ } }
      return text
    },
    append(s) { fs.appendFileSync(path, s, { mode: 0o600 }) },
    ...(typeof fs.writeFileSync === 'function' && typeof fs.unlinkSync === 'function' ? { lock: () => fileLock(`${path}.lock`, fs, { staleMs, waitMs }) } : {}),
  }
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
async function fileLock(file, fs, { staleMs, waitMs }) {
  const start = Date.now()
  const me = JSON.stringify({ pid: typeof process !== 'undefined' ? process.pid : null, ms: start, n: Math.random() })
  for (let i = 0; ; i++) {
    try { fs.writeFileSync(file, me, { flag: 'wx', mode: 0o600 }); break } catch (e) {
      if (e?.code !== 'EEXIST') throw e
      let held = null
      try { held = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { held = null }
      // unreadable (being written) counts as fresh; too old: a process died holding it / 读不出按新锁算；过旧：持有者已崩溃
      if (held && Number.isFinite(held.ms) && Date.now() - held.ms > staleMs) { try { fs.unlinkSync(file) } catch { /* someone else did */ } continue }
      if (Date.now() - start > waitMs) throw new Error(`the store is locked by another budget (${file}); remove it if no process holds it`)
      await pause(Math.min(2 + i, 25))
    }
  }
  return () => {
    // remove only our own lock / 只移除自己的锁
    try { if (fs.readFileSync(file, 'utf8') === me) fs.unlinkSync(file) } catch { /* gone already */ }
  }
}

/**
 * @experimental (3.0) A client-side budget over a local policy file. o.policy: the policy file's value ({ tapeapiPolicy:
 * 1, rules: [...] }, as `tapeapi reconcile --policy` reads it; INVALID_ARGUMENT when it is not one). o.store: { read(),
 * append(text) } (may be async; default memoryBudgetStore(); budgetFileStore for a file). o.clock: Unix seconds.
 * o.onWarning: a receipt that could not be written (it still counts in this process); default console.warn.
 *   admit(call)    before a call is sent. call: { kind: 'ai' | 'voucher', container, format?, models (the names the
 *                  requested model goes by: request, price-table id and aliases; [] for a voucher; null when the
 *                  request could not be read), worstCase ({ [currency]: '0.00100000' } over the request's bounds; null
 *                  when the price table has no entry for the model), promptTokens, completionTokens (null: the request
 *                  declares no output limit), requestSha256 }. Every rule that covers the call (service, and model
 *                  among `models` or "*") is checked in the window of now (call, UTC day or month, total): what the
 *                  receipts in that window claim + the worst case of its open sent lines + this call's worst case,
 *                  against the rule's limit. Over: BUDGET_EXCEEDED, data { reason: 'budget-cap', rule, period, window,
 *                  limit, currency?, cap, spent, worstCase } (amounts as decimal strings). A covering rule that cannot
 *                  be bounded fails closed with INVALID_ARGUMENT, data.reason budget-no-limit (no output limit declared),
 *                  budget-no-price (no price-table entry), budget-no-currency (the entry has no price in the rule's
 *                  currency) or budget-unreadable-request (the body is not a JSON object, so the model is unknown).
 *                  Allowed: the sent line is written (budget-store-unwritable when it cannot be: nothing is sent).
 *   receipt(env)   a verified receipt envelope, written to the store and counted at what it claims.
 *   release(admitted, { why, status })  the sent line no longer counts (a definite failure, a released voucher).
 *   state()        { rules, receipts, sent, open, windows: per rule its window now and what it holds }.
 * 客户端预算。admit 在发出之前核对每条覆盖该调用的规则；超出抛 BUDGET_EXCEEDED；无法给出上界的情况一律拒绝（INVALID_ARGUMENT）。
 */
export function createBudget({ policy, store, clock = () => Math.floor(Date.now() / 1000), onWarning } = {}) {
  let rules
  try { rules = policyOf(policy) } catch (e) { throw new TapeAPIError('INVALID_ARGUMENT', `policy: ${e.message}`) }
  const st = store ?? memoryBudgetStore()
  if (typeof st?.read !== 'function' || typeof st?.append !== 'function') throw new TapeAPIError('INVALID_ARGUMENT', 'store must be { read(), append(text) }')
  if (typeof clock !== 'function') throw new TapeAPIError('INVALID_ARGUMENT', 'clock must be a function returning Unix seconds')
  const warn = typeof onWarning === 'function' ? onWarning : (m) => console.warn('[tapeapi/budget]', m)
  const receipts = [], sent = [], claims = [], released = []
  // one receipt counts once, however often it was written (as tapeapi reconcile counts: by signature)
  // 一张回执只计一次，无论写了几次（与 tapeapi reconcile 相同：按签名）
  const sigs = new Set()
  const take = (rec) => {
    const key = typeof rec.envelope.sig === 'string' ? rec.envelope.sig : JSON.stringify(rec.envelope)
    if (sigs.has(key)) return null
    sigs.add(key); receipts.push(rec)
    const c = claimOf(rec)
    if (c) claims.push(c)
    return c
  }
  let lines = 0, loading = null, seq = 0, open = false
  const name = typeof st.path === 'string' ? st.path : 'budget'
  const sentIds = new Set(), releasedIds = new Set()
  const lineNo = (source) => Number(String(source).slice(String(source).lastIndexOf(':') + 1))
  // Merge what the store holds (append-only): on the first read every line; later, the lines past those already seen,
  // less the ones this budget wrote itself (by id, by signature); `lines` counts the store's lines as last read, so a
  // line another budget wrote between two of ours is still past it. / 合并存储内容：首次全部；之后只取新行，去掉自己写的。
  const merge = (text, first) => {
    const r = readBudgetLines(text, name)
    const fresh = (x) => first || lineNo(x.source) > lines
    for (const x of r.receipts) if (fresh(x)) take(x)
    for (const x of r.sent) if (fresh(x) && !(x.id && sentIds.has(x.id))) { sent.push(x); if (x.id) sentIds.add(x.id) }
    for (const x of r.released) if (fresh(x) && !releasedIds.has(x.id)) { released.push(x); releasedIds.add(x.id) }
    const t = String(text ?? '')
    // complete lines only: a last line without its newline is read again next time
    lines = (t.match(/\n/g) ?? []).length
    // a last line cut short (a crash mid-write): the next line starts on a line of its own (FIXED BR-5)
    // 最后一行被截断（写到一半崩溃）：下一行另起一行
    open = t.length > 0 && !t.endsWith('\n')
  }
  const write = async (s) => { const pre = open ? '\n' : ''; await st.append(pre + s); open = false }
  function ready() {
    loading ??= Promise.resolve().then(() => st.read()).then((text) => merge(text, true),
      (e) => { loading = null; throw new TapeAPIError('INVALID_ARGUMENT', `the budget store cannot be read: ${e?.message ?? e}`, { data: { reason: 'budget-store-unwritable' } }) })
    return loading
  }
  // Before each admit: the lines another budget on the same store appended since (FIXED BR-7). / 每次 admit 之前读对方新追加的行。
  async function refresh() {
    let text
    try { text = await st.read() } catch (e) { throw new TapeAPIError('INVALID_ARGUMENT', `the budget store cannot be read: ${e?.message ?? e}`, { data: { reason: 'budget-store-unwritable' } }) }
    merge(text, false)
  }
  function decide(call, now) {
    const entries = budgetEntries(sent, receipts, released)
    const cannot = (reason, rule, msg) => { throw new TapeAPIError('INVALID_ARGUMENT', `budget: ${msg}; the rule ${JSON.stringify(rule.name)} cannot be checked, so the call is not sent (rule ${rule.name})`, { data: { reason, rule: rule.name } }) }
    for (const rule of rules) {
      const serviceOk = rule.service === '*' || (!!call.container && call.container.toLowerCase() === rule.service.toLowerCase())
      if (!serviceOk) continue
      if (call.models === null) cannot('budget-unreadable-request', rule, 'the request body is not a JSON object, so its model is unknown')
      // A model the price table does not know cannot be told apart from the rule's model (an upstream may take another
      // spelling of it): every model rule of the service covers it, and fails closed (FIXED BR-2).
      // 价目表不认识的模型无法与规则的模型区分：该服务的每条模型规则都覆盖它，并失败即拒绝。
      const unknown = call.kind === 'ai' && call.worstCase === null
      if (!(rule.model === '*' || call.models.includes(rule.model) || unknown)) continue
      const window = rule.period === 'call' ? null : windowOf(rule.period, now)
      const h = held(rule, entries, window)
      const over = (limit, cap, spent, worst, currency) => {
        const fmt = (x) => (currency ? `${typeof x === 'bigint' ? fromUnits8(x) : x} ${currency}` : String(x))
        throw new TapeAPIError('BUDGET_EXCEEDED', `budget: rule ${JSON.stringify(rule.name)} (${rule.period}${window && window !== 'total' ? ` ${window}` : ''}): ${limit} ${fmt(cap)}; already ${fmt(spent)}, this call up to ${fmt(worst)}: not sent (a client-side cap of your own policy file; it bounds the prices the receipts claim)`,
          { data: { reason: 'budget-cap', rule: rule.name, period: rule.period, window, limit, ...(currency ? { currency } : {}), cap: currency ? fromUnits8(cap) : cap, spent: currency ? fromUnits8(spent) : spent, worstCase: currency ? fromUnits8(worst) : worst } })
      }
      if (rule.maxAmount !== undefined) {
        if (call.kind === 'ai' && call.worstCase === null) {
          cannot('budget-no-price', rule, rule.model !== '*' && !call.models.includes(rule.model)
            ? `model ${JSON.stringify(call.models[0] ?? null)} is not in the service's price table, so it cannot be told apart from the rule's model ${JSON.stringify(rule.model)} (an upstream may take another spelling of it); use a model name the price table lists`
            : `the service's price table has no entry for model ${JSON.stringify(call.models[0] ?? null)}`)
        }
        if (call.kind === 'ai' && call.completionTokens === null) cannot('budget-no-limit', rule, 'the request declares no output limit (max_tokens, max_completion_tokens or max_output_tokens; 0 counts as none), so its worst case is unbounded; set one')
        if (call.kind === 'ai' && call.promptTokens === null) cannot('budget-no-limit', rule, 'the request\'s prompt is not bounded by the bytes sent (previous_response_id or conversation: the service adds the earlier turns)')
        const w = units8(typeof call.worstCase?.[rule.currency] === 'string' ? call.worstCase[rule.currency] : '')
        if (w === null) cannot('budget-no-currency', rule, `the call has no price in ${rule.currency}`)
        const cap = units8(rule.maxAmount), spent = h.claimed.amount + h.worstCase.amount
        if (spent + w > cap) over('maxAmount', cap, spent, w, rule.currency)
      }
      if (rule.maxCalls !== undefined) {
        const spent = h.claimed.calls + h.worstCase.calls
        if (spent + 1 > rule.maxCalls) over('maxCalls', rule.maxCalls, spent, 1)
      }
      if (rule.maxPromptTokens !== undefined) {
        if (call.kind === 'ai' && call.promptTokens === null) cannot('budget-no-limit', rule, 'the request\'s prompt is not bounded by the bytes sent (previous_response_id or conversation)')
        const spent = h.claimed.prompt + h.worstCase.prompt
        if (spent + (call.promptTokens ?? 0) > rule.maxPromptTokens) over('maxPromptTokens', rule.maxPromptTokens, spent, call.promptTokens ?? 0)
      }
      if (rule.maxCompletionTokens !== undefined) {
        if (call.kind === 'ai' && call.completionTokens === null) cannot('budget-no-limit', rule, 'the request declares no output limit, so its completion tokens are unbounded; set one')
        const spent = h.claimed.completion + h.worstCase.completion
        if (spent + (call.completionTokens ?? 0) > rule.maxCompletionTokens) over('maxCompletionTokens', rule.maxCompletionTokens, spent, call.completionTokens ?? 0)
      }
    }
  }
  return {
    rules,
    ready,
    async admit(call) {
      await ready()
      if (!isObj(call)) throw new TapeAPIError('INVALID_ARGUMENT', 'budget.admit needs a call')
      // Across processes: read the new lines, decide and append under the store's lock, when it has one (BR-7).
      // 跨进程：在存储的锁之内读新行、判定并追加（存储有锁时）。
      let unlock = null
      if (typeof st.lock === 'function') {
        try { unlock = await st.lock() } catch (e) { throw new TapeAPIError('INVALID_ARGUMENT', `budget: ${e?.message ?? e}: the call is not sent`, { data: { reason: 'budget-store-unwritable' } }) }
      }
      try {
      await refresh()
      const now = clock()
      // decided and counted with no await in between: concurrent calls in this process see each other
      // 判定与计入之间没有 await：本进程内的并发调用彼此可见
      decide(call, now)
      // an id that a released line can name (unique in this store; not a secret) / released 行可以引用的 id（本存储内唯一，不是秘密）
      const id = `${now.toString(36)}-${(++seq).toString(36)}-${Math.random().toString(36).slice(2, 10)}`
      const line = { tapeapiSent: BUDGET_SENT_VERSION, id, ts: now, kind: call.kind === 'voucher' ? 'voucher' : 'ai', container: call.container ?? null, format: call.format ?? null,
        models: Array.isArray(call.models) ? call.models : [], requestSha256: call.requestSha256 ?? null,
        worstCase: isObj(call.worstCase) ? Object.entries(call.worstCase).map(([currency, amount]) => ({ currency, amount })) : [],
        promptTokens: call.promptTokens ?? null, completionTokens: call.completionTokens ?? null }
      const s = sentOf(line, `${name}:${open ? lines + 2 : lines + 1}`)
      sent.push(s); sentIds.add(id)
      try { await write(JSON.stringify(line) + '\n') } catch (e) {
        sent.splice(sent.indexOf(s), 1)
        throw new TapeAPIError('INVALID_ARGUMENT', `budget: the store cannot be written (${e?.message ?? e}): the call is not sent`, { data: { reason: 'budget-store-unwritable' } })
      }
      return s
      } finally { if (unlock) unlock() }
    },
    /**
     * The sent line of `admitted` (what admit returned) no longer counts: the call ended in a definite failure that
     * claims nothing (why: http-error-no-receipt, sidecar-error), or a voucher was released (voucher-released). A
     * line that cannot be written is warned about; the call is then released in this process only.
     * admit 返回的那条 sent 行不再计入：调用以确定的、不声称任何数的失败结束，或凭证被释放。
     */
    async release(admitted, { why, status } = {}) {
      await ready()
      if (!admitted?.id || released.some((x) => x.id === admitted.id)) return false
      if (!BUDGET_RELEASES.includes(why)) throw new TapeAPIError('INVALID_ARGUMENT', `budget.release: why must be one of ${BUDGET_RELEASES.join(', ')}`)
      const line = { tapeapiReleased: BUDGET_SENT_VERSION, ts: clock(), id: admitted.id, why, ...(Number.isSafeInteger(status) ? { status } : {}) }
      released.push(releasedOf(line, `${name}:${lines + 1}`)); releasedIds.add(admitted.id)
      try { await write(JSON.stringify(line) + '\n') } catch (e) { warn(`a released line could not be written to the budget store (${e?.message ?? e}); the call is released in this process only`) }
      return true
    },
    async receipt(envelope) {
      await ready()
      if (!isObj(envelope)) return null
      const rec = { source: `${name}:${lines + 1}`, envelope }
      const c = take(rec)
      try { await write(JSON.stringify(envelope) + '\n') } catch (e) { warn(`a receipt could not be written to the budget store (${e?.message ?? e}); it counts in this process only`) }
      return c
    },
    state() {
      const now = clock(), open = openSent(sent, receipts, released), entries = budgetEntries(sent, receipts, released)
      return {
        rules, receipts: receipts.length, sent: sent.length, released: released.length, open: open.length,
        windows: rules.map((rule) => {
          const window = rule.period === 'call' ? null : windowOf(rule.period, now)
          const h = held(rule, entries, window)
          const cur = (x) => ({ ...x, amount: rule.currency ? fromUnits8(x.amount) : null })
          return { rule: rule.name, period: rule.period, window, claimed: cur(h.claimed), worstCase: cur(h.worstCase) }
        }),
      }
    },
  }
}
