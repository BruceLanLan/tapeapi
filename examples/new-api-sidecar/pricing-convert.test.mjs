// E1: tapeapi-newapi-prices (pricing-convert.mjs, experimental), new-api's GET /api/pricing -> the sidecar's price table.
// The fixture is a structural copy of a real new-api answer with placeholder model and vendor names; every rule of the
// converter is a test here. Files only, no network.
// E1：new-api 价目转换器（实验性）。夹具是一份真实 new-api 回答的结构副本，模型名与厂商名都换成了占位；转换器的每条规则在这里都有测试。
// 只读写文件，不联网。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ai } from '@tapeapi/sdk'
import { convertPricing, checkPricing, pricingContentHash, readBillingExpr, dec, fmt, run, UsageError, TOOL, DEFAULT_RATIO_37_5 } from './pricing-convert.mjs'
import { readModels, selectFormats } from './server.mjs'

const here = (p) => fileURLToPath(new URL(p, import.meta.url))
const FIXTURE = here('fixtures/new-api-pricing.sample.json')
const GOLDEN = here('fixtures/new-api-pricing.sample.models.json')
const GOLDEN_META = here('fixtures/new-api-pricing.sample.models.newapi-source.json')
const BIN = here('pricing-convert.mjs')
const sample = () => JSON.parse(readFileSync(FIXTURE, 'utf8'))
const tmp = mkdtempSync(join(tmpdir(), 'newapi-prices-'))
test.after(() => rmSync(tmp, { recursive: true, force: true }))
const file = (name, v) => { const p = join(tmp, name); writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v)); return p }
const conv = (pricing = sample(), o = {}) => convertPricing(pricing, { usdExchangeRate: '7', quotaPerUnit: '500000', ...o })
const Q = ['--quota-per-unit', '500000']
const byId = (r, id) => r.models.find((m) => m.id === id)
const refusal = (r, id) => r.refused.find((x) => x.id === id)
const cli = (args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' })
const model = (extra) => ({ model_name: 'model-x', vendor_id: 1, quota_type: 0, model_ratio: 1, model_price: 0, owner_by: '', completion_ratio: 2, enable_groups: ['1x'], supported_endpoint_types: ['openai'], ...extra })
const withModels = (...extra) => { const p = sample(); p.data.push(...extra); return p }

test('E1: the sample converts to the committed golden table byte for byte (9 converted, 6 refused), deterministically', () => {
  const out = file('models.json', '')
  for (let i = 0; i < 2; i++) {
    const r = cli([FIXTURE, '--usd-exchange-rate', '7', ...Q, '--out', out])
    assert.equal(r.status, 0, r.stderr)
    assert.equal(readFileSync(out, 'utf8'), readFileSync(GOLDEN, 'utf8'))
    assert.equal(readFileSync(out.replace(/\.json$/, '.newapi-source.json'), 'utf8'), readFileSync(GOLDEN_META, 'utf8'))
  }
  const r = conv()
  assert.equal(r.models.length, 9); assert.equal(r.refused.length, 6)
  // Without --out: the table on stdout, the report on stderr. / 不带 --out：价目表在 stdout，报告在 stderr。
  const s = cli([FIXTURE, '--usd-exchange-rate', '7', ...Q])
  assert.equal(s.stdout, readFileSync(GOLDEN, 'utf8'))
  assert.match(s.stderr, /9 converted, 6 refused, usd_exchange_rate 7 \(confirmed\), quota_per_unit 500000 \(from --quota-per-unit\), fetched as not stated, new-api build marker 0123456789abcdef0123456789abcdef/)
  assert.match(s.stderr, /model_ratio x 1000000 \/ quota_per_unit 500000 = model_ratio x \$2 per 1M tokens; quota_per_unit from --quota-per-unit/)
})

test('E1 rule: USD per 1M tokens = model_ratio x $2; output x completion_ratio; cacheRead x cache_ratio; exact decimals', () => {
  const r = conv()
  assert.deepEqual(byId(r, 'vendor-a-chat-3.2').prices, [{ currency: 'USD', unit: '1M tokens', input: '0.11428', output: '0.14285', cacheRead: '0.028571' }])
  // 0.142855 x 2 = 0.28571 exactly (a float would give 0.28571000000000004). / 浮点会算出 0.28571000000000004。
  assert.deepEqual(byId(r, 'vendor-a-flash-4').prices[0], { currency: 'USD', unit: '1M tokens', input: '0.28571', output: '0.14285', cacheRead: '0.0028571' })
  // No cache_ratio: no cacheRead. / 没有 cache_ratio：没有 cacheRead。
  assert.deepEqual(byId(r, 'model-c-2.5').prices[0], { currency: 'USD', unit: '1M tokens', input: '1.2', output: '0.3' })
  // Rounded half up to 8 decimals. / 四舍五入到 8 位。
  assert.equal(byId(r, 'Model-E-K3').prices[0].cacheRead, '0.28571')   // 2.85714 x 0.099998599999 = 0.28570999...: rounded
  assert.equal(fmt(dec('0.123456785')), '0.12345679'); assert.equal(fmt(dec('1e-9')), '0'); assert.equal(fmt(dec(2.5e-7)), '0.00000025')
  assert.equal(dec('abc'), null); assert.equal(dec(NaN), null)
  // The table is what the sidecar accepts: TAPI-20 §3.9 and the openai-chat endpoint. / 旁路接受这张表。
  assert.ok(Array.isArray(readModels(GOLDEN, 'https://api.example.com', selectFormats('openai-chat'))))
  ai.validateAIField({ endpoints: [{ format: 'openai-chat', baseUrl: 'https://api.example.com/v1' }], models: r.models })
  // Currency USD only (display); the rate never changes the USD figures. / 只有 USD（展示）；汇率不改变美元数。
  assert.ok(r.models.every((m) => m.prices.length === 1 && m.prices[0].currency === 'USD'))
  assert.deepEqual(conv(sample(), { usdExchangeRate: '7.3' }).models, r.models)
})

test('E1 rule: a model with a billing_mode is priced by its billing_expr, read (never evaluated) and refused; its model_ratio is never used', () => {
  const r = conv()
  for (const [id, tiers] of [['vendor-b/model-b-tiered-1', 3], ['vendor-b/model-b-tiered-2', 3], ['vendor-b/model-b-tiered-3', 2]]) {
    const x = refusal(r, id)
    assert.equal(x.code, 'tiered', id)
    assert.match(x.en, new RegExp(`priced by its billing_expr in ${tiers} tier\\(s\\)`))
    assert.match(x.en, /model_ratio 37\.5 is a placeholder, not used/)
    assert.match(x.zh, /分档价格不是一个每百万 token 单价/)
    assert.equal(byId(r, id), undefined)
  }
  assert.match(refusal(r, 'vendor-b/model-b-tiered-1').en, /base \[len <= 32000\]: p x 0\.357143 \+ c x 1\.428571; 第2档 \[len <= 128000\]: p x 0\.571429 \+ c x 2\.285714; 第3档 \[otherwise\]: p x 1 \+ c x 4/)
  // 37.5 x 2 = 75 appears nowhere in the table. / 表里没有 75。
  assert.ok(!JSON.stringify(r.models).includes('"75"'))
  // Any other billing_mode is refused as unknown, even with a flat expression; the ratio is not used.
  // 其它 billing_mode 一律按不认识拒绝，即使表达式只有一档；不使用倍率。
  const odd = conv(withModels(model({ model_name: 'flat-expr', billing_mode: 'expr', billing_expr: 'tier("base", p * 0.5 + c * 1)', model_ratio: 1 })))
  assert.equal(refusal(odd, 'flat-expr').code, 'billing-mode'); assert.match(refusal(odd, 'flat-expr').en, /billing_mode "expr" is not one this converter knows \(base \[otherwise\]: p x 0\.5 \+ c x 1\)/)
  // The reader is a pattern, not an evaluator: anything else is "unreadable" and still refused. / 只按模式读，读不出也拒绝。
  assert.equal(readBillingExpr('process.exit(1)'), null)
  const evil = conv(withModels(model({ model_name: 'evil', billing_mode: 'tiered_expr', billing_expr: 'globalThis.x = 1' })))
  assert.equal(refusal(evil, 'evil').code, 'tiered'); assert.match(refusal(evil, 'evil').en, /in unreadable tier\(s\)/); assert.equal(globalThis.x, undefined)
})

test('E1 rule / FIXED P-2: model_ratio 37.5 without a billing_mode is ambiguous and refused; with a billing_mode it is the tiered placeholder', () => {
  const r = conv(withModels(model({ model_name: 'no-price-set', model_ratio: 37.5, completion_ratio: 1 }), model({ model_name: 'as-string', model_ratio: '37.50' })))
  assert.equal(refusal(r, 'no-price-set').code, 'ratio-37.5-ambiguous')
  assert.match(refusal(r, 'no-price-set').en, /model_ratio 37\.5 without a billing_mode is new-api's placeholder for a model with no price set, or a real price of 37\.5; \/api\/pricing cannot tell them apart, so it is not converted; --accept-ratio-37\.5 "no-price-set" publishes it/)
  assert.match(refusal(r, 'no-price-set').zh, /无法区分，因此不转换/)
  assert.equal(refusal(r, 'as-string').code, 'ratio-37.5-ambiguous')
  assert.equal(refusal(r, 'vendor-b/model-b-tiered-1').code, 'tiered')
  // 37.4 is a price. / 37.4 是价格。
  assert.equal(byId(conv(withModels(model({ model_name: 'm37', model_ratio: 37.4 }))), 'm37').prices[0].input, '74.8')
})

test('E1 rule: video models are refused by name (resolution suffix, video, t2v, i2v) or by --video; --exclude refuses any model', () => {
  const r = conv()
  for (const id of ['media-gen-2-0-480p', 'media-gen-2-0-720p', 'media-gen-2-0-1080p']) {
    assert.equal(refusal(r, id).code, 'video', id)
    assert.match(refusal(r, id).en, /a video model by its name: TAPI-20 §3\.9 prices text formats only/)
  }
  const more = conv(withModels(model({ model_name: 'clip-video-1' }), model({ model_name: 'x-t2v' }), model({ model_name: 'long-ctx-8k' }), model({ model_name: 'mystery-clip' })), { video: ['mystery-clip'], exclude: ['Model-D-5.2'] })
  assert.equal(refusal(more, 'clip-video-1').code, 'video'); assert.equal(refusal(more, 'x-t2v').code, 'video')
  assert.ok(byId(more, 'long-ctx-8k'), 'a context size is not a resolution')
  assert.match(refusal(more, 'mystery-clip').en, /\(--video\)/)
  assert.equal(refusal(more, 'Model-D-5.2').code, 'excluded')
})

test('E1 rule: the exchange rate is read from usd_exchange_rate and must be confirmed; there is no default', () => {
  assert.throws(() => convertPricing(sample(), {}), (e) => e instanceof UsageError && /must be confirmed: pass --usd-exchange-rate/.test(e.message))
  const status = { success: true, data: { usd_exchange_rate: 7, price: 7.3 } }
  assert.throws(() => convertPricing(sample(), { status }), /your \/api\/status says usd_exchange_rate 7; run again with --usd-exchange-rate 7/)
  assert.throws(() => convertPricing(sample(), { status, usdExchangeRate: '7.3' }), /differs from usd_exchange_rate 7/)
  assert.throws(() => convertPricing(sample(), { status: { data: {} }, usdExchangeRate: '7' }), /has no usd_exchange_rate/)
  assert.throws(() => convertPricing(sample(), { usdExchangeRate: '0' }), /must be a positive number/)
  const ok = convertPricing(sample(), { status, usdExchangeRate: '7.0', quotaPerUnit: '500000' })
  assert.equal(ok.meta.usd_exchange_rate, '7')
  // The top-up price (price) differs: recorded, because users pay that per quota dollar. / 充值价不同：记录下来。
  assert.match(ok.meta.note, /price \(the top-up price\) 7\.3 per quota dollar, not 7/)
  // The report shows the CNY figure new-api's page derives at the confirmed rate. / 报告按确认的汇率给出人民币数。
  assert.match(ok.review.find((x) => x.id === 'vendor-a-chat-3.2' && x.code === 'cny-shown').zh, /输入 0\.8 \/ 输出 1 元/)
  // The command: exit 2 without the rate, naming the option. / 命令行：不给汇率退出码 2 并点名该选项。
  const r = cli([FIXTURE])
  assert.equal(r.status, 2); assert.match(r.stderr, /--usd-exchange-rate/); assert.equal(r.stdout, '')
  const st = file('status.json', { ...status, data: { ...status.data, quota_per_unit: 500000 } })
  assert.match(cli([FIXTURE, '--status', st]).stderr, /--usd-exchange-rate 7 \(there is no default\)/)
  assert.equal(cli([FIXTURE, '--status', st, '--usd-exchange-rate', '7']).status, 0)
})

test('E1 rule: completion_ratio < 1 is flagged "the output price is below the input price, the operator confirms" (4 in the sample)', () => {
  const r = conv()
  const flagged = r.review.filter((x) => x.code === 'output-below-input')
  assert.deepEqual(flagged.map((x) => x.id), ['vendor-a-flash-4', 'vendor-b/model-b-max-3.7', 'vendor-c/model-c-3', 'model-c-2.5'])
  for (const x of flagged) { assert.match(x.zh, /输出价低于输入价，请服务方确认/); assert.match(x.en, /the output price is below the input price; the operator confirms it/) }
  // Still converted (a flag, not a refusal); listed in the source record too. / 仍会转换（只是标出）；也记在来源记录里。
  assert.ok(flagged.every((x) => byId(r, x.id)))
  assert.deepEqual(r.meta.review.filter((x) => x.code === 'output-below-input').map((x) => x.id), flagged.map((x) => x.id))
  // No vendor_id: flagged too. / 没有 vendor_id 也标出。
  assert.deepEqual(r.review.filter((x) => x.code === 'vendor-undeclared').map((x) => x.id), ['vendor-c/model-c-3', 'model-c-2.5'])
  const s = cli([FIXTURE, '--usd-exchange-rate', '7', ...Q])
  assert.match(s.stderr, /REVIEW vendor-a-flash-4: completion_ratio 0\.499982499737 < 1/)
})

test('E1 rule: model ids are the API names code unit for code unit, in the API order; a name TAPI-20 refuses is refused', () => {
  const astral = '\u{1D52A}'   // 2 UTF-16 code units / 2 个 UTF-16 码元
  const names = [' Spaced Model ', '模型-α', `${astral}odel`, 'MiXeD/Case.Name-1', 'a'.repeat(256), astral.repeat(128), 'b'.repeat(257), astral.repeat(128) + 'x', 'bad\u0007bell']
  const r = conv({ ...sample(), data: names.map((n) => model({ model_name: n })) })
  assert.deepEqual(r.models.map((m) => m.id), names.slice(0, 6), 'exact names, original order, 256 UTF-16 code units at most')
  for (const n of names.slice(6)) assert.equal(refusal(r, n).code, 'bad-name', JSON.stringify(n.slice(0, 20)))
  // A name twice: both refused (the table cannot hold the same id twice). / 重名：两个都拒绝。
  const dup = conv(withModels(model({ model_name: 'twice' }), model({ model_name: 'twice', model_ratio: 2 })))
  assert.equal(dup.refused.filter((x) => x.id === 'twice' && x.code === 'duplicate').length, 2)
  // Model names in the golden table equal the fixture's model_name byte for byte. / 黄金表的名字与夹具逐字节相同。
  const fixtureNames = new Set(sample().data.map((m) => m.model_name))
  assert.ok(JSON.parse(readFileSync(GOLDEN, 'utf8')).every((m) => fixtureNames.has(m.id)))
})

test('E1 rule: per-request prices, other endpoint types and group ratios that differ are refused; one shared group ratio is applied', () => {
  const p = sample()
  p.group_ratio = { '1x': 1, vip: 1.5, half: 0.5 }
  p.usable_group = { ...p.usable_group, nope: 'a group the site lists with no ratio' }
  p.data.push(
    model({ model_name: 'per-call', quota_type: 1, model_price: 0.02 }),
    model({ model_name: 'anthropic-only', supported_endpoint_types: ['anthropic'] }),
    model({ model_name: 'two-groups', enable_groups: ['1x', 'vip'] }),
    model({ model_name: 'vip-only', enable_groups: ['vip'] }),
    model({ model_name: 'ghost-group', enable_groups: ['nope'] }),
    model({ model_name: 'negative', model_ratio: -1 }),
  )
  const r = conv(p)
  assert.equal(refusal(r, 'per-call').code, 'per-request')
  assert.equal(refusal(r, 'anthropic-only').code, 'endpoint-type')
  assert.match(refusal(r, 'two-groups').en, /have different group ratios \(1, 1\.5\)/)
  assert.match(refusal(r, 'ghost-group').en, /include one with no group_ratio/)
  assert.equal(refusal(r, 'negative').code, 'bad-number')
  assert.deepEqual(byId(r, 'vip-only').prices[0], { currency: 'USD', unit: '1M tokens', input: '3', output: '6' })
  assert.ok(r.review.some((x) => x.id === 'vip-only' && x.code === 'group-ratio-applied'))
  // Not a pricing answer at all: exit 2. / 根本不是价目回答：退出码 2。
  assert.throws(() => conv({ success: true }), /no "data" array/)
  assert.equal(cli([file('empty.json', '')]).status, 2)
  assert.equal(cli([file('nope.json', '{"data":[]}'), '--usd-exchange-rate', '7']).status, 2)
})

test('E1 --check: no drift exits 0; a changed model_ratio and a new model each exit 1; a changed pricing_version alone is a note (FIXED P-4)', () => {
  const pub = GOLDEN, meta = GOLDEN_META
  const check = (pricing, extra = []) => cli(['--check', file(`p-${Math.random()}.json`, pricing), '--models', pub, '--meta', meta, ...extra])
  const clean = check(sample())
  assert.equal(clean.status, 0, clean.stderr); assert.match(clean.stderr, /no drift \(content be72154319b9\.\.\., fetched as not stated\)/)
  // The meta file next to the table is found without --meta. / 不传 --meta 时找价目表旁边的来源记录。
  const nextTo = file('m.json', readFileSync(pub, 'utf8')); writeFileSync(join(tmp, 'm.newapi-source.json'), readFileSync(meta))
  assert.equal(cli(['--check', FIXTURE, '--models', nextTo]).status, 0)

  // 1. A price changed on the site, the version unchanged (the case the version alone would miss). / 只改价不改版本。
  const priced = sample(); priced.data.find((m) => m.model_name === 'Model-D-5.3').model_ratio = 0.6
  const a = check(priced)
  assert.equal(a.status, 1); assert.match(a.stderr, /DRIFT price-changed: Model-D-5\.3: the site's price is 1\.2\/4\.20021001 USD, the published one 1\.1428\/4$/m)
  assert.doesNotMatch(a.stderr, /pricing-version/)
  // 2. The top-level pricing_version changed (new-api's build marker, e.g. after an upgrade): a NOTE, exit 0.
  // 顶层 pricing_version 变了（new-api 的构建标记，例如升级之后）：只是备注，退出码 0。
  const versioned = sample(); versioned.pricing_version = 'ffffffffffffffffffffffffffffffff'
  const b = check(versioned)
  assert.equal(b.status, 0, b.stderr); assert.match(b.stderr, /NOTE  build-marker: new-api's build marker \(pricing_version\) changed: 0123456789abcdef0123456789abcdef -> ffffffffffffffffffffffffffffffff; it is a constant of new-api's source, not a price version/)
  assert.doesNotMatch(b.stderr, /DRIFT/)
  const own = sample(); own.data[0].pricing_version = 'f'.repeat(64)
  assert.equal(check(own).status, 0, 'a model\'s own pricing_version is ignored')
  // 3. A model of a vendor named OpenAI (whatever its id), or whose name says claude, appears: a scope signal.
  // 出现厂商名为 OpenAI（不论 id）或名字含 claude 的模型：范围信号。
  for (const extra of [model({ model_name: 'by-vendor-name', vendor_id: 9 }), model({ model_name: 'default-vendor', vendor_id: -1012 }), model({ model_name: 'some-claude-model', vendor_id: 1 })]) {
    const scoped = sample(); scoped.vendors.push({ id: 9, name: 'OpenAI', icon: 'x' }, { id: -1012, name: 'OpenAI', icon: 'x' }); scoped.data.push(extra)
    const c = check(scoped)
    // Exit 1 because the model is new (model-added); its scope signal is a NOTE (FIXED B-4). / 退出 1 是因为新增模型；范围信号只是 NOTE。
    assert.equal(c.status, 1, extra.model_name); assert.match(c.stderr, new RegExp(`NOTE  scope: ${extra.model_name}: scope signal`))
    assert.doesNotMatch(c.stderr, /DRIFT scope/)
    assert.match(c.stderr, new RegExp(`DRIFT model-added: ${extra.model_name}`))
  }
  // The exchange rate drifted (status given). / 汇率变了（给了状态文件）。
  assert.match(check(sample(), ['--status', file('st.json', { data: { usd_exchange_rate: 7.3 } })]).stderr, /DRIFT exchange-rate/)
})

test('E1 --check: a model the operator priced by hand is not drift while the site lists it; a model gone, or refused now, is', () => {
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'))
  const meta = JSON.parse(readFileSync(GOLDEN_META, 'utf8'))
  const hand = [...golden, { id: 'vendor-b/model-b-tiered-1', prices: [{ currency: 'USD', unit: '1M tokens', input: '0.357143', output: '1.428571' }] }]
  assert.deepEqual(checkPricing(sample(), hand, meta).drift, [])
  const gone = sample(); gone.data = gone.data.filter((m) => m.model_name !== 'Model-D-5.2')
  assert.deepEqual(checkPricing(gone, golden, meta).drift.map((d) => `${d.code} ${d.id}`), ['model-gone Model-D-5.2'])
  const tiered = sample(); Object.assign(tiered.data.find((m) => m.model_name === 'Model-D-5.2'), { billing_mode: 'tiered_expr', billing_expr: 'tier("base", p * 1 + c * 2)' })
  assert.deepEqual(checkPricing(tiered, golden, meta).drift.map((d) => `${d.code} ${d.id}`), ['model-refused-now Model-D-5.2'])
  assert.throws(() => checkPricing(sample(), golden, { tool: 'other' }), /not one tapeapi-newapi-prices wrote/)
  assert.equal(TOOL, 'tapeapi-newapi-prices')
  // --check without --models is a usage error. / --check 不带 --models 是用法错误。
  const lines = []
  assert.equal(run(['--check', FIXTURE], { out: () => {}, err: (t) => lines.push(t) }), 2)
  assert.match(lines.join(''), /--check needs --models/)
})

// FIXED P-1: quota_per_unit is a setting of the site, not a constant: read from /api/status, or given explicitly; never
// assumed. / quota_per_unit 是站点的可改选项：从 /api/status 读，或显式给出；绝不假设。
test('FIXED P-1: USD = model_ratio x 1000000 / quota_per_unit, read from the status file or --quota-per-unit; neither is exit 2', () => {
  // Neither: refused, naming both ways and new-api's default. / 两者都没有：拒绝，并说明两种给法与 new-api 的默认值。
  assert.throws(() => convertPricing(sample(), { usdExchangeRate: '7' }), (e) => e instanceof UsageError && /quota_per_unit is needed .* no status file was given: pass --status <GET \/api\/status saved> or --quota-per-unit <your new-api's quota_per_unit> \(new-api's default is 500000; there is no default here\)/.test(e.message))
  assert.throws(() => convertPricing(sample(), { usdExchangeRate: '7', status: { data: { usd_exchange_rate: 7 } } }), /the status file has no data\.quota_per_unit/)
  const r = cli([FIXTURE, '--usd-exchange-rate', '7'])
  assert.equal(r.status, 2); assert.match(r.stderr, /--quota-per-unit/); assert.equal(r.stdout, '')
  // From the status file: the same golden table at the default; recorded with where it came from. / 从状态文件读。
  const fromStatus = convertPricing(sample(), { usdExchangeRate: '7', status: { data: { usd_exchange_rate: 7, quota_per_unit: 500000 } } })
  assert.deepEqual(fromStatus.models, conv().models)
  assert.equal(fromStatus.meta.quota_per_unit, '500000'); assert.equal(fromStatus.meta.quota_per_unit_from, 'GET /api/status data.quota_per_unit')
  assert.match(fromStatus.meta.rule, /model_ratio x 1000000 \/ quota_per_unit \(500000: x 2\)/)
  // Another quota_per_unit changes every figure, exactly, and the report says it differs from new-api's default.
  // 别的 quota_per_unit 精确改变每个数，报告说明它不同于 new-api 的默认值。
  const q = convertPricing(sample(), { usdExchangeRate: '7', status: { data: { usd_exchange_rate: 7, quota_per_unit: 250000 } } })
  assert.deepEqual(byId(q, 'model-c-2.5').prices[0], { currency: 'USD', unit: '1M tokens', input: '2.4', output: '0.6' })
  assert.ok(q.notes.some((n) => n.code === 'quota-per-unit' && /quota_per_unit is 250000, not new-api's default 500000: USD = model_ratio x 4 per 1M tokens here/.test(n.en)))
  // A quota that does not divide 1000000 is still exact to 8 decimals. / 不能整除也精确到 8 位。
  assert.equal(byId(conv(sample(), { quotaPerUnit: '300000' }), 'model-c-2.5').prices[0].input, '2')       // 0.6 x 10/3
  assert.equal(byId(conv(sample(), { quotaPerUnit: '700000' }), 'model-c-2.5').prices[0].input, '0.85714286')
  // Both given must agree; a bad value is refused. / 两者都给须一致；坏值拒绝。
  assert.throws(() => convertPricing(sample(), { usdExchangeRate: '7', quotaPerUnit: '500000', status: { data: { usd_exchange_rate: 7, quota_per_unit: 250000 } } }), /--quota-per-unit 500000 differs from quota_per_unit 250000/)
  assert.throws(() => conv(sample(), { quotaPerUnit: '0' }), /quota_per_unit must be a positive number/)
  // --check: the status file's quota_per_unit is compared with the record. / --check 对照记录里的 quota_per_unit。
  const d = checkPricing(sample(), JSON.parse(readFileSync(GOLDEN, 'utf8')), JSON.parse(readFileSync(GOLDEN_META, 'utf8')), { status: { data: { usd_exchange_rate: 7, quota_per_unit: 250000 } } })
  assert.deepEqual(d.drift.map((x) => x.code), ['quota-per-unit'])
})

test('FIXED P-2: 37.5 is not "unpriced" for a model whose default price it is; others need --accept-ratio-37.5; self-use mode is said', () => {
  const p = withModels(model({ model_name: 'gpt-4.5-preview', model_ratio: 37.5, completion_ratio: 2, vendor_id: 9 }), model({ model_name: 'no-price-set', model_ratio: 37.5 }), model({ model_name: 'checked-37.5', model_ratio: 37.5 }))
  const r = conv(p, { acceptRatio375: ['checked-37.5'] })
  // new-api's default table prices gpt-4.5-preview at 37.5: converted (75 quota dollars at the default), flagged.
  assert.deepEqual(byId(r, 'gpt-4.5-preview').prices[0], { currency: 'USD', unit: '1M tokens', input: '75', output: '150' })
  assert.ok(r.review.some((x) => x.id === 'gpt-4.5-preview' && x.code === 'ratio-37.5-default-price' && /this model's price in new-api's default ratio table/.test(x.en)))
  assert.equal(refusal(r, 'gpt-4.5-preview'), undefined)
  // The list is exactly the default table's 37.5 entries (QuantumNous/new-api main at 63cecab: the alias and its dated
  // snapshot); the snapshot is converted and flagged the same way. / 名单恰为默认表里 37.5 的条目：别名与带日期的快照。
  assert.deepEqual([...DEFAULT_RATIO_37_5], ['gpt-4.5-preview', 'gpt-4.5-preview-2025-02-27'])
  const snap = conv(withModels(model({ model_name: 'gpt-4.5-preview-2025-02-27', model_ratio: 37.5, completion_ratio: 2 }), model({ model_name: 'gpt-4.5-preview-2099-01-01', model_ratio: 37.5 })))
  assert.equal(byId(snap, 'gpt-4.5-preview-2025-02-27').prices[0].input, '75')
  assert.ok(snap.review.some((x) => x.id === 'gpt-4.5-preview-2025-02-27' && x.code === 'ratio-37.5-default-price'))
  // A name that only looks like it is not on the list: refused as ambiguous. / 只是长得像的名字不在名单里：按无法区分拒绝。
  assert.equal(refusal(snap, 'gpt-4.5-preview-2099-01-01').code, 'ratio-37.5-ambiguous')
  // Accepted by name: converted, flagged, and recorded so --check reproduces it. / 点名放行：转换、标出并记录。
  assert.equal(byId(r, 'checked-37.5').prices[0].input, '75')
  assert.ok(r.review.some((x) => x.id === 'checked-37.5' && x.code === 'ratio-37.5-accepted'))
  assert.deepEqual(r.meta.options.accept_ratio_37_5, ['checked-37.5'])
  assert.equal(refusal(r, 'no-price-set').code, 'ratio-37.5-ambiguous')
  // Without --status: the refusal says what self-use mode would mean. / 没有状态文件：说明自用模式意味着什么。
  assert.match(refusal(r, 'no-price-set').en, /If your site runs in self-use mode \(GET \/api\/status self_use_mode_enabled\), new-api serves this model and bills it at ratio 37\.5; pass --status to know/)
  // Self-use mode on: the refusal says this model is served and billed at 37.5 ($75 per 1M at the default). / 自用模式：明确标注。
  const status = { data: { usd_exchange_rate: 7, quota_per_unit: 500000, self_use_mode_enabled: true } }
  const su = convertPricing(p, { usdExchangeRate: '7', status })
  assert.match(refusal(su, 'no-price-set').en, /This site runs in self-use mode \(GET \/api\/status self_use_mode_enabled\): new-api serves this model and bills it at ratio 37\.5 \(75 quota dollars per 1M input tokens\); left out of the table, its calls get receipts with prices: null/)
  assert.match(refusal(su, 'no-price-set').zh, /本站点开启了自用模式/)
  assert.equal(su.meta.self_use_mode_enabled, true)
  // Self-use mode off: no self-use sentence. / 自用模式关闭：不加这句。
  const off = convertPricing(p, { usdExchangeRate: '7', status: { data: { ...status.data, self_use_mode_enabled: false } } })
  assert.doesNotMatch(refusal(off, 'no-price-set').en, /self-use/)
  // The command: --accept-ratio-37.5 is repeatable; --check reproduces the accepted model (no drift). / 命令行与 --check。
  const pf = file('p375.json', p), out = join(tmp, 'm375.json')
  assert.equal(cli([pf, '--usd-exchange-rate', '7', ...Q, '--accept-ratio-37.5', 'checked-37.5', '--out', out]).status, 0)
  const again = cli(['--check', pf, '--models', out])
  assert.doesNotMatch(again.stderr, /DRIFT (price-changed|model-added|model-refused-now)/, again.stderr)
})

test('FIXED P-3: create_cache_ratio is read: cacheWrite = input x create_cache_ratio, a table the sidecar accepts', () => {
  const r = conv(withModels(model({ model_name: 'cached', model_ratio: 1.5, completion_ratio: 5, cache_ratio: 0.1, create_cache_ratio: 1.25 }), model({ model_name: 'bad-write', create_cache_ratio: -1 })))
  assert.deepEqual(byId(r, 'cached').prices[0], { currency: 'USD', unit: '1M tokens', input: '3', output: '15', cacheRead: '0.3', cacheWrite: '3.75' })
  assert.equal(r.meta.converted.find((c) => c.id === 'cached').create_cache_ratio, 1.25)
  assert.equal(refusal(r, 'bad-write').code, 'bad-number')
  ai.validateAIField({ endpoints: [{ format: 'anthropic-messages', baseUrl: 'https://api.example.com' }], models: r.models })
  // No create_cache_ratio: no cacheWrite (the golden table is unchanged). / 没有该字段：没有 cacheWrite。
  assert.ok(conv().models.every((m) => !('cacheWrite' in m.prices[0])))
})

test('FIXED P-4: --check compares a hash of the price content, not pricing_version: an upgrade alone is clean, any price change is drift', () => {
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')), meta = JSON.parse(readFileSync(GOLDEN_META, 'utf8'))
  assert.equal(meta.source.newapi_build_marker, '0123456789abcdef0123456789abcdef'); assert.equal(meta.source.pricing_version, undefined)
  // The build marker changed (new-api upgraded), prices the same: a note, ok. / 只有构建标记变了：备注，通过。
  const upgraded = sample(); upgraded.pricing_version = 'a'.repeat(32)
  const u = checkPricing(upgraded, golden, meta)
  assert.equal(u.ok, true); assert.deepEqual(u.notes.map((n) => n.code), ['build-marker'])
  // What does not touch prices does not change the hash: order, vendors, icons, descriptions, a model's own version.
  // 不涉及价格的变化不改变哈希：顺序、厂商、图标、描述、模型自带的版本。
  const cosmetic = sample(); cosmetic.data.reverse(); cosmetic.vendors[0].name = 'Renamed'; cosmetic.data[0].description = 'new words'; cosmetic.data[1].pricing_version = 'f'.repeat(64)
  assert.equal(pricingContentHash(cosmetic), meta.source.content_sha256)
  assert.equal(checkPricing(cosmetic, golden, meta).ok, true)
  // The same number written another way is the same content. / 同一个数换种写法仍是同一内容。
  const respelled = sample(); respelled.data[0].model_ratio = String(respelled.data[0].model_ratio) + '0'
  assert.equal(pricingContentHash(respelled), meta.source.content_sha256)
  // A price changed where no converted price shows it (a tiered model's expression, priced by hand): drift.
  // 转换出的价格看不出的改价（分档模型的表达式，手工定价）：漂移。
  const tiered = sample(); tiered.data.find((m) => m.billing_mode === 'tiered_expr').billing_expr = 'tier("base", p * 9 + c * 9)'
  const t = checkPricing(tiered, golden, meta)
  assert.equal(t.ok, false); assert.deepEqual(t.drift.map((d) => d.code), ['content-changed'])
  assert.match(t.drift[0].en, /the price list's content changed since the table was made \(content hash be72154319b9\.\.\. -> [0-9a-f]{12}\.\.\.\), though no converted price differs/)
  // A group ratio changed: drift too. / 分组倍率变了：同样是漂移。
  const grouped = sample(); grouped.group_ratio.vip = 2
  assert.equal(checkPricing(grouped, golden, meta).ok, false)
  // A record without the content hash (an older version wrote it) is refused, not trusted. / 没有内容哈希的记录拒绝。
  assert.throws(() => checkPricing(sample(), golden, { ...meta, source: { pricing_version: 'x' } }), /an older version of this tool wrote it/)
})

test('FIXED P-5: the groups counted are those the answer shows (usable_group); who fetched it is recorded and shown', () => {
  // An anonymous answer: vip is not usable for an anonymous visitor, so it has no ratio here; not "missing".
  // 匿名回答：匿名访客不可用 vip 分组，所以这里没有它的倍率；不算缺失。
  const anon = sample(); anon.usable_group = { '1x': 'default group' }; anon.group_ratio = { '1x': 1 }
  anon.data.push(model({ model_name: 'two-groups', enable_groups: ['1x', 'vip'] }), model({ model_name: 'vip-only', enable_groups: ['vip'] }))
  const r = conv(anon, { fetchedAs: 'anonymous' })
  assert.deepEqual(byId(r, 'two-groups').prices[0], { currency: 'USD', unit: '1M tokens', input: '2', output: '4' })
  const f = r.review.find((x) => x.id === 'two-groups' && x.code === 'groups-not-visible')
  assert.match(f.en, /also enabled for vip, which this answer shows no price for \(fetched anonymously\): the published price is the one of 1x; users of the other groups may pay another ratio/)
  assert.equal(refusal(r, 'vip-only').code, 'no-visible-group')
  assert.match(refusal(r, 'vip-only').en, /enabled only for groups this answer shows no prices for \(vip; usable_group lists 1x\): fetched anonymously/)
  assert.equal(refusal(r, 'two-groups'), undefined, 'not refused as missing')
  assert.equal(r.meta.source.fetched_as, 'anonymous'); assert.deepEqual(r.meta.source.usable_group, ['1x']); assert.deepEqual(r.meta.source.auto_groups, ['1x'])
  assert.deepEqual(r.notes.map((n) => n.code), ['fetched-as']); assert.match(r.notes[0].en, /fetched as: anonymous \(stated\)/)
  // Logged in: the note says to use an ordinary user, never an administrator. / 登录：提示用普通用户，绝不用管理员。
  assert.match(conv(sample(), { fetchedAs: 'user' }).notes[0].en, /fetched as: a logged-in user \(stated\): group_ratio is that user's group's.*never an administrator/)
  assert.match(conv().notes[0].en, /fetched as: not stated \(--fetched-as anonymous\|user\)/)
  assert.equal(conv().meta.source.fetched_as, null)
  assert.throws(() => conv(sample(), { fetchedAs: 'admin' }), /--fetched-as must be anonymous or user/)
  // The command prints it; --check refuses to compare answers fetched by different callers. / 命令行显示；--check 拒绝混比。
  const out = join(tmp, 'anon.json'), pf = file('anon-pricing.json', anon)
  const c = cli([pf, '--usd-exchange-rate', '7', ...Q, '--fetched-as', 'anonymous', '--out', out])
  assert.equal(c.status, 0, c.stderr); assert.match(c.stderr, /fetched as anonymous/); assert.match(c.stderr, /NOTE {3}fetched-as: fetched as: anonymous/)
  assert.equal(cli(['--check', pf, '--models', out, '--fetched-as', 'anonymous']).status, 0)
  const mixed = cli(['--check', pf, '--models', out, '--fetched-as', 'user'])
  assert.equal(mixed.status, 1); assert.match(mixed.stderr, /DRIFT fetched-as: the table was made from an answer fetched as anonymous, this one as user/)
})

test('FIXED P-8: the scope signal is worded as the operator\'s decision, with no promise of a check by anyone else', () => {
  const r = conv(withModels(model({ model_name: 'some-gpt-model', vendor_id: 1 })))
  const s = r.review.find((x) => x.id === 'some-gpt-model' && x.code === 'scope')
  assert.match(s.en, /whether this model may be resold is for the operator to decide, this tool only points it out \(--check shows it as a NOTE, exit status 0 for it\)/)
  assert.match(s.zh, /是否可以转售此类模型由服务方自行确认，本工具只做提示（--check 以 NOTE 显示，不因它退出 1）/)
  assert.doesNotMatch(s.en + s.zh, /maintainer|written permission|维护者|书面授权/)
})

test('FIXED A-1: the scope signal goes by vendor and model names, never by vendor id (new-api\'s ids are arbitrary)', () => {
  // new-api main (ef60ef2, model/pricing_default.go): the default vendors carry negative display ids (OpenAI -1012,
  // Anthropic -1002, Google -1006) and a database vendor any id; ids 3, 4 and 5 mean nothing in particular.
  // new-api 默认厂商用负数展示 id，数据库里的厂商 id 任意；3、4、5 没有任何特定含义。
  const p = sample()
  p.vendors.push({ id: 3, name: 'DeepSeek', icon: 'x' }, { id: 4, name: 'Moonshot', icon: 'x' }, { id: 5, name: 'Vendor 5', icon: 'x' }, { id: 17, name: 'anthropic', icon: 'x' }, { id: -1006, name: 'Google', icon: 'x' })
  p.data.push(model({ model_name: 'deepseek-x', vendor_id: 3 }), model({ model_name: 'kimi-x', vendor_id: 4 }), model({ model_name: 'plain-x', vendor_id: 5 }),
    model({ model_name: 'by-name-any-case', vendor_id: 17 }), model({ model_name: 'by-default-display-id', vendor_id: -1006 }), model({ model_name: 'some-gemini-x', vendor_id: 3 }))
  const scoped = conv(p).review.filter((x) => x.code === 'scope').map((x) => x.id)
  assert.deepEqual(scoped, ['by-name-any-case', 'by-default-display-id', 'some-gemini-x'])
  // The fixture's own vendors (ids 1, 2, 6, 8, placeholder names) give no scope signal. / 夹具自己的厂商不产生范围信号。
  assert.deepEqual(conv().review.filter((x) => x.code === 'scope'), [])
})

test('FIXED B-4: --check shows a scope signal as a NOTE and exits 0 for it; a real price change still exits 1', () => {
  // A table that already publishes a gpt-named model (a relay that resells one), made by the converter itself.
  // 已经发布了一个名字含 gpt 的模型的价目表（转售这类模型的中转站），由转换器自己生成。
  const p = withModels(model({ model_name: 'some-gpt-model', vendor_id: 1, model_ratio: 1.5 }))
  const pf = file('scope-pricing.json', p), out = join(tmp, 'scope-models.json')
  assert.equal(cli([pf, '--usd-exchange-rate', '7', ...Q, '--out', out]).status, 0)
  // 1. Nothing changed: exit 0, the scope signal as a NOTE, no DRIFT. / 什么都没变：退出 0，范围信号是 NOTE，没有 DRIFT。
  const same = cli(['--check', pf, '--models', out])
  assert.equal(same.status, 0, same.stderr)
  assert.match(same.stderr, /^NOTE {2}scope: some-gpt-model: scope signal: vendor 1 \(Vendor 1\)/m)
  assert.doesNotMatch(same.stderr, /DRIFT/)
  assert.match(same.stderr, /no drift/)
  // 2. The scope model's own price changed: price-changed, exit 1. / 该模型自己改价：price-changed，退出 1。
  const repriced = structuredClone(p); repriced.data.find((m) => m.model_name === 'some-gpt-model').model_ratio = 2
  const a = cli(['--check', file('scope-repriced.json', repriced), '--models', out])
  assert.equal(a.status, 1); assert.match(a.stderr, /DRIFT price-changed: some-gpt-model/)
  // 3. Only a refused model's price changed (no converted price differs): content-changed, exit 1.
  // 只有被拒绝的模型改了价（转换结果不变）：content-changed，退出 1。
  const tiered = structuredClone(p); tiered.data.find((m) => m.model_name === 'vendor-b/model-b-tiered-1').billing_expr = 'tier("base", p * 9 + c * 9)'
  const b = cli(['--check', file('scope-tiered.json', tiered), '--models', out])
  assert.equal(b.status, 1); assert.match(b.stderr, /^DRIFT content-changed: the price list's content changed/m)
  assert.match(b.stderr, /NOTE {2}scope: some-gpt-model/)
})
