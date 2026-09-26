// The provider Worker (api.tapeapi.fun): setup mode until the holder has signed, then a normal signed service.
// 服务 Worker：持有人签名之前是设置模式，之后是正常签名的服务。
import test from 'node:test'
import assert from 'node:assert/strict'
import worker from './worker.js'
import { privateKeyToAddress, signDigest, delegationDigest } from '../../sdk/src/sig.js'
import { ADDR } from '../../sdk/test/helpers/fake-chain.mjs'

const SIGNER_KEY = '0x' + '22'.repeat(32), HOLDER_KEY = '0x' + '11'.repeat(32)
const signer = privateKeyToAddress(SIGNER_KEY)
const get = (path) => new Request(`https://api.tapeapi.fun${path}`)

test('setup mode: without a delegation the Worker answers only its health, naming the signer derived from SIGNER_KEY', async () => {
  const env = { SIGNER_KEY, PUBLIC_URL: 'https://api.tapeapi.fun' }
  const h = await worker.fetch(get('/tapeapi/v1/health'), env)
  assert.equal(h.status, 200)
  assert.equal(h.headers.get('access-control-allow-origin'), '*', 'the console at tapeapi.fun can read it')
  const body = await h.json()
  assert.deepEqual([body.ok, body.setup, body.signer], [false, true, signer])
  assert.deepEqual(body.missing, ['CIRCUITS', 'TOKEN_ID', 'CONTAINER', 'DELEGATION_EXPIRES', 'DELEGATION_SIG'])
  const call = await worker.fetch(new Request('https://api.tapeapi.fun/tapeapi/v1/blockNumber', { method: 'POST', body: '{}' }), env)
  assert.equal(call.status, 503, 'nothing is signed before the holder has authorised the key')
  const none = await (await worker.fetch(get('/tapeapi/v1/health'), {})).json()
  assert.equal(none.signer, null)
  assert.ok(none.missing.includes('SIGNER_KEY (secret)'))
})

test('configured: the manifest names the signer derived from SIGNER_KEY and the delegation, and health is ok', async () => {
  const expires = Math.floor(Date.now() / 1000) + 90 * 86400
  const sig = signDigest(delegationDigest(56, ADDR.hub, { container: ADDR.container, signer, expires }), HOLDER_KEY)
  const env = { SIGNER_KEY, PUBLIC_URL: 'https://api.tapeapi.fun', CIRCUITS: ADDR.circuits, TOKEN_ID: '1', CONTAINER: ADDR.container, DELEGATION_EXPIRES: String(expires), DELEGATION_SIG: sig }
  const m = await (await worker.fetch(get('/.well-known/tapeapi.json'), env)).json()
  assert.equal(m.signer, signer)
  assert.deepEqual(m.delegation, { expires, sig })
  assert.deepEqual(m.endpoints.live, ['https://api.tapeapi.fun/tapeapi/v1'])
  const h = await (await worker.fetch(get('/tapeapi/v1/health'), env)).json()
  assert.equal(h.ok, true)
})

test('a wrong variable is explained in setup mode, never thrown as an error page', async () => {
  const { default: fresh } = await import('./worker.js?bad')   // a fresh module: no provider cached yet / 新模块，无缓存
  const env = { SIGNER_KEY, PUBLIC_URL: 'https://api.tapeapi.fun', CIRCUITS: ADDR.circuits, TOKEN_ID: '1', CONTAINER: ADDR.container, DELEGATION_EXPIRES: '1000', DELEGATION_SIG: '0x1234' }
  const h = await (await fresh.fetch(get('/tapeapi/v1/health'), env)).json()
  assert.deepEqual([h.ok, h.setup, h.signer], [false, true, signer])
  assert.match(h.problem, /delegation|expires|sig/i)
  assert.ok(!JSON.stringify(h).includes(SIGNER_KEY.slice(2)), 'the key is never echoed')
})

test('a key or variable pasted with a trailing newline or spaces still works', async () => {
  const { default: fresh } = await import('./worker.js?trim')
  const h = await (await fresh.fetch(get('/tapeapi/v1/health'), { SIGNER_KEY: `  ${SIGNER_KEY}\n`, PUBLIC_URL: 'https://api.tapeapi.fun ' })).json()
  assert.equal(h.signer, signer)
  assert.ok(!h.missing.includes('SIGNER_KEY (secret)'))
  assert.ok(!h.missing.includes('PUBLIC_URL'))
})

test('the deploy scripts pin an exact wrangler version (Workers Builds runs them; an unpinned npx takes whatever is latest)', async () => {
  const { readFile } = await import('node:fs/promises')
  const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'))
  for (const name of ['deploy:provider', 'deploy:relay']) assert.match(pkg.scripts[name], /npx --yes wrangler@\d+\.\d+\.\d+ deploy -c examples\/cloudflare-worker\/wrangler(-relay)?\.toml$/, name)
})
