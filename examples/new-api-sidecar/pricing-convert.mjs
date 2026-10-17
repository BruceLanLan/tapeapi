#!/usr/bin/env node
// tapeapi-newapi-prices (EXPERIMENTAL; not part of @tapeapi/sdk or @tapeapi/server, may change or go away in any
// release): turns new-api's public price list (GET /api/pricing, saved to a file) into the sidecar's price table, the
// `ai.models[].prices` of TAPI-20 §3.9, in USD for display only, and checks later whether the published table drifted.
// It reads files only: fetch /api/pricing (and /api/status) yourself, from your own new-api.
// tapeapi-newapi-prices（实验性；不属于 @tapeapi/sdk 或 @tapeapi/server，任何版本都可能改动或移除）：把 new-api 的公开价目
// （GET /api/pricing，存成文件）转换成旁路的价目表，即 TAPI-20 §3.9 的 ai.models[].prices（USD，仅作展示），之后检查已发布的价目表
// 是否漂移。它只读文件：/api/pricing（和 /api/status）由你自己从自己的 new-api 取下来。
//
//   node pricing-convert.mjs pricing.json --usd-exchange-rate 7 [--status status.json | --quota-per-unit 500000]
//        [--fetched-as anonymous|user] [--out models.json] [--exclude <model name>]... [--video <model name>]...
//        [--accept-ratio-37.5 <model name>]...
//   node pricing-convert.mjs --check pricing.json --models models.json [--meta models.newapi-source.json] [--status status.json]
//        [--fetched-as anonymous|user]
//
// The rules (each one is a test in pricing-convert.test.mjs) / 规则（每条都有测试）:
// - USD per 1M tokens = model_ratio x 1000000 / quota_per_unit (ratio 1 costs one quota per token, and quota_per_unit
//   quota = $1); output = input x completion_ratio; cacheRead = input x cache_ratio and cacheWrite = input x
//   create_cache_ratio when given; all of it x the group ratio when every group the model is enabled for (and the answer
//   shows) has the same one. quota_per_unit is an option of the site (GET /api/status, data.quota_per_unit), read from
//   --status or given with --quota-per-unit; there is no default (new-api's own default is 500000, which makes the
//   factor x 2; read from its source, not measured). This is new-api's own "USD" (quota dollars), NOT what a user pays in
//   real dollars: users buy quota at the site's top-up price. The operator confirms the table before publishing it.
//   每百万 token 美元价 = model_ratio x 1000000 / quota_per_unit（倍率 1 每 token 扣 1 额度，quota_per_unit 额度 = 1 美元）；输出 =
//   输入 x completion_ratio；有 cache_ratio 时缓存读 = 输入 x cache_ratio，有 create_cache_ratio 时缓存写 = 输入 x create_cache_ratio；
//   模型启用（且回答里看得到）的各分组倍率相同时再乘该倍率。quota_per_unit 是站点的可改选项（GET /api/status 的 data.quota_per_unit），
//   从 --status 读或用 --quota-per-unit 给出，没有默认值（new-api 自己的默认值是 500000，即 x 2；读自源码、未实测）。这是 new-api
//   自己的“美元”（额度美元），**不是**用户实际支付的真实美元（用户按站点充值价买额度）。价目表发布前由服务方确认。
// - A model with a billing_mode is priced by its billing_expr, and its model_ratio is a placeholder: the expression is read
//   (never evaluated) to say why, and the model is refused: tiered prices (tiered_expr) cannot be one price per 1M tokens.
//   有 billing_mode 的模型按 billing_expr 计价，model_ratio 只是占位：读表达式（从不求值）来说明原因，并拒绝转换：分档价格不能写成一个
//   每百万 token 单价。
// - model_ratio = 37.5 without a billing_mode is new-api's placeholder for a model with no price set, and also a real
//   price (gpt-4.5-preview's and its dated snapshot's in new-api's default ratio table): /api/pricing cannot tell them apart. A model whose
//   default price is 37.5 is converted and flagged; any other is refused as ambiguous unless --accept-ratio-37.5 names it.
//   In self-use mode (GET /api/status self_use_mode_enabled) new-api serves such a model and bills it at 37.5: the
//   refusal says so.
//   model_ratio = 37.5 且没有 billing_mode 既是 new-api 给未设价模型的占位，也可能是真价（new-api 默认倍率表里 gpt-4.5-preview 及其带日期的快照就是
//   37.5），/api/pricing 无法区分。默认价就是 37.5 的模型照常转换并标出；其它的按“无法区分”拒绝，除非 --accept-ratio-37.5 点名放行。
//   自用模式下 new-api 会提供这类模型并按 37.5 计费：拒绝说明里写明。
// - Video models are refused (TAPI-20 §3.9 prices text formats only). new-api's list has no field that says "video", so
//   this is by name: a resolution suffix (-480p, -720p, -1080p, ...), "video", t2v or i2v, plus every --video name;
//   --exclude refuses any other model. The operator confirms the list.
//   视频模型拒绝转换（§3.9 只给文本格式定价）。new-api 的价目没有表示“视频”的字段，所以按名字判断：分辨率后缀、video、t2v、i2v，
//   加上每个 --video 名字；--exclude 可拒绝任何其它模型。名单由服务方确认。
// - Per-request prices (quota_type 1), a model not served on the OpenAI endpoint type, a group ratio that differs between
//   the model's groups, and a name TAPI-20 does not accept are refused, each with its reason.
//   按次计价（quota_type 1）、不在 OpenAI 端点类型上提供、各分组倍率不同、TAPI-20 不接受的名字：拒绝并说明原因。
// - What /api/pricing holds depends on who fetched it: logged in, group_ratio is that user's group's and only the groups
//   that user can use are shown (usable_group). The groups counted are enable_groups that usable_group lists; a group the
//   answer does not show is flagged, not "missing". --fetched-as anonymous|user is recorded and shown (fetch anonymously,
//   or as an ordinary user, never as an administrator).
//   /api/pricing 的内容取决于谁取的：登录后 group_ratio 是该用户分组的倍率，且只列该用户可用的分组（usable_group）。只计
//   usable_group 里列出的 enable_groups；回答里看不到的分组标出待确认，不算“缺失”。--fetched-as 记录并显示取价身份（匿名取，或用普通
//   用户取，绝不用管理员）。
// - completion_ratio < 1 (the output price below the input price) is flagged for the operator to confirm; so is a model
//   with no vendor_id. A model whose vendor is named OpenAI, Anthropic or Google (the name in the answer's `vendors`
//   list, any case), or whose own name says claude, gpt or gemini, is flagged as a scope signal: a signal for the
//   operator, not a filter, so --check prints it as a NOTE and does not exit 1 for it. Vendor ids are never used: new-api's database ids are arbitrary, and its
//   default vendors carry negative display ids (model/pricing_default.go, QuantumNous/new-api main at ef60ef2,
//   2026-10-13: Anthropic -1002, Google -1006, OpenAI -1012), so only names say which vendor it is.
//   completion_ratio < 1（输出价低于输入价）标出待服务方确认；没有 vendor_id 也标出。厂商名（回答里 vendors 列表中的名字，不分大小写）为
//   OpenAI、Anthropic、Google，或模型名含 claude、gpt、gemini 的模型，标为范围信号：只是给运营者的信号，不是过滤器，所以 --check 把它打成
//   NOTE，不因它退出 1。
//   从不按厂商 id 判断：new-api 数据库里的 id 是任意的，其默认厂商用的是负数展示 id（上述源码：Anthropic -1002、Google -1006、OpenAI -1012），
//   只有名字能说明是哪家。
// - Model ids are the API's model_name exactly, code unit for code unit (no trimming, no case change), in the API's order.
//   模型 id 逐码元照抄接口的 model_name（不去空白、不改大小写），顺序同接口。
// - The exchange rate is read from usd_exchange_rate (GET /api/status, data.usd_exchange_rate) and must be confirmed
//   explicitly with --usd-exchange-rate; there is no default. It does not change the USD figures (they are quota dollars);
//   it is recorded, and the report shows the CNY figure new-api's pricing page derives with it so the operator can
//   compare. 汇率读 usd_exchange_rate，且必须用 --usd-exchange-rate 显式确认，没有默认值。它不改变美元数（那是额度美元），只是记录下来，
//   报告按它给出 new-api 价目页显示的人民币数，供服务方对照。
// - --check compares a stable hash of the price list's content (each model's price fields and the group ratios, sorted;
//   not pricing_version) and the converted prices with the published table; any drift exits 1. A scope signal is a NOTE
//   (it is there every day for a relay that resells such models, so it cannot be drift). The top-level pricing_version is new-api's build marker, a constant of its source, not a price version: a change of it
//   alone is a NOTE, never drift.
//   --check 比较价目内容的稳定哈希（每个模型的价格字段与分组倍率，排序后；不含 pricing_version）以及转换出的价格是否与已发布的价目表
//   一致；有漂移即退出码 1。范围信号只打 NOTE（转售这类模型的中转站每天都有它，不能算漂移）。顶层 pricing_version 是 new-api 源码里的构建常量，不是价目版本：只有它变了只是 NOTE，不算漂移。
//
// Exit codes / 退出码: 0 done, nothing drifted (NOTE lines, scope signals among them, do not count); 1 drift (--check:
// the price content hash, a converted price, the models converted, the exchange rate or quota_per_unit changed);
// 2 the input or the options are wrong. / 0 完成、无漂移（NOTE 行，包括范围信号，不计）；1 有漂移；2 输入或参数有误。
import { readFileSync, writeFileSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const TOOL = 'tapeapi-newapi-prices'
export const NEWAPI_DEFAULT_QUOTA_PER_UNIT = '500000'   // new-api's default (common/constants.go), for messages only / 只用于提示
export const UNPRICED_RATIO = '37.5'      // new-api's placeholder ratio for a model with no price / 未设价模型的占位倍率
// Models whose price in new-api's default ratio table is exactly 37.5 (defaultModelRatio in
// setting/ratio_setting/model_ratio.go, QuantumNous/new-api main at 63cecab, 2026-10-13: every one of its 235 entries
// evaluated, and these two, the alias and its dated snapshot, are 37.5): their 37.5 is a price.
// new-api 默认倍率表里价格恰为 37.5 的模型（上述源码 235 项逐项求值，只有这两个：别名与其带日期的快照）：它们的 37.5 是真价。
export const DEFAULT_RATIO_37_5 = Object.freeze(['gpt-4.5-preview', 'gpt-4.5-preview-2025-02-27'])
export const FETCHED_AS = Object.freeze(['anonymous', 'user'])
// Scope signals go by names only (vendor ids are arbitrary database ids). / 范围信号只看名字（厂商 id 是任意的数据库 id）。
const SCOPE_VENDOR_NAME = /^(openai|anthropic|google)$/i
const SCOPE_MODEL_NAME = /claude|gpt|gemini/i
const VIDEO_NAME = /video|t2v|i2v|[-_.](?:360|480|540|720|1080|1440|2160)p(?:$|[-_.])/i
const DECIMALS = 8                        // TAPI-20 §3.9 amounts: at most 8 decimals / 至多 8 位小数
const ID_MAX = 256
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

// ---- exact decimals (no float arithmetic on prices) / 精确小数（价格不做浮点运算） ----
/** A JSON number or a decimal string as { n: BigInt, s: scale }, or null. / JSON 数或小数串转为 { n, s }，否则 null。 */
export function dec(v) {
  const t = typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : typeof v === 'string' ? v.trim() : ''
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(t)
  if (!m) return null
  const frac = m[3] ?? '', exp = Number(m[4] ?? 0)
  let n = BigInt(m[2] + frac), s = frac.length - exp
  if (s < 0) { n *= 10n ** BigInt(-s); s = 0 }
  return { n: m[1] ? -n : n, s }
}
const mul = (a, b) => ({ n: a.n * b.n, s: a.s + b.s })
// a / b for non-negative decimals, to 30 decimals (rounded down there; fmt rounds to 8 later). / 非负小数相除，保留 30 位。
const QUOT_SCALE = 30
const div = (a, b) => ({ n: (a.n * 10n ** BigInt(QUOT_SCALE + b.s)) / (b.n * 10n ** BigInt(a.s)), s: QUOT_SCALE })
const cmp = (a, b) => { const s = Math.max(a.s, b.s); const x = a.n * 10n ** BigInt(s - a.s), y = b.n * 10n ** BigInt(s - b.s); return x < y ? -1 : x > y ? 1 : 0 }
/** Rounded half up to `places` decimals, without trailing zeros: "0.028571". / 四舍五入到 places 位，去掉末尾的 0。 */
export function fmt(a, places = DECIMALS) {
  let n = a.n, s = a.s
  if (s > places) { const d = 10n ** BigInt(s - places); n = (n + (n >= 0n ? d / 2n : -(d / 2n))) / d; s = places }
  const neg = n < 0n; let digits = (neg ? -n : n).toString().padStart(s + 1, '0')
  let int = digits.slice(0, digits.length - s), fr = s ? digits.slice(digits.length - s) : ''
  fr = fr.replace(/0+$/, '')
  return `${neg && (int !== '0' || fr) ? '-' : ''}${int}${fr ? `.${fr}` : ''}`
}
const lowerThan = (a, b) => cmp(a, b) < 0

// ---- reading billing_expr without evaluating it / 读 billing_expr，从不求值 ----
/** The tiers of a billing_expr: [{ name, when, input, output }] as written, or null when it is not that shape. */
export function readBillingExpr(expr) {
  if (typeof expr !== 'string' || expr.length > 4096) return null
  const tiers = []
  const re = /(?:(len\s*(?:<=|<|>=|>)\s*\d+)\s*\?\s*)?tier\(\s*"([^"]*)"\s*,\s*p\s*\*\s*([0-9.eE+-]+)\s*\+\s*c\s*\*\s*([0-9.eE+-]+)\s*\)/g
  let m
  while ((m = re.exec(expr))) tiers.push({ name: m[2], when: m[1] ? m[1].replace(/\s+/g, ' ') : 'otherwise', input: m[3], output: m[4] })
  return tiers.length ? tiers : null
}

const asList = (v) => (Array.isArray(v) ? v : [])
const say = (en, zh) => ({ en, zh })

/**
 * Convert a saved GET /api/pricing answer. Never throws for the content of one model: each model is converted, refused
 * with a reason, and possibly flagged for review.
 * 转换存下来的 GET /api/pricing 回答。单个模型的内容从不导致抛出：每个模型要么转换，要么带原因拒绝，并可能被标出待确认。
 * @param {object} pricing  the JSON of GET /api/pricing ({ success, data: [...], group_ratio, usable_group, vendors, pricing_version, ... })
 * @param {{ usdExchangeRate: string|number, quotaPerUnit?: string|number, status?: object, fetchedAs?: 'anonymous'|'user',
 *           exclude?: string[], video?: string[], acceptRatio375?: string[], sourceBytes?: Uint8Array }} o
 * @returns {{ models: object[], meta: object, refused: object[], review: object[], notes: object[] }}
 */
export function convertPricing(pricing, o = {}) {
  if (!pricing || typeof pricing !== 'object' || !Array.isArray(pricing.data)) throw new UsageError('the file is not a GET /api/pricing answer: it has no "data" array / 文件不是 GET /api/pricing 的回答：没有 data 数组')
  if (pricing.success === false) throw new UsageError('the pricing answer says success: false / 价目回答为 success: false')
  const rate = confirmRate(o.usdExchangeRate, o.status)
  const quota = confirmQuotaPerUnit(o.quotaPerUnit, o.status)
  const fetchedAs = fetchedAsOf(o.fetchedAs)
  const exclude = new Set(asList(o.exclude)), video = new Set(asList(o.video)), accept375 = new Set(asList(o.acceptRatio375))
  const vendors = new Map(asList(pricing.vendors).filter((v) => v && Number.isInteger(v.id)).map((v) => [v.id, String(v.name ?? '')]))
  const groupRatio = pricing.group_ratio && typeof pricing.group_ratio === 'object' ? pricing.group_ratio : {}
  // The groups this answer shows prices for (usable_group); absent in older answers: every group counts.
  // 本回答给出价格的分组（usable_group）；旧版回答没有它：所有分组都算。
  const usable = pricing.usable_group && typeof pricing.usable_group === 'object' && !Array.isArray(pricing.usable_group) ? new Set(Object.keys(pricing.usable_group)) : null
  const selfUse = o.status === undefined ? null : (o.status?.data?.self_use_mode_enabled ?? o.status?.self_use_mode_enabled ?? null)
  const perRatio = div(dec('1000000'), dec(quota.value))           // USD per 1M tokens at ratio 1 / 倍率 1 时每百万 token 的美元数
  const placeholder = dec(UNPRICED_RATIO), one = dec('1')
  const placeholderUsd = fmt(mul(placeholder, perRatio))
  const names = new Map()
  for (const m of pricing.data) if (typeof m?.model_name === 'string') names.set(m.model_name, (names.get(m.model_name) ?? 0) + 1)

  const models = [], refused = [], review = [], converted = []
  const refuse = (id, code, msg) => refused.push({ id, code, ...msg })
  const flag = (id, code, msg) => review.push({ id, code, ...msg })
  for (const m of pricing.data) {
    const id = m?.model_name
    if (typeof id !== 'string' || id.length < 1 || id.length > ID_MAX || CONTROL.test(id)) { refuse(typeof id === 'string' ? id : String(id), 'bad-name', say(`model_name must be 1 to ${ID_MAX} UTF-16 code units without control characters (TAPI-20 §3.9)`, `model_name 须为 1 到 ${ID_MAX} 个 UTF-16 码元且不含控制字符（TAPI-20 §3.9）`)); continue }
    if (names.get(id) > 1) { refuse(id, 'duplicate', say('the name appears more than once in the list', '名字在价目里出现不止一次')); continue }
    // Scope signal first: it is reported whatever happens to the model. / 范围信号先报：不论模型是否转换。
    const vname = Number.isInteger(m.vendor_id) ? vendors.get(m.vendor_id) : undefined
    if ((vname && SCOPE_VENDOR_NAME.test(vname)) || SCOPE_MODEL_NAME.test(id)) {
      flag(id, 'scope', say(`scope signal: vendor ${m.vendor_id ?? 'not declared'}${vname ? ` (${vname})` : ''}; whether this model may be resold is for the operator to decide, this tool only points it out (--check shows it as a NOTE, exit status 0 for it)`, `范围信号：厂商 ${m.vendor_id ?? '未声明'}${vname ? `（${vname}）` : ''}；是否可以转售此类模型由服务方自行确认，本工具只做提示（--check 以 NOTE 显示，不因它退出 1）`))
    }
    if (exclude.has(id)) { refuse(id, 'excluded', say('excluded with --exclude', '按 --exclude 排除')); continue }
    if (video.has(id) || VIDEO_NAME.test(id)) { refuse(id, 'video', say(`a video model${video.has(id) ? ' (--video)' : ' by its name'}: TAPI-20 §3.9 prices text formats only, and the sidecar signs no receipt for these calls; confirm the list`, `视频模型${video.has(id) ? '（--video）' : '（按名字判断）'}：TAPI-20 §3.9 只给文本格式定价，旁路不为这些调用签回执；请确认名单`)); continue }
    if (m.billing_mode !== undefined && m.billing_mode !== null && m.billing_mode !== '') {
      const tiers = readBillingExpr(m.billing_expr)
      const shown = tiers ? tiers.map((t) => `${t.name} [${t.when}]: p x ${t.input} + c x ${t.output}`).join('; ') : `billing_expr ${JSON.stringify(String(m.billing_expr ?? '')).slice(0, 120)}`
      if (m.billing_mode === 'tiered_expr') refuse(id, 'tiered', say(`priced by its billing_expr in ${tiers ? tiers.length : 'unreadable'} tier(s) (${shown}); a tiered price is not one price per 1M tokens, and model_ratio ${m.model_ratio} is a placeholder, not used`, `按 billing_expr 分 ${tiers ? tiers.length : '（读不出）'} 档计价（${shown}）；分档价格不是一个每百万 token 单价；model_ratio ${m.model_ratio} 只是占位，不使用`))
      else refuse(id, 'billing-mode', say(`billing_mode ${JSON.stringify(m.billing_mode)} is not one this converter knows (${shown}); model_ratio is not used`, `不认识的 billing_mode ${JSON.stringify(m.billing_mode)}（${shown}）；不使用 model_ratio`))
      continue
    }
    if (m.quota_type !== undefined && m.quota_type !== 0) { refuse(id, 'per-request', say(`quota_type ${m.quota_type}: priced per request (model_price ${m.model_price}), not per token`, `quota_type ${m.quota_type}：按次计价（model_price ${m.model_price}），不是按 token`)); continue }
    const types = m.supported_endpoint_types
    if (Array.isArray(types) && !types.includes('openai')) { refuse(id, 'endpoint-type', say(`served on ${types.join(', ') || 'no endpoint type'}, not on the OpenAI endpoint type the sidecar's openai-chat format fronts`, `提供于 ${types.join('、') || '无端点类型'}，不在旁路 openai-chat 格式所对应的 OpenAI 端点类型上`)); continue }
    const ratio = dec(m.model_ratio), comp = m.completion_ratio === undefined ? one : dec(m.completion_ratio)
    const cache = m.cache_ratio === undefined || m.cache_ratio === null ? null : dec(m.cache_ratio)
    const cacheWrite = m.create_cache_ratio === undefined || m.create_cache_ratio === null ? null : dec(m.create_cache_ratio)
    if (!ratio || ratio.n < 0n || !comp || comp.n < 0n || (m.cache_ratio != null && (!cache || cache.n < 0n)) || (m.create_cache_ratio != null && (!cacheWrite || cacheWrite.n < 0n))) { refuse(id, 'bad-number', say('model_ratio, completion_ratio, cache_ratio or create_cache_ratio is not a non-negative number', 'model_ratio、completion_ratio、cache_ratio 或 create_cache_ratio 不是非负数')); continue }
    let ratio375 = null
    if (cmp(ratio, placeholder) === 0) {
      // 37.5: the placeholder of a model with no price, or a real price; /api/pricing does not say which (FIXED P-2).
      // 37.5：未设价的占位，或是真价；/api/pricing 不区分。
      if (DEFAULT_RATIO_37_5.includes(id)) ratio375 = 'default'
      else if (accept375.has(id)) ratio375 = 'accepted'
      else {
        const selfUseEn = selfUse === true
          ? ` This site runs in self-use mode (GET /api/status self_use_mode_enabled): new-api serves this model and bills it at ratio ${UNPRICED_RATIO} (${placeholderUsd} quota dollars per 1M input tokens); left out of the table, its calls get receipts with prices: null.`
          : selfUse === null ? ` If your site runs in self-use mode (GET /api/status self_use_mode_enabled), new-api serves this model and bills it at ratio ${UNPRICED_RATIO}; pass --status to know.` : ''
        const selfUseZh = selfUse === true
          ? `本站点开启了自用模式（GET /api/status 的 self_use_mode_enabled）：new-api 会提供此模型并按倍率 ${UNPRICED_RATIO} 计费（每百万输入 token ${placeholderUsd} 额度美元）；不写进价目表时，这些调用的回执 prices 为 null。`
          : selfUse === null ? `若站点开启了自用模式（GET /api/status 的 self_use_mode_enabled），new-api 会提供此模型并按倍率 ${UNPRICED_RATIO} 计费；给出 --status 即可确认。` : ''
        refuse(id, 'ratio-37.5-ambiguous', say(`model_ratio ${UNPRICED_RATIO} without a billing_mode is new-api's placeholder for a model with no price set, or a real price of ${UNPRICED_RATIO}; /api/pricing cannot tell them apart, so it is not converted; --accept-ratio-37.5 ${JSON.stringify(id)} publishes it at ${UNPRICED_RATIO} once you have checked.${selfUseEn}`, `model_ratio ${UNPRICED_RATIO} 且没有 billing_mode：可能是 new-api 给未设价模型的占位，也可能真价就是 ${UNPRICED_RATIO}；/api/pricing 无法区分，因此不转换；核实后用 --accept-ratio-37.5 ${JSON.stringify(id)} 按 ${UNPRICED_RATIO} 发布。${selfUseZh}`))
        continue
      }
    }
    // Only the groups this answer shows prices for count (FIXED P-5). / 只计本回答给出价格的分组。
    const groups = asList(m.enable_groups)
    const visible = usable ? groups.filter((g) => usable.has(g)) : groups
    const hidden = groups.filter((g) => !visible.includes(g))
    if (groups.length && !visible.length) { refuse(id, 'no-visible-group', say(`enabled only for groups this answer shows no prices for (${hidden.join(', ')}; usable_group lists ${[...usable].join(', ') || 'none'}): fetched ${fetchedAs.en}, its price cannot be read`, `只在本回答不给价格的分组里启用（${hidden.join('、')}；usable_group 只有 ${[...usable].join('、') || '无'}）：取价身份为${fetchedAs.zh}，读不到它的价格`)); continue }
    const gr = [...new Set(visible.map((g) => (groupRatio[g] === undefined ? 'missing' : String(groupRatio[g]))))]
    if (gr.includes('missing') || gr.length > 1) { refuse(id, 'group-ratio', say(`its groups (${visible.join(', ')}) ${gr.includes('missing') ? 'include one with no group_ratio' : `have different group ratios (${gr.join(', ')})`}: one published price would be wrong for some users`, `其分组（${visible.join('、')}）${gr.includes('missing') ? '中有分组没有 group_ratio' : `倍率不同（${gr.join('、')}）`}：一个公示价对部分用户不成立`)); continue }
    const g = gr.length ? dec(gr[0]) : one
    if (!g || g.n < 0n) { refuse(id, 'group-ratio', say(`group ratio ${gr[0]} is not a non-negative number`, `分组倍率 ${gr[0]} 不是非负数`)); continue }

    const input = mul(mul(ratio, perRatio), g)
    const price = { currency: 'USD', unit: '1M tokens', input: fmt(input), output: fmt(mul(input, comp)) }
    if (cache) price.cacheRead = fmt(mul(input, cache))
    if (cacheWrite) price.cacheWrite = fmt(mul(input, cacheWrite))
    models.push({ id, prices: [price] })
    converted.push({ id, model_ratio: m.model_ratio, completion_ratio: m.completion_ratio ?? null, cache_ratio: m.cache_ratio ?? null, ...(cacheWrite ? { create_cache_ratio: m.create_cache_ratio } : {}), group_ratio: gr[0] ?? null, vendor_id: m.vendor_id ?? null })
    if (ratio375 === 'default') flag(id, 'ratio-37.5-default-price', say(`model_ratio ${UNPRICED_RATIO} is this model's price in new-api's default ratio table (and also the placeholder of a model with no price): converted as a price; confirm it`, `model_ratio ${UNPRICED_RATIO} 是此模型在 new-api 默认倍率表里的价格（也恰是未设价模型的占位值）：按价格转换，请确认`))
    if (ratio375 === 'accepted') flag(id, 'ratio-37.5-accepted', say(`model_ratio ${UNPRICED_RATIO} published as a price (--accept-ratio-37.5)`, `model_ratio ${UNPRICED_RATIO} 按价格发布（--accept-ratio-37.5）`))
    if (hidden.length) flag(id, 'groups-not-visible', say(`also enabled for ${hidden.join(', ')}, which this answer shows no price for (fetched ${fetchedAs.en}): the published price is the one of ${visible.join(', ')}; users of the other groups may pay another ratio`, `也在 ${hidden.join('、')} 分组启用，但本回答没有这些分组的价格（取价身份：${fetchedAs.zh}）：公示价是 ${visible.join('、')} 的价格，其它分组的用户可能按别的倍率付费`))
    if (lowerThan(comp, one)) flag(id, 'output-below-input', say(`completion_ratio ${m.completion_ratio} < 1: the output price is below the input price; the operator confirms it`, `completion_ratio ${m.completion_ratio} < 1：输出价低于输入价，请服务方确认`))
    if (!Number.isInteger(m.vendor_id)) flag(id, 'vendor-undeclared', say('no vendor_id: the vendor is not declared', '没有 vendor_id：厂商未声明'))
    if (cmp(g, one) !== 0) flag(id, 'group-ratio-applied', say(`group ratio ${gr[0]} applied to every price`, `所有价格已乘分组倍率 ${gr[0]}`))
    if (input.n === 0n) flag(id, 'free', say('model_ratio 0: published as free', 'model_ratio 为 0：按免费公示'))
    const r = dec(rate)
    flag(id, 'cny-shown', say(`new-api's pricing page shows about ${fmt(mul(input, r), 4)} / ${fmt(mul(mul(input, comp), r), 4)} CNY per 1M tokens at usd_exchange_rate ${rate}; compare it with your page`, `按 usd_exchange_rate ${rate}，new-api 价目页约显示每百万 token 输入 ${fmt(mul(input, r), 4)} / 输出 ${fmt(mul(mul(input, comp), r), 4)} 元，请与你的页面对照`))
  }
  if (!models.length) throw new UsageError(`no model could be converted (${refused.length} refused): nothing to publish / 没有可转换的模型（拒绝 ${refused.length} 个）：没有可发布的内容`)
  const topUp = o.status?.data?.price
  const notes = []
  const note = (code, msg) => notes.push({ code, ...msg })
  note('fetched-as', fetchedAs.note)
  if (quota.value !== NEWAPI_DEFAULT_QUOTA_PER_UNIT) note('quota-per-unit', say(`quota_per_unit is ${quota.value}, not new-api's default ${NEWAPI_DEFAULT_QUOTA_PER_UNIT}: USD = model_ratio x ${fmt(perRatio)} per 1M tokens here, what new-api bills in quota dollars; compare with your pricing page, which may show another figure`, `quota_per_unit 是 ${quota.value}，不是 new-api 的默认值 ${NEWAPI_DEFAULT_QUOTA_PER_UNIT}：这里每百万 token 美元价 = model_ratio x ${fmt(perRatio)}，即 new-api 按额度美元计费的数；请与价目页对照，价目页显示的数可能不同`))
  const meta = {
    tool: TOOL, experimental: true,
    source: {
      newapi_build_marker: typeof pricing.pricing_version === 'string' ? pricing.pricing_version : null,
      content_sha256: pricingContentHash(pricing),
      sha256: o.sourceBytes ? createHash('sha256').update(o.sourceBytes).digest('hex') : null,
      fetched_as: fetchedAs.value,
      usable_group: usable ? [...usable] : null,
      auto_groups: Array.isArray(pricing.auto_groups) ? pricing.auto_groups.map(String) : null,
    },
    usd_exchange_rate: rate,
    quota_per_unit: quota.value,
    quota_per_unit_from: quota.from,
    ...(selfUse !== null ? { self_use_mode_enabled: selfUse } : {}),
    rule: `USD per 1M tokens = model_ratio x 1000000 / quota_per_unit (${quota.value}: x ${fmt(perRatio)}) x group ratio; output = input x completion_ratio; cacheRead = input x cache_ratio; cacheWrite = input x create_cache_ratio; rounded half up to 8 decimals. Quota dollars, display only.`,
    options: { exclude: [...exclude], video: [...video], accept_ratio_37_5: [...accept375] },
    converted, refused: refused.map((r) => ({ id: r.id, code: r.code, en: r.en })),
    review: review.filter((r) => r.code !== 'cny-shown').map((r) => ({ id: r.id, code: r.code, en: r.en })),
    ...(topUp !== undefined && String(topUp) !== String(rate) ? { note: `GET /api/status says price (the top-up price) ${topUp} per quota dollar, not ${rate}: what users pay in CNY is ${topUp} per quota dollar` } : {}),
  }
  return { models, meta, refused, review, notes }
}

export class UsageError extends Error {}

/** The exchange rate, confirmed: --usd-exchange-rate must be given, and must equal /api/status when given. / 确认的汇率。 */
function confirmRate(given, status) {
  const fromStatus = status === undefined ? undefined : status?.data?.usd_exchange_rate ?? status?.usd_exchange_rate
  if (status !== undefined && fromStatus === undefined) throw new UsageError('the status file has no usd_exchange_rate (GET /api/status, data.usd_exchange_rate) / 状态文件里没有 usd_exchange_rate')
  if (given === undefined || given === null || given === '') {
    throw new UsageError(fromStatus !== undefined
      ? `confirm the exchange rate: your /api/status says usd_exchange_rate ${fromStatus}; run again with --usd-exchange-rate ${fromStatus} (there is no default) / 请确认汇率：你的 /api/status 写的是 ${fromStatus}；加上 --usd-exchange-rate ${fromStatus} 再运行（没有默认值）`
      : 'the exchange rate must be confirmed: pass --usd-exchange-rate <new-api\'s usd_exchange_rate, from GET /api/status> (there is no default) / 汇率必须显式确认：传入 --usd-exchange-rate <你的 new-api 在 GET /api/status 里的 usd_exchange_rate>（没有默认值）')
  }
  const r = dec(given)
  if (!r || r.n <= 0n) throw new UsageError(`--usd-exchange-rate must be a positive number, not ${JSON.stringify(String(given))}`)
  if (fromStatus !== undefined && (!dec(fromStatus) || cmp(r, dec(fromStatus)) !== 0)) throw new UsageError(`--usd-exchange-rate ${given} differs from usd_exchange_rate ${fromStatus} in the status file; the table must use the rate your site uses / --usd-exchange-rate ${given} 与状态文件里的 ${fromStatus} 不同`)
  return fmt(r)
}

/**
 * quota_per_unit (quota per $1), a setting of the site (FIXED P-1): read from the status file (data.quota_per_unit), or
 * given with --quota-per-unit when the status file is not given or does not carry it; both given must agree. No default.
 * quota_per_unit（每 1 美元的额度）是站点的可改选项：从状态文件读；没有状态文件或其中没有时必须用 --quota-per-unit 给出；两者都给时须一致。没有默认值。
 */
function confirmQuotaPerUnit(given, status) {
  const fromStatus = status === undefined ? undefined : status?.data?.quota_per_unit ?? status?.quota_per_unit
  const has = (v) => v !== undefined && v !== null && v !== ''
  if (!has(given) && !has(fromStatus)) {
    throw new UsageError(`quota_per_unit is needed to turn ratios into dollars and ${status === undefined ? 'no status file was given' : 'the status file has no data.quota_per_unit'}: pass --status <GET /api/status saved> or --quota-per-unit <your new-api's quota_per_unit> (new-api's default is ${NEWAPI_DEFAULT_QUOTA_PER_UNIT}; there is no default here) / 需要 quota_per_unit 才能把倍率换算成美元，${status === undefined ? '但没有给出状态文件' : '但状态文件里没有 data.quota_per_unit'}：传入 --status <存下的 GET /api/status> 或 --quota-per-unit <你的 new-api 的 quota_per_unit>（new-api 默认 ${NEWAPI_DEFAULT_QUOTA_PER_UNIT}；这里没有默认值）`)
  }
  const value = has(fromStatus) ? fromStatus : given
  const q = dec(value)
  if (!q || q.n <= 0n) throw new UsageError(`quota_per_unit must be a positive number, not ${JSON.stringify(String(value))}`)
  if (has(given) && has(fromStatus) && (!dec(given) || cmp(dec(given), q) !== 0)) throw new UsageError(`--quota-per-unit ${given} differs from quota_per_unit ${fromStatus} in the status file / --quota-per-unit ${given} 与状态文件里的 ${fromStatus} 不同`)
  return { value: fmt(q, q.s), from: has(fromStatus) ? 'GET /api/status data.quota_per_unit' : '--quota-per-unit' }
}

/** Who fetched /api/pricing, as stated (FIXED P-5): its content depends on it. / 取价身份：内容取决于它。 */
function fetchedAsOf(v) {
  if (v === undefined || v === null || v === '') {
    return { value: null, en: 'by a caller not stated', zh: '未说明', note: say('fetched as: not stated (--fetched-as anonymous|user). Fetch /api/pricing anonymously, without a cookie or token, as the README does; if the site shows prices to logged-in users only, use an ordinary user, never an administrator: a logged-in answer has that user\'s group ratio and only the groups that user can use', '取价身份：未说明（--fetched-as anonymous|user）。请像 README 那样匿名取 /api/pricing（不带 cookie 或令牌）；若站点要求登录才看价目，用普通用户，绝不用管理员：登录后的回答是该用户分组的倍率，且只列该用户可用的分组') }
  }
  if (!FETCHED_AS.includes(v)) throw new UsageError(`--fetched-as must be anonymous or user, not ${JSON.stringify(String(v))}`)
  return v === 'anonymous'
    ? { value: v, en: 'anonymously', zh: '匿名', note: say('fetched as: anonymous (stated): the prices of the groups an anonymous visitor sees', '取价身份：匿名（已说明）：匿名访客看得到的分组的价格') }
    : { value: v, en: 'as a logged-in user', zh: '登录用户', note: say('fetched as: a logged-in user (stated): group_ratio is that user\'s group\'s, and only the groups that user can use are listed; use an ordinary user, never an administrator', '取价身份：登录用户（已说明）：group_ratio 是该用户分组的倍率，且只列该用户可用的分组；请用普通用户，绝不用管理员') }
}

// The price fields of a model, as the converter reads them (not pricing_version, names, icons or descriptions).
// 模型的价格字段，即转换器读取的那些（不含 pricing_version、名称、图标、描述）。
const PRICE_FIELDS = ['quota_type', 'model_ratio', 'model_price', 'completion_ratio', 'cache_ratio', 'create_cache_ratio', 'billing_mode', 'billing_expr', 'enable_groups', 'supported_endpoint_types', 'vendor_id']
const canonNumber = (v) => { if (typeof v !== 'number' && typeof v !== 'string') return v; const d = dec(v); return d ? fmt(d, d.s) : v }
const sortedObject = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, canonNumber(o[k])])) : null)
/**
 * A stable hash of what the price list says about prices (FIXED P-4): every model's price fields (numbers written one way,
 * lists sorted), the models sorted by name, and the group ratios with the groups shown. Not pricing_version (new-api's
 * build marker), not the order of the list, not names of vendors or icons.
 * 价目内容的稳定哈希：每个模型的价格字段（数字只有一种写法、列表排序），模型按名字排序，加上分组倍率与可见分组。不含 pricing_version
 * （new-api 的构建标记）、列表顺序、厂商名或图标。
 */
export function pricingContentHash(pricing) {
  const models = asList(pricing?.data).map((m) => [String(m?.model_name), Object.fromEntries(PRICE_FIELDS.filter((k) => m?.[k] !== undefined).map((k) => [k, Array.isArray(m[k]) ? [...m[k]].map(String).sort() : canonNumber(m[k])]))])
  models.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const content = { models, group_ratio: sortedObject(pricing?.group_ratio), usable_group: pricing?.usable_group && typeof pricing.usable_group === 'object' ? Object.keys(pricing.usable_group).sort() : null }
  return createHash('sha256').update(JSON.stringify(content)).digest('hex')
}

const priceKey = (p) => JSON.stringify(['currency', 'unit', 'input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h', 'reasoning'].map((k) => p?.[k] ?? null))

/**
 * Compare today's GET /api/pricing with the published table and the source record written with it.
 * 用今天的 GET /api/pricing 对照已发布的价目表与随之写下的来源记录。
 * @returns {{ ok: boolean, drift: Array<{ code, id?, en, zh }>, notes: Array<{ code, en, zh }> }}
 */
export function checkPricing(pricing, published, meta, { status, fetchedAs } = {}) {
  if (!meta || meta.tool !== TOOL) throw new UsageError(`the source record is not one ${TOOL} wrote / 来源记录不是本工具写的`)
  if (!Array.isArray(published)) throw new UsageError('the published table must be a JSON array (models.json) / 已发布的价目表须为 JSON 数组')
  if (!meta.quota_per_unit || !meta.source?.content_sha256) throw new UsageError('the source record has no quota_per_unit or content hash: an older version of this tool wrote it; convert again / 来源记录没有 quota_per_unit 或内容哈希（旧版本写的）：请重新转换')
  const drift = [], notes = []
  // The build marker: a NOTE, never drift (it changes with new-api's source, not with prices). / 构建标记：只是备注。
  const marker = typeof pricing?.pricing_version === 'string' ? pricing.pricing_version : null
  if (marker !== meta.source.newapi_build_marker) notes.push({ code: 'build-marker', ...say(`new-api's build marker (pricing_version) changed: ${meta.source.newapi_build_marker} -> ${marker}; it is a constant of new-api's source, not a price version: the prices are compared below`, `new-api 的构建标记（pricing_version）变了：${meta.source.newapi_build_marker} -> ${marker}；它是 new-api 源码里的常量，不是价目版本：价格逐条比对如下`) })
  const stated = fetchedAs === undefined || fetchedAs === null || fetchedAs === '' ? null : fetchedAsOf(fetchedAs).value
  if (stated && meta.source.fetched_as && stated !== meta.source.fetched_as) drift.push({ code: 'fetched-as', ...say(`the table was made from an answer fetched as ${meta.source.fetched_as}, this one as ${stated}: their groups and ratios differ; fetch it the same way`, `价目表按“${meta.source.fetched_as}”取到的回答生成，这一份是“${stated}”取的：分组与倍率不同；请用同样的身份取`) })
  if (status !== undefined) {
    const now = status?.data?.usd_exchange_rate ?? status?.usd_exchange_rate
    if (now === undefined || !dec(now) || cmp(dec(now), dec(meta.usd_exchange_rate)) !== 0) drift.push({ code: 'exchange-rate', ...say(`usd_exchange_rate is ${now} now, the table was made at ${meta.usd_exchange_rate}`, `usd_exchange_rate 现在是 ${now}，价目表按 ${meta.usd_exchange_rate} 生成`) })
    const q = status?.data?.quota_per_unit ?? status?.quota_per_unit
    if (q !== undefined && (!dec(q) || cmp(dec(q), dec(meta.quota_per_unit)) !== 0)) drift.push({ code: 'quota-per-unit', ...say(`quota_per_unit is ${q} now, the table was made at ${meta.quota_per_unit}: every dollar figure changes`, `quota_per_unit 现在是 ${q}，价目表按 ${meta.quota_per_unit} 生成：所有美元数都会变`) })
  }
  const now = convertPricing(pricing, { usdExchangeRate: meta.usd_exchange_rate, quotaPerUnit: meta.quota_per_unit, fetchedAs: meta.source.fetched_as ?? undefined, exclude: meta.options?.exclude, video: meta.options?.video, acceptRatio375: meta.options?.accept_ratio_37_5 })
  const pub = new Map(published.filter((m) => m && typeof m.id === 'string').map((m) => [m.id, m]))
  const listed = new Set(asList(pricing.data).map((m) => m?.model_name))
  for (const m of now.models) {
    const p = pub.get(m.id)
    if (!p) { drift.push({ code: 'model-added', id: m.id, ...say(`${m.id}: priced on the site, not in the published table`, `${m.id}：站点上有价，已发布的价目表里没有`) }); continue }
    const usd = asList(p.prices).find((x) => x?.currency === 'USD')
    if (!usd || priceKey(usd) !== priceKey(m.prices[0])) drift.push({ code: 'price-changed', id: m.id, ...say(`${m.id}: the site's price is ${m.prices[0].input}/${m.prices[0].output} USD, the published one ${usd ? `${usd.input}/${usd.output}` : 'has no USD entry'}`, `${m.id}：站点价 ${m.prices[0].input}/${m.prices[0].output} USD，已发布的是 ${usd ? `${usd.input}/${usd.output}` : '没有 USD 项'}`) })
  }
  const nowIds = new Set(now.models.map((m) => m.id))
  for (const id of pub.keys()) {
    if (nowIds.has(id)) continue
    // Priced by hand (a tiered model the operator wrote himself) is fine while the site still lists it.
    // 手工定价（例如服务方自己写的分档模型）在站点仍列出它时不算漂移。
    if (!listed.has(id)) drift.push({ code: 'model-gone', id, ...say(`${id}: published, but the site no longer lists it`, `${id}：已发布，但站点已不再列出`) })
    else if (meta.converted?.some((c) => c.id === id)) drift.push({ code: 'model-refused-now', id, ...say(`${id}: converted before, refused now (${now.refused.find((r) => r.id === id)?.en ?? 'see the report'})`, `${id}：以前可转换，现在被拒绝`) })
  }
  // The content hash: any change of a price field, also of a refused or hand-priced model, or of a group ratio.
  // 内容哈希：任何价格字段的变化，包括被拒绝或手工定价的模型、分组倍率。
  const hash = pricingContentHash(pricing)
  if (hash !== meta.source.content_sha256 && !drift.some((d) => ['price-changed', 'model-added', 'model-gone', 'model-refused-now'].includes(d.code))) {
    drift.push({ code: 'content-changed', ...say(`the price list's content changed since the table was made (content hash ${meta.source.content_sha256.slice(0, 12)}... -> ${hash.slice(0, 12)}...), though no converted price differs: a refused or hand-priced model, or a group ratio, changed; convert again and read the report`, `价目内容自生成价目表以来变了（内容哈希 ${meta.source.content_sha256.slice(0, 12)}... -> ${hash.slice(0, 12)}...），但转换出的价格没有不同：被拒绝或手工定价的模型、或分组倍率变了；请重新转换并阅读报告`) })
  }
  // Scope signals: a NOTE, not drift (FIXED B-4). A relay that resells such models has them every day; drift is a change.
  // 范围信号：只是 NOTE，不算漂移。转售这类模型的中转站每天都有它；漂移指的是变化。
  for (const r of now.review.filter((x) => x.code === 'scope')) notes.push({ code: 'scope', id: r.id, en: `${r.id}: ${r.en}`, zh: `${r.id}：${r.zh}` })
  return { ok: drift.length === 0, drift, notes }
}

// ---- the command / 命令行 ----
function parseArgs(argv) {
  const o = { exclude: [], video: [], accept375: [], files: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const value = () => { if (i + 1 >= argv.length) throw new UsageError(`${a} needs a value`); return argv[++i] }
    switch (a) {
      case '--check': o.check = true; break
      case '--usd-exchange-rate': o.rate = value(); break
      case '--status': o.status = value(); break
      case '--out': o.out = value(); break
      case '--models': o.models = value(); break
      case '--meta': o.meta = value(); break
      case '--exclude': o.exclude.push(value()); break
      case '--video': o.video.push(value()); break
      case '--quota-per-unit': o.quota = value(); break
      case '--fetched-as': o.fetchedAs = value(); break
      case '--accept-ratio-37.5': o.accept375.push(value()); break
      case '--help': case '-h': o.help = true; break
      default:
        if (a.startsWith('-')) throw new UsageError(`unknown option ${a}`)
        o.files.push(a)
    }
  }
  return o
}
const metaPathOf = (models) => (models.endsWith('.json') ? models.slice(0, -5) : models) + '.newapi-source.json'
function readJson(p, what) {
  let bytes
  try { bytes = readFileSync(p) } catch (e) { throw new UsageError(`${what} ${p} cannot be read (${e.code || e.message})`) }
  if (!bytes.length) throw new UsageError(`${what} ${p} is empty`)
  try { return { json: JSON.parse(bytes.toString('utf8')), bytes } } catch (e) { throw new UsageError(`${what} ${p} is not valid JSON: ${e.message}`) }
}
const USAGE = `usage: ${TOOL} <pricing.json> --usd-exchange-rate <n> [--status <status.json> | --quota-per-unit <n>] [--fetched-as anonymous|user]
         [--out models.json] [--exclude <name>]... [--video <name>]... [--accept-ratio-37.5 <name>]...
       ${TOOL} --check <pricing.json> --models <models.json> [--meta <models.newapi-source.json>] [--status <status.json>] [--fetched-as anonymous|user]
(experimental; reads files only: save GET /api/pricing and GET /api/status of your own new-api first)`

/** Run the command; returns the exit code. / 运行命令，返回退出码。 */
export function run(argv, { out = (t) => process.stdout.write(t), err = (t) => process.stderr.write(t) } = {}) {
  try {
    const o = parseArgs(argv)
    if (o.help) { out(USAGE + '\n'); return 0 }
    if (o.files.length !== 1) throw new UsageError('give exactly one pricing file')
    const { json: pricing, bytes } = readJson(o.files[0], 'the pricing file')
    const status = o.status ? readJson(o.status, 'the status file').json : undefined
    if (o.check) {
      if (!o.models) throw new UsageError('--check needs --models <the published models.json>')
      const published = readJson(o.models, 'the published table').json
      const meta = readJson(o.meta ?? metaPathOf(o.models), 'the source record').json
      const r = checkPricing(pricing, published, meta, { status, fetchedAs: o.fetchedAs })
      for (const n of r.notes) err(`NOTE  ${n.code}: ${n.en}\n      ${n.zh}\n`)
      for (const d of r.drift) err(`DRIFT ${d.code}: ${d.en}\n      ${d.zh}\n`)
      err(r.ok ? `${TOOL}: no drift (content ${meta.source.content_sha256.slice(0, 12)}..., fetched as ${meta.source.fetched_as ?? 'not stated'}) / 无漂移\n` : `${TOOL}: ${r.drift.length} drift item(s); update the table, publish it again (console step 5), then re-run --check / 有 ${r.drift.length} 项漂移\n`)
      return r.ok ? 0 : 1
    }
    const r = convertPricing(pricing, { usdExchangeRate: o.rate, quotaPerUnit: o.quota, status, fetchedAs: o.fetchedAs, exclude: o.exclude, video: o.video, acceptRatio375: o.accept375, sourceBytes: bytes })
    const text = JSON.stringify(r.models, null, 2) + '\n'
    if (o.out) {
      writeFileSync(o.out, text)
      writeFileSync(metaPathOf(o.out), JSON.stringify(r.meta, null, 2) + '\n')
    } else out(text)
    err(`${TOOL} (experimental): ${r.models.length} converted, ${r.refused.length} refused, usd_exchange_rate ${r.meta.usd_exchange_rate} (confirmed), quota_per_unit ${r.meta.quota_per_unit} (from ${r.meta.quota_per_unit_from}), fetched as ${r.meta.source.fetched_as ?? 'not stated'}, new-api build marker ${r.meta.source.newapi_build_marker}\n`)
    for (const n of r.notes) err(`NOTE   ${n.code}: ${n.en}\n       ${n.zh}\n`)
    for (const x of r.refused) err(`REFUSED ${x.id}: ${x.en}\n        ${x.zh}\n`)
    for (const x of r.review) err(`${x.code === 'cny-shown' ? 'NOTE  ' : 'REVIEW'} ${x.id}: ${x.en}\n       ${x.zh}\n`)
    if (r.meta.note) err(`NOTE ${r.meta.note}\n`)
    const factor = fmt(div(dec('1000000'), dec(r.meta.quota_per_unit)))
    err(`USD here is new-api's quota dollar (model_ratio x 1000000 / quota_per_unit ${r.meta.quota_per_unit} = model_ratio x $${factor} per 1M tokens; quota_per_unit from ${r.meta.quota_per_unit_from}), for display only; check every line above before publishing. / 这里的 USD 是 new-api 的额度美元（倍率 x 1000000 / quota_per_unit ${r.meta.quota_per_unit} = 倍率 x ${factor} 美元/百万 token；quota_per_unit 来自 ${r.meta.quota_per_unit_from}），仅作展示；发布前逐条核对上面每一行。\n`)
    if (o.out) err(`wrote ${o.out} and ${metaPathOf(o.out)}\n`)
    return 0
  } catch (e) {
    if (e instanceof UsageError) { err(`${TOOL}: ${e.message}\n${USAGE}\n`); return 2 }
    throw e
  }
}

const isMain = (() => { try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) } catch { return false } })()
if (isMain) process.exitCode = run(process.argv.slice(2))
