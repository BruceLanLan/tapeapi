// The new-api package's sidecar entry (server.mjs): environment parsing and setup mode, price-table errors, the client
// address behind a proxy, and one call through to a verified receipt. Network-free (loopback only).
// new-api 一键包的旁路入口：环境变量解析与设置模式、价目表错误、代理后的客户端地址，以及一次调用到回执核验通过。不联网（只用回环地址）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sig, ai } from '@tapeapi/sdk'
import { readConfig, readModels, createSidecar, startSidecar, clientIpOf, REQUIRED } from './server.mjs'
import { throwawayIdentity, startStack, callAndVerify, CALLS, EXAMPLE_MODELS } from './smoke.mjs'

const tmp = mkdtempSync(join(tmpdir(), 'new-api-sidecar-'))
test.after(() => rmSync(tmp, { recursive: true, force: true }))
const file = (name, text) => { const p = join(tmp, name); writeFileSync(p, text); return p }
const complete = (extra = {}) => ({ ...throwawayIdentity(), PUBLIC_URL: 'https://api.example.com', MODELS_FILE: EXAMPLE_MODELS, ...extra })

test('new-api-sidecar: nothing set is setup mode, naming every missing variable and no problem', () => {
  const s = readConfig({})
  assert.equal(s.ok, false)
  assert.equal(s.problem, null)
  assert.equal(s.signer, null)
  assert.deepEqual(s.missing, ['SIGNER_KEY (secret)', ...REQUIRED])
})

test('new-api-sidecar: with only SIGNER_KEY set, setup mode already names the signer (the console reads it)', () => {
  const key = sig.randomPrivateKey()
  const s = readConfig({ SIGNER_KEY: ` ${key}\n`, PUBLIC_URL: 'https://api.example.com' })
  assert.equal(s.ok, false)
  assert.equal(s.signer, sig.privateKeyToAddress(key))
  assert.deepEqual(s.missing, ['CIRCUITS', 'TOKEN_ID', 'CONTAINER', 'DELEGATION_EXPIRES', 'DELEGATION_SIG'])
  // SIGNER_KEY_FILE (a Docker secret) works the same way. / SIGNER_KEY_FILE（Docker secret）效果相同。
  assert.equal(readConfig({ SIGNER_KEY_FILE: file('signer_key', `${key}\n`) }).signer, sig.privateKeyToAddress(key))
  assert.match(readConfig({ SIGNER_KEY_FILE: join(tmp, 'nope') }).problem, /SIGNER_KEY_FILE .* cannot be read/)
})

test('new-api-sidecar: a complete environment is ok, with new-api as the default upstream', () => {
  const s = readConfig(complete())
  assert.equal(s.ok, true, s.problem)
  assert.equal(s.config.upstreamBaseUrl, 'http://new-api:3000/v1')
  assert.equal(s.config.manifestBase.endpoints.live[0], 'https://api.example.com/tapeapi/v1')
  assert.equal(s.config.rateIp, 600)
  assert.equal(s.config.models.length, 5)
})

test('new-api-sidecar: a variable that is set but wrong is one clear sentence', () => {
  const cases = [
    [{ SIGNER_KEY: '0x1234' }, /SIGNER_KEY is not a private key/],
    [{ SIGNER_ADDRESS: '0x' + '00'.repeat(20) }, /SIGNER_ADDRESS .* does not match SIGNER_KEY/],
    [{ PUBLIC_URL: 'http://api.example.com' }, /PUBLIC_URL must be https/],
    [{ PUBLIC_URL: 'api.example.com' }, /PUBLIC_URL must be a URL/],
    [{ PUBLIC_URL: 'https://api.example.com/?x=1' }, /must not carry a query/],
    [{ PUBLIC_URL: 'https://example.com/ai' }, /must be a bare origin/],
    [{ CONTAINER: '0xREPLACE_WITH_CONTAINER_ADDRESS' }, /CONTAINER must be an address/],
    [{ TOKEN_ID: 'REPLACE_WITH_TOKEN_ID' }, /TOKEN_ID must be a whole number/],
    [{ DELEGATION_EXPIRES: '1700000000' }, /the delegation expired .* renew it in step 4/],
    [{ DELEGATION_EXPIRES: 'soon' }, /DELEGATION_EXPIRES must be a Unix time/],
    [{ DELEGATION_SIG: '0xabc' }, /DELEGATION_SIG must be the 65-byte signature/],
    [{ UPSTREAM_BASE_URL: 'new-api:3000' }, /UPSTREAM_BASE_URL must be new-api's \/v1 base/],
    [{ RATE_IP: '-1' }, /RATE_IP must be a whole number/],
    [{ CLIENT_IP_HEADER: 'x real ip' }, /CLIENT_IP_HEADER must be a header name/],
  ]
  for (const [env, re] of cases) {
    const s = readConfig(complete(env))
    assert.equal(s.ok, false, JSON.stringify(env))
    assert.match(s.problem, re, JSON.stringify(env))
  }
  assert.equal(readConfig(complete({ RATE_IP: '0' })).config.rateIp, 0)
  assert.equal(readConfig(complete({ PUBLIC_URL: 'http://127.0.0.1:8080' })).ok, true)   // loopback http: local testing only
})

test('new-api-sidecar: price-table errors name the file and the rule', () => {
  const one = (m) => JSON.stringify([{ id: 'gpt-5-mini', prices: [{ currency: 'USDT', unit: '1M tokens', input: '0.25', output: '2' }], ...m }])
  const cases = [
    [join(tmp, 'missing.json'), /cannot be read \(ENOENT\); copy models.example.json to models.json/],
    [tmp, /cannot be read \(EISDIR\)/],   // what Docker leaves when ./models.json did not exist / ./models.json 不存在时 Docker 留下的目录
    [file('bad.json', '[{ "id": "x", }]'), /is not valid JSON/],
    [file('obj.json', '{ "id": "x" }'), /must hold a JSON array of models/],
    [file('empty.json', '[]'), /must hold a JSON array of models/],
    [file('singular.json', JSON.stringify([{ id: 'x', price: { currency: 'USDT', unit: '1M tokens', input: '1', output: '1' } }])), /price is not a field: use prices/],
    [file('dup.json', JSON.stringify([JSON.parse(one({ aliases: ['a'] }))[0], { id: 'a', prices: [{ currency: 'USDT', unit: '1M tokens', input: '1', output: '1' }] }])), /appears twice in the table/],
    [file('currency.json', one({ prices: [{ currency: 'CNY', unit: '1M tokens', input: '1', output: '1' }] })), /currency must be one of/],
    [file('unit.json', one({ prices: [{ currency: 'USDT', unit: '1K tokens', input: '1', output: '1' }] })), /unit must be "1M tokens"/],
    [file('decimal.json', one({ prices: [{ currency: 'USDT', unit: '1M tokens', input: 0.25, output: '2' }] })), /must be a decimal string/],
    [file('format.json', one({ formats: ['gemini'] })), /formats must list formats among the endpoints/],
  ]
  for (const [path, re] of cases) {
    const got = readModels(path)
    assert.equal(typeof got, 'string', path)
    assert.match(got, re, path)
    assert.ok(got.includes(path), `${got} names ${path}`)
    // The same sentence is setup mode's problem. / 同一句话就是设置模式的 problem。
    assert.equal(readConfig(complete({ MODELS_FILE: path })).problem, got)
  }
  assert.ok(Array.isArray(readModels(EXAMPLE_MODELS)))
})

test('new-api-sidecar: models.example.json is a valid price table in the frozen prices[] shape, with aliases', () => {
  const models = JSON.parse(readFileSync(EXAMPLE_MODELS, 'utf8'))
  const field = ai.validateAIField({ endpoints: ai.FORMATS.map((f) => ({ format: f.name, baseUrl: 'https://api.example.com' + f.baseSuffix })), models })
  assert.ok(field.models.some((m) => m.aliases?.length), 'at least one model has aliases')
  assert.ok(models.every((m) => Array.isArray(m.prices) && m.price === undefined))
})

test('new-api-sidecar: setup mode answers health with the signer and CORS, and AI calls with an OpenAI-shaped 503', async () => {
  const key = sig.randomPrivateKey()
  const s = await startSidecar({ env: { SIGNER_KEY: key }, port: 0, host: '127.0.0.1', quiet: true, localPublicUrl: true })
  try {
    assert.equal(s.state.ok, false)
    const h = await fetch(`${s.url}/tapeapi/v1/health`)
    assert.equal(h.status, 200)
    assert.equal(h.headers.get('access-control-allow-origin'), '*')
    const body = await h.json()
    assert.equal(body.setup, true)
    assert.equal(body.signer, sig.privateKeyToAddress(key))
    assert.ok(body.missing.includes('DELEGATION_SIG'))
    const c = await fetch(`${s.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    assert.equal(c.status, 503)
    assert.equal(c.headers.get(ai.SIDECAR_ERROR_HEADER), '1')
    const e = await c.json()
    assert.equal(e.error.code, 'setup')
    assert.match(e.error.message, /being set up .*missing: CIRCUITS/)
    assert.equal((await fetch(`${s.url}/.well-known/tapeapi.json`)).status, 503)
    assert.equal((await fetch(`${s.url}/tapeapi/v1/health`, { method: 'OPTIONS' })).status, 204)
  } finally { await s.close() }
})

test('new-api-sidecar: a configuration createAIProxy refuses is setup mode with its message, never a crash', () => {
  // A price table far over the manifest size limit. / 远超清单大小上限的价目表。
  const big = Array.from({ length: 256 }, (_, i) => ({ id: `model-${i}-${'x'.repeat(200)}`, prices: ['BEM', 'BNB', 'USDT', 'USDC', 'ETH', 'USD1', 'USD'].map((currency) => ({ currency, unit: '1M tokens', input: '1', output: '2', cacheRead: '0.1', cacheWrite: '1.25', cacheWrite1h: '2', reasoning: '2' })) }))
  const s = createSidecar(complete({ MODELS_FILE: file('big.json', JSON.stringify(big)) }), { log: () => {} })
  assert.equal(s.state.ok, false)
  assert.match(s.state.problem, /over TAPI-20's .* shorten the price table/)
  assert.equal(s.proxy, null)
})

test('new-api-sidecar: the client address comes from the trusted header only when one is configured', () => {
  const req = (headers) => ({ headers, socket: { remoteAddress: '172.18.0.1' } })
  assert.equal(clientIpOf(req({ 'x-real-ip': '203.0.113.9' }), null), '172.18.0.1')
  assert.equal(clientIpOf(req({ 'x-real-ip': '203.0.113.9' }), 'x-real-ip'), '203.0.113.9')
  // A client can prepend to x-forwarded-for; the right-most entry is the one the proxy added. / 客户端能往前加，最右一项才是代理加的。
  assert.equal(clientIpOf(req({ 'x-forwarded-for': '1.2.3.4, 198.51.100.7' }), 'x-forwarded-for'), '198.51.100.7')
  assert.equal(clientIpOf(req({}), 'x-real-ip'), '172.18.0.1')
})

test('new-api-sidecar: one call through the sidecar to a stand-in new-api carries a receipt that verifies', async () => {
  const stack = await startStack()
  try {
    assert.equal(stack.manifest.signer, stack.sidecar.proxy.manifest().signer)
    assert.deepEqual(stack.manifest.ai.endpoints.map((e) => e.format), ai.FORMATS.map((f) => f.name))
    const { res, envelope, verdict } = await callAndVerify({ manifest: stack.manifest, ...CALLS[0] })
    assert.equal(res.status, 200)
    assert.ok(verdict.ok, verdict.problems.join('; '))
    assert.equal(envelope.result.model, 'gpt-5-mini')
    assert.equal(envelope.result.modelMatchedBy, 'response')
    assert.deepEqual(envelope.result.prices.map((p) => p.currency), ['USDT', 'USD'])
    // A tampered answer does not verify. / 被改动的回答核验不过。
    const bad = ai.verifyUsageReceipt({ envelope, manifest: stack.manifest, requestBytes: new TextEncoder().encode(JSON.stringify(CALLS[0].body)), responseBytes: new TextEncoder().encode('{"tampered":true}'), path: CALLS[0].path, status: 200, stream: false })
    assert.equal(bad.ok, false)
  } finally { await stack.close() }
})

test('new-api-sidecar: the smoke script runs as a program and every receipt verifies', async () => {
  const { spawnSync } = await import('node:child_process')
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('smoke.mjs', import.meta.url))], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
})
