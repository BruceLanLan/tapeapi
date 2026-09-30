// Spec-vs-code disagreements found by the spec review (SD-n), provider side. Each test failed before its fix.
// 规范审查发现的规范与代码不一致（SD-n），提供者侧。每条测试在修复前都失败。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createProvider } from '../src/index.js'
import { sig, TapeAPIError } from '@tapeapi/sdk'
import { createFakeChain, ADDR } from '../../sdk/test/helpers/fake-chain.mjs'

const { privateKeyToAddress, signDigest, delegationDigest, recoverResponseSigner } = sig
const SIGNER_KEY = '0x' + '22'.repeat(32), HOLDER_KEY = '0x' + '11'.repeat(32)
const signer = privateKeyToAddress(SIGNER_KEY)
const nowS = () => Math.floor(Date.now() / 1000)

function setup(methods) {
  const chain = createFakeChain()
  const expires = nowS() + 300 * 86400
  const manifest = {
    tapeapi: '0.1', name: 'T', circuits: ADDR.circuits, tokenId: '4246', container: ADDR.container, signer,
    delegation: { expires, sig: signDigest(delegationDigest(56, ADDR.hub, { container: ADDR.container, signer, expires }), HOLDER_KEY) },
    endpoints: { live: ['http://127.0.0.1/tapeapi/v1'], async: false },
    methods: Object.keys(methods).map((name) => ({ name, priceBEM: '0', params: {}, returns: {} })),
  }
  return createProvider({
    manifest, signerKey: SIGNER_KEY, rpcUrls: ['http://rpc1', 'http://rpc2'], quorum: 2, chainId: 56,
    fetch: chain.fetch, allowHttp: true, log: () => {}, rateLimit: false, methods,
  })
}
const post = (p, method, body) => p.handleRequest(new Request(`http://x/tapeapi/v1/${method}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
}), { clientIp: '198.51.100.1' })
// What a client written from TAPI-21 §3.3 computes: its own (id, method, params). / 按规范实现的客户端所计算的绑定。
const verifiesUnder = (env, id, method, params) => {
  try { return recoverResponseSigner({ container: ADDR.container, id, method, params, ok: env.ok, body: env.ok ? env.result : env.error, ts: env.ts }, env.sig).toLowerCase() === signer.toLowerCase() }
  catch { return false }
}

test('FIXED SD-1: a request with no id is refused signed over ("", {}), not over the params sent beside it', async () => {
  const p = setup({ m: async () => 1 })
  const res = await post(p, 'm', { params: { a: 1 } })
  const env = await res.json()
  assert.equal(res.status, 400)
  assert.equal(env.error.code, 'BAD_REQUEST')
  assert.equal(env.id, '')
  assert.ok(verifiesUnder(env, '', 'm', {}), 'TAPI-21 §3.2: an invalid id binds to id "" and params {}')
})

test('FIXED SD-1: an over-long id (129 UTF-16 units) is an invalid id: refused signed over ("", {})', async () => {
  const p = setup({ m: async () => 1 })
  const long = 'x'.repeat(129)
  const env = await (await post(p, 'm', { id: long, params: { a: 1 } })).json()
  assert.equal(env.error.code, 'BAD_REQUEST')
  assert.equal(env.id, '', 'an id the provider refused is not echoed')
  assert.ok(verifiesUnder(env, '', 'm', {}))
  // 128 is still valid and echoed / 128 仍然有效并被回显
  const ok = await (await post(p, 'm', { id: 'y'.repeat(128), params: {} })).json()
  assert.equal(ok.ok, true)
  assert.ok(verifiesUnder(ok, 'y'.repeat(128), 'm', {}))
})

test('FIXED SD-1: an INTERNAL from a provider crash is signed over the request\'s own (id, params)', async () => {
  // A handler error whose data has no canonical form makes signing the error itself throw: the crash path answers.
  // 处理器错误的 data 没有规范形式，使签名错误本身抛出：由崩溃路径作答。
  const p = setup({ m: async () => { throw new TapeAPIError('BAD_REQUEST', 'bad', { data: { n: NaN } }) } })
  const params = { a: 1, b: 'two' }
  const res = await post(p, 'm', { id: 'crash-1', params })
  const env = await res.json()
  assert.equal(res.status, 500)
  assert.equal(env.error.code, 'INTERNAL')
  assert.equal(env.id, 'crash-1')
  assert.ok(verifiesUnder(env, 'crash-1', 'm', params), 'the client that sent these params can verify the answer')
})
