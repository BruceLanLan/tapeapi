// H-04：URL 模板不能被参数带出配置的 origin / 路径前缀；上游错误不透传；头部不来自调用方。
// H-04: path parameters can never escape the configured origin / path prefix; upstream errors are not echoed;
// headers never come from the caller.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeHandler, parseTemplate, buildUrl, manifestMethods } from './adapter.mjs'

const seen = []
const fakeFetch = (status = 200, body = { ok: 1, nested: { a: 'b' } }) => async (url, init) => {
  seen.push({ url: String(url), init })
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}
const zone = { url: 'https://worldtimeapi.org/api/timezone/{area}/{location}', method: 'GET', params: { area: 'string', location: 'string' }, required: ['area', 'location'], pick: { a: 'nested.a', missing: 'nope.x' } }
const config = { upstream: { headers: { 'x-api-key': '${UPSTREAM_API_KEY}', accept: 'application/json' } }, methods: { zoneTime: zone } }
const env = { UPSTREAM_API_KEY: 'k-123' }

test('the review payload {area:"..", location:"admin"} is rejected, as is every other escape attempt', async () => {
  const h = makeHandler('zoneTime', zone, { config, fetch: fakeFetch(), env })
  const attempts = [
    { area: '..', location: 'admin' }, { area: '.', location: 'x' }, { area: 'a/b', location: 'x' }, { area: 'a\\b', location: 'x' },
    { area: 'x?y=1', location: 'x' }, { area: 'x#f', location: 'x' }, { area: 'a\nb', location: 'x' }, { area: '..%2f', location: 'x' }, { area: 'a\x7fb', location: 'x' },
    { area: 'Etc', location: '..' }, { area: { toString: () => 'Etc' }, location: 'UTC' }, { area: ['Etc'], location: 'UTC' }, { area: '', location: 'UTC' },
  ]
  for (const p of attempts) {
    await assert.rejects(h(p), (e) => e.code === 'BAD_REQUEST', JSON.stringify(p))
  }
  assert.equal(seen.length, 0) // nothing reached upstream / 没有任何请求到达上游
  // %2e%2e is encoded again, so it stays a literal segment / 已编码的点段被再次编码，不会被归一化
  const r = await h({ area: '%2e%2e', location: 'UTC' })
  assert.equal(seen.pop().url, 'https://worldtimeapi.org/api/timezone/%252e%252e/UTC'); assert.deepEqual(r, { a: 'b', missing: null })
})
test('happy path: values are encodeURIComponent-ed, origin and prefix hold, only config headers are sent', async () => {
  const h = makeHandler('zoneTime', zone, { config, fetch: fakeFetch(), env })
  const r = await h({ area: 'America', location: 'Argentina Buenos_Aires', headers: { 'x-api-key': 'evil' }, extra: 'ignored', __proto__: { x: 1 } })
  const { url, init } = seen.pop()
  assert.equal(url, 'https://worldtimeapi.org/api/timezone/America/Argentina%20Buenos_Aires')
  assert.deepEqual(init.headers, { 'x-api-key': 'k-123', accept: 'application/json' })
  assert.deepEqual(r, { a: 'b', missing: null })
})
test('templates that put {param} in the origin, or lack a full origin, are rejected at startup', () => {
  for (const url of ['https://{sub}.example.com/x', 'https://example.com{p}', '/relative/{p}', 'ftp://x/{p}', 'https://example.com/a?b={p}']) {
    assert.throws(() => parseTemplate(url), (e) => e.code === 'INTERNAL', url)
  }
  const tpl = parseTemplate('https://api.example.com/v1/items/{id}/detail')
  assert.equal(tpl.origin, 'https://api.example.com'); assert.equal(tpl.pathPrefix, '/v1/items/'); assert.deepEqual(tpl.names, ['id'])
  assert.equal(buildUrl(tpl, { id: 'a b' }, { q: 'id' }).href, 'https://api.example.com/v1/items/a%20b/detail?q=a+b')
  assert.throws(() => buildUrl(tpl, { id: '..' }), (e) => e.code === 'BAD_REQUEST')
})
test('query and body values must be primitives; body "*" forwards declared params only; upstream errors are not echoed', async () => {
  const post = { url: 'https://api.example.com/v1/convert', method: 'POST', params: { amount: 'number', to: 'string' }, body: '*' }
  const log = []
  const h = makeHandler('conv', post, { config: {}, fetch: fakeFetch(), env: {}, log: (...a) => log.push(a.join(' ')) })
  await h({ amount: 5, to: 'EUR', admin: true, role: 'root' })
  assert.deepEqual(JSON.parse(seen.pop().init.body), { amount: 5, to: 'EUR' }) // mass-assignment fields dropped / 未声明字段不转发
  const q = { url: 'https://api.example.com/v1/x', method: 'GET', params: { to: 'string' }, query: { to: 'to' } }
  await assert.rejects(makeHandler('q', q, { config: {}, fetch: fakeFetch(), env: {} })({ to: { a: 1 } }), (e) => e.code === 'BAD_REQUEST')
  const h4 = makeHandler('conv', post, { config: {}, fetch: fakeFetch(403, { message: 'key k-123 is not allowed for /v1/internal' }), env: {}, log: (...a) => log.push(a.join(' ')) })
  await assert.rejects(h4({ amount: 1 }), (e) => e.code === 'BAD_REQUEST' && !/k-123/.test(e.message) && /http 403/.test(e.message))
  const h5 = makeHandler('conv', post, { config: {}, fetch: fakeFetch(502, 'gateway https://internal.corp/SECRET'), env: {}, log: (...a) => log.push(a.join(' ')) })
  await assert.rejects(h5({ amount: 1 }), (e) => e.code === 'INTERNAL' && !/SECRET/.test(e.message))
  assert.ok(log.some(l => /k-123/.test(l)) && log.some(l => /SECRET/.test(l))) // operator log keeps the detail / 细节留在日志
})
test('manifestMethods derives params from query/body/url templates', () => {
  const ms = manifestMethods({ methods: { zoneTime: { url: zone.url, priceBEM: '0' }, fx: { url: 'https://x/y', query: { to: 'to' }, priceBEM: '0.0001', params: { to: 'string' } } } })
  assert.deepEqual(ms[0], { name: 'zoneTime', priceBEM: '0', params: { area: 'string', location: 'string' }, returns: {} })
  assert.equal(ms[1].priceBEM, '0.0001')
})

// ---- hosting hardening (docs/DESIGN-hosted.md, "Web2 adapter hardening") / 托管加固 ----
import { buildMethods, checkUpstreamUrl, isPrivateIp, readCapped, expandEnv, HOSTED_POLICY } from './adapter.mjs'

test('FIXED H-HOSTED-1: ${NAME} expands only from the env passed in, never from process.env', async () => {
  process.env.TAPEAPI_TEST_SECRET = 'platform-secret'
  const leaky = { url: 'https://api.example.com/v1/x', headers: { 'x-api-key': '${TAPEAPI_TEST_SECRET}' } }
  // not passed -> refused when the handler is created, before any request / 未传入：创建处理器时即拒绝，任何请求都没发出
  assert.throws(() => makeHandler('x', leaky, { fetch: fakeFetch() }), (e) => e.code === 'INTERNAL' && /TAPEAPI_TEST_SECRET/.test(e.message))
  assert.throws(() => buildMethods({ methods: { x: leaky } }, { fetch: fakeFetch(), env: { UPSTREAM_API_KEY: 'k' } }), (e) => e.code === 'INTERNAL')
  assert.throws(() => expandEnv('${TAPEAPI_TEST_SECRET}'), (e) => e.code === 'INTERNAL')
  // passed but unset -> header dropped, as the example config relies on / 传了键但值未设置：丢弃该头部，示例配置依赖这一点
  const h = makeHandler('x', { url: 'https://api.example.com/v1/x', headers: { 'x-api-key': '${UPSTREAM_API_KEY}' } }, { fetch: fakeFetch(), env: { UPSTREAM_API_KEY: undefined } })
  await h({})
  assert.deepEqual(seen.pop().init.headers, {})
  delete process.env.TAPEAPI_TEST_SECRET
})

test('FIXED H-HOSTED-2: the hosted policy refuses local, platform, IP-literal, non-443, userinfo and plain-http upstreams', () => {
  const refused = ['http://api.example.org/x', 'https://127.0.0.1/x', 'https://0x7f.1/x', 'https://2130706433/x', 'https://0177.0.0.1/x',
    'https://[::1]/x', 'https://[fd00::1]/x', 'https://api.example.org:8443/x', 'https://u:p@api.example.org/x', 'https://localhost/x',
    'https://db.internal/x', 'https://printer.local/x', 'https://metadata/x', 'https://api.tapeapi.fun/x', 'https://tapeapi.fun/x',
    'https://1.0.0.127.in-addr.arpa/x', 'https://api.example.org./x'.replace('org.', 'localhost.')]
  for (const u of refused) assert.throws(() => checkUpstreamUrl(u, HOSTED_POLICY), (e) => e.code === 'INTERNAL', u)
  for (const u of ['https://api.coinbase.com/v2/prices', 'https://api.frankfurter.dev/v1/latest']) assert.equal(checkUpstreamUrl(u, HOSTED_POLICY).href, u)
  // the open (self-hosted) policy keeps http and any host / 自托管策略保留 http 与任意主机
  assert.ok(checkUpstreamUrl('http://127.0.0.1:8080/x'))
  assert.throws(() => checkUpstreamUrl('ftp://x.example.org/'), (e) => e.code === 'INTERNAL')
  // a template is checked when the service is created / 模板在创建服务时即被检查
  assert.throws(() => parseTemplate('https://169.254.169.254/latest/{p}', HOSTED_POLICY), (e) => e.code === 'INTERNAL')
})

test('FIXED H-HOSTED-3: at most 3 upstream hosts, header allow-list and a fixed User-Agent under the hosted policy', async () => {
  const m = (host) => ({ url: `https://${host}/v1/x` })
  assert.throws(() => buildMethods({ methods: { a: m('a.example.org'), b: m('b.example.org'), c: m('c.example.org'), d: m('d.example.org') } }, { policy: HOSTED_POLICY }), /4 upstream hosts/)
  assert.ok(buildMethods({ methods: { a: m('a.example.org'), b: m('b.example.org'), c: m('c.example.org'), a2: m('a.example.org') } }, { policy: HOSTED_POLICY }))
  for (const bad of ['host', 'cookie', 'x-forwarded-for', 'cf-connecting-ip', 'user-agent']) {
    assert.throws(() => makeHandler('x', { url: 'https://a.example.org/x', headers: { [bad]: 'v' } }, { policy: HOSTED_POLICY }), (e) => e.code === 'INTERNAL', bad)
  }
  const h = makeHandler('x', { url: 'https://a.example.org/x', headers: { authorization: 'Bearer ${UPSTREAM_API_KEY}' } }, { fetch: fakeFetch(), env: { UPSTREAM_API_KEY: 'k' }, policy: HOSTED_POLICY })
  await h({})
  const { init } = seen.pop()
  assert.deepEqual(init.headers, { authorization: 'Bearer k', 'user-agent': HOSTED_POLICY.userAgent })
  assert.equal(init.redirect, 'manual')
})

test('FIXED H-HOSTED-4: no redirects, a capped body and no private address behind a public name under the hosted policy', async () => {
  const at = { url: 'https://a.example.org/x' }
  const redirect = async () => new Response('', { status: 302, headers: { location: 'http://169.254.169.254/' } })
  await assert.rejects(makeHandler('x', at, { fetch: redirect, policy: HOSTED_POLICY })({}), (e) => e.code === 'INTERNAL')
  const huge = async () => new Response(new ReadableStream({ start(c) { for (let i = 0; i < 40; i++) c.enqueue(new Uint8Array(8192).fill(32)); c.close() } }))
  await assert.rejects(makeHandler('x', at, { fetch: huge, policy: HOSTED_POLICY })({}), (e) => e.code === 'INTERNAL')   // 320 KiB > 256 KiB
  const said = async () => new Response('{}', { headers: { 'content-length': String(10 * 1024 * 1024) } })
  await assert.rejects(readCapped(await said(), 1024), /exceeds/)
  let fetched = 0
  const counting = async () => { fetched++; return new Response('{"ok":1}') }
  await assert.rejects(makeHandler('x', at, { fetch: counting, policy: HOSTED_POLICY, resolve: async () => ['93.184.216.34', '10.0.0.5'] })({}), (e) => e.code === 'INTERNAL')
  await assert.rejects(makeHandler('x', at, { fetch: counting, policy: HOSTED_POLICY, resolve: async () => [] })({}), (e) => e.code === 'INTERNAL')
  assert.equal(fetched, 0, 'nothing was fetched from a name that resolves privately')
  assert.deepEqual(await makeHandler('x', at, { fetch: counting, policy: HOSTED_POLICY, resolve: async () => ['93.184.216.34'] })({}), { ok: 1 })
  for (const ip of ['10.1.2.3', '127.0.0.1', '169.254.169.254', '172.20.0.1', '192.168.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fd12::1', 'fe80::1', '::ffff:10.0.0.1', 'nonsense']) assert.ok(isPrivateIp(ip), ip)
  for (const ip of ['::7f00:1', '::127.0.0.1', '2002:7f00:1::', '2001:0:4136::1', '100::1', '64:ff9b::a00:1', '2001:db8::1', '::', '1:2:3:4:5:6:7:8:9', 'zz::1', '::ffff:127.0.0.1']) assert.ok(isPrivateIp(ip), ip)
  for (const ip of ['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111', '172.32.0.1', '2a00:1450:4001:80b::200e']) assert.ok(!isPrivateIp(ip), ip)
})
