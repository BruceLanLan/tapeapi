// `_lib/service.mjs` 的单测：环境变量全部注入，不读 process.env、不开 socket。
// Unit tests for `_lib/service.mjs`: every environment variable is injected — nothing reads process.env and
// no socket is opened. `startProvider` is not tested here; it is exercised by booting the examples.
import test from 'node:test'
import assert from 'node:assert/strict'
import { sig } from '@tapeapi/sdk'
import { exampleEnv, applyEnvToManifest } from './service.mjs'

const KEY = '0x' + '11'.repeat(32)
const SIG = '0x' + 'ab'.repeat(65)
const base = (extra = {}) => ({ SIGNER_KEY: KEY, ...extra })

const manifest = (methods = [{ name: 'free', priceBEM: '0', params: {}, returns: {} }, { name: 'paid', priceBEM: '0.0001', params: {}, returns: {} }]) => ({
  tapeapi: '0.1', name: 'Example', circuits: '0x' + '0'.repeat(40), tokenId: '0',
  container: '0x' + '0'.repeat(40), signer: '0x' + '0'.repeat(40), delegation: null,
  endpoints: { live: ['http://127.0.0.1:1/tapeapi/v1'], async: false },
  methods, payment: { escrow: '0x' + '0'.repeat(40), unit: 'BEM', decimals: 8 }, dev: true,
})

test('exampleEnv falls back to the example\'s own defaults', () => {
  const e = exampleEnv('x', { port: 8789, env: base() })
  assert.equal(e.PORT, 8789)
  assert.equal(e.CHAIN_ID, 56)
  assert.equal(e.LAG, 15)
  // Loopback by default: binding every interface exposes an unrate-limited free tier to the whole network.
  // 默认只听回环：绑全部网卡等于把没有限流的免费层暴露给整个网络。
  assert.equal(e.HOST, '127.0.0.1')
  assert.equal(exampleEnv('x', { port: 1, env: base({ HOST: '0.0.0.0' }) }).HOST, '0.0.0.0', 'still opt-in')
  assert.equal(e.tag, 'x')
  assert.equal(e.RPC_URLS.length, 3)
  assert.ok(e.RPC_URLS.every((u) => u.startsWith('https://')))
})

test('exampleEnv splits and trims RPC_URLS and drops empty entries', () => {
  const e = exampleEnv('x', { port: 1, env: base({ RPC_URLS: ' https://a.example , ,https://b.example,' }) })
  assert.deepEqual(e.RPC_URLS, ['https://a.example', 'https://b.example'])
})

test('quorum defaults to min(2, urls) so a one-node dev setup is not asked for two answers', () => {
  assert.equal(exampleEnv('x', { port: 1, env: base({ RPC_URLS: 'https://a.example' }) }).QUORUM, 1)
  assert.equal(exampleEnv('x', { port: 1, env: base({ RPC_URLS: 'https://a.example,https://b.example,https://c.example' }) }).QUORUM, 2)
  assert.equal(exampleEnv('x', { port: 1, env: base({ QUORUM: '3' }) }).QUORUM, 3)
})

test('env overrides win over the defaults', () => {
  const e = exampleEnv('x', { port: 8789, env: base({ PORT: '9000', HOST: '127.0.0.1', CHAIN_ID: '97', BLOCK_LAG: '0' }) })
  assert.equal(e.PORT, 9000)
  assert.equal(e.HOST, '127.0.0.1')
  assert.equal(e.CHAIN_ID, 97)
  assert.equal(e.LAG, 0) // BLOCK_LAG=0 必须能关掉滞后 / 0 must be able to switch the lag off
})

test('PROD needs BOTH delegation env vars: half a delegation is still dev', () => {
  assert.equal(exampleEnv('x', { port: 1, env: base() }).PROD, false)
  assert.equal(exampleEnv('x', { port: 1, env: base({ DELEGATION_SIG: SIG }) }).PROD, false)
  assert.equal(exampleEnv('x', { port: 1, env: base({ DELEGATION_EXPIRES: '1890000000' }) }).PROD, false)
  assert.equal(exampleEnv('x', { port: 1, env: base({ DELEGATION_SIG: SIG, DELEGATION_EXPIRES: '1890000000' }) }).PROD, true)
})

test('the signer address is derived from SIGNER_KEY, and the key is never returned in the banner path', () => {
  const e = exampleEnv('x', { port: 1, env: base() })
  assert.equal(e.signer, sig.privateKeyToAddress(KEY))
  assert.equal(e.SIGNER_KEY, KEY)
})

test('without SIGNER_KEY a fresh ephemeral signer is used on every run', () => {
  const a = exampleEnv('x', { port: 1, env: {} })
  const b = exampleEnv('x', { port: 1, env: {} })
  assert.notEqual(a.SIGNER_KEY, b.SIGNER_KEY)
  assert.equal(a.signer, sig.privateKeyToAddress(a.SIGNER_KEY))
})

test('applyEnvToManifest mutates the object it was given (createProvider keeps that reference)', () => {
  const m = manifest()
  const env = exampleEnv('x', { port: 8789, env: base() })
  assert.equal(applyEnvToManifest(m, env), m)
  assert.equal(m.signer, env.signer)
})

test('placeholders are filled from the environment', () => {
  const m = manifest()
  const env = exampleEnv('x', { port: 8789, env: base({
    NAME: 'My Service', CONTAINER: '0x' + '11'.repeat(20), CIRCUITS: '0x' + '22'.repeat(20),
    TOKEN_ID: 7, ESCROW: '0x' + '33'.repeat(20),
  }) })
  applyEnvToManifest(m, env)
  assert.equal(m.name, 'My Service')
  assert.equal(m.container, '0x' + '11'.repeat(20))
  assert.equal(m.circuits, '0x' + '22'.repeat(20))
  assert.equal(m.tokenId, '7')                     // 始终是十进制字符串 / always a decimal string
  assert.equal(m.payment.escrow, '0x' + '33'.repeat(20))
})

test('an unset placeholder leaves the manifest value alone', () => {
  const m = manifest()
  m.container = '0x' + '99'.repeat(20)
  applyEnvToManifest(m, exampleEnv('x', { port: 1, env: base() }))
  assert.equal(m.container, '0x' + '99'.repeat(20))
})

test('no delegation in the environment means a dev manifest', () => {
  const m = manifest()
  applyEnvToManifest(m, exampleEnv('x', { port: 1, env: base() }))
  assert.equal(m.delegation, null)
  assert.equal(m.dev, true)
})

test('a complete delegation in the environment means a live manifest', () => {
  const m = manifest()
  applyEnvToManifest(m, exampleEnv('x', { port: 1, env: base({ DELEGATION_SIG: SIG, DELEGATION_EXPIRES: '1890000000' }) }))
  assert.deepEqual(m.delegation, { expires: 1890000000, sig: SIG })
  assert.equal(m.dev, false)
})

test('the advertised endpoint is the listen port unless PUBLIC_URL says otherwise', () => {
  const m = manifest()
  applyEnvToManifest(m, exampleEnv('x', { port: 8789, env: base() }))
  assert.deepEqual(m.endpoints.live, ['http://127.0.0.1:8789/tapeapi/v1'])

  const m2 = manifest()
  applyEnvToManifest(m2, exampleEnv('x', { port: 8789, env: base({ PUBLIC_URL: 'https://api.example.com///' }) }))
  assert.deepEqual(m2.endpoints.live, ['https://api.example.com/tapeapi/v1']) // 尾部斜杠被剥掉 / trailing slashes stripped
})

test('FREE_ALL=1 zeroes every price, but only on a dev manifest', () => {
  const dev = manifest()
  applyEnvToManifest(dev, exampleEnv('x', { port: 1, env: base({ FREE_ALL: '1' }) }))
  assert.deepEqual(dev.methods.map((x) => x.priceBEM), ['0', '0'])

  // 已经有委托的清单是要上主网的，FREE_ALL 必须无效——否则一个调试开关会让服务白干活。
  // A manifest carrying a delegation is going to mainnet: FREE_ALL must not apply, or a debug switch
  // would silently make the service work for free.
  const live = manifest()
  applyEnvToManifest(live, exampleEnv('x', { port: 1, env: base({ FREE_ALL: '1', DELEGATION_SIG: SIG, DELEGATION_EXPIRES: '1890000000' }) }))
  assert.deepEqual(live.methods.map((x) => x.priceBEM), ['0', '0.0001'])
})

test('FREE_ALL only counts as set when it is exactly "1"', () => {
  const m = manifest()
  applyEnvToManifest(m, exampleEnv('x', { port: 1, env: base({ FREE_ALL: 'true' }) }))
  assert.deepEqual(m.methods.map((x) => x.priceBEM), ['0', '0.0001'])
})
