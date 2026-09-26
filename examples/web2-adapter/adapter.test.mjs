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
