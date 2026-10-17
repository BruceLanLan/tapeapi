// createVerifyingFetch and a metered path of a format the manifest declares no endpoint for (FIXED F-1), in the two
// set-ups examples/new-api-sidecar/formats.test.mjs does not reach (review 2.1 C-9): custom `formats` adapters, and
// endpoints whose base URL has a path prefix (https://relay.example/team/v1, served under /team). The root is taken per
// endpoint with rootOf/apiPath, so only paths under that prefix, on that origin, count. No network: the fetch is a stub.
// createVerifyingFetch 对“清单未声明端点的格式”的计量路径的判定，补 formats.test.mjs 没覆盖的两种情形：自定义 formats 适配器，与
// base URL 带路径前缀的端点（服务挂在 /team 下）。根按端点用 rootOf/apiPath 求出，只有同源且在该前缀下的路径才算。不联网。
import test from 'node:test'
import assert from 'node:assert/strict'
import * as ai from '../src/ai.js'

const chat = ai.FORMATS.find((f) => f.name === 'openai-chat')
// A custom format of the application's own, served at <root>/acme/chat; it does not stream. / 应用自己的格式，不流式。
const acme = { ...chat, name: 'acme-chat', baseSuffix: '/acme', match: ({ verb, path }) => verb === 'POST' && path === '/acme/chat', stream: null }
const ROOT = 'https://relay.example/team'
const price = [{ currency: 'USD', unit: '1M tokens', input: '1', output: '2' }]
const serviceWith = (endpoints) => ({
  manifest: { ai: { endpoints, models: [{ id: 'model-a', prices: price }] } },
  container: '0x' + '00'.repeat(20), verified: { dev: true },
})
const body = JSON.stringify({ model: 'model-a', messages: [{ role: 'user', content: 'hi' }] })
const post = { method: 'POST', headers: { 'content-type': 'application/json' }, body }

test('FIXED C-9: custom formats and a base URL with a path prefix: an undeclared format under the prefix is refused before sending (strict)', async () => {
  // The manifest declares openai-chat only, under the /team prefix; the application passes its own formats list,
  // which leaves out every built-in but openai-chat and adds acme-chat (not declared either).
  // 清单只在 /team 前缀下声明 openai-chat；应用传入自己的 formats，除 openai-chat 外不含内置格式，另加 acme-chat（也未声明）。
  const service = serviceWith([{ format: 'openai-chat', baseUrl: `${ROOT}/v1` }])
  const sent = []
  const stub = async (u) => { sent.push(String(u)); return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }) }
  const strict = ai.createVerifyingFetch({ service, fetch: stub, formats: [chat, acme], onReport: () => assert.fail('no report in strict mode') })
  for (const [url, format] of [
    [`${ROOT}/v1/messages`, 'anthropic-messages'],      // a built-in left out of `formats`: still recognised / formats 里没有的内置格式仍被认出
    [`${ROOT}/v1/responses`, 'openai-responses'],
    [`${ROOT}/v1//messages`, 'anthropic-messages'],     // written loosely / 宽松写法
    [`${ROOT}/acme/chat`, 'acme-chat'],                 // the custom format, not declared / 未声明的自定义格式
  ]) {
    await assert.rejects(strict(url, post), (e) => {
      assert.equal(e.code, 'INVALID_ARGUMENT', url)
      assert.match(e.message, new RegExp(`is a metered ${format} call, but the service's manifest declares no ${format} endpoint \\(it declares openai-chat\\)`))
      assert.deepEqual(e.data, { format, declared: ['openai-chat'] })
      return true
    })
  }
  assert.deepEqual(sent, [], 'nothing was sent')
  // Outside the prefix, on another origin, or an unmetered path: not this service's undeclared format; passed on.
  // 前缀之外、别的源、或非计量路径：不算本服务未声明的格式，照常发出。
  for (const url of ['https://relay.example/v1/messages', 'https://other.example/team/v1/messages', `${ROOT}/v1/models`]) {
    const r = await strict(url, url.endsWith('/models') ? {} : post)
    assert.equal(r.status, 200, url)
  }
  assert.deepEqual(sent, ['https://relay.example/v1/messages', 'https://other.example/team/v1/messages', `${ROOT}/v1/models`])
})

test('FIXED C-9: with the custom format declared under its own prefix, it is not refused; not strict, an undeclared one is sent and reported', async () => {
  const service = serviceWith([{ format: 'openai-chat', baseUrl: `${ROOT}/v1` }, { format: 'acme-chat', baseUrl: `${ROOT}/acme` }])
  const sent = [], reports = []
  const stub = async (u) => { sent.push(String(u)); return new Response('{"error":"refused"}', { status: 400, headers: { 'content-type': 'application/json' } }) }
  const strict = ai.createVerifyingFetch({ service, fetch: stub, formats: [chat, acme], onReport: (r) => reports.push(r) })
  // Declared now: a metered acme-chat call is sent and checked as usual (the stub answers without a receipt, so strict
  // answers its HTTP 502 RECEIPT_INVALID: sent, then not verified, rather than refused before sending).
  // 已声明：acme-chat 的计量调用照常发出并核验（桩的回答没有回执，strict 因此回 502 RECEIPT_INVALID：是发出后核验失败，不是发出前拒绝）。
  const declared = await strict(`${ROOT}/acme/chat`, post)
  assert.equal(declared.status, 502); assert.equal(declared.headers.get('x-tapeapi-verify-error'), 'RECEIPT_INVALID')
  assert.deepEqual(sent, [`${ROOT}/acme/chat`])
  assert.ok(!reports.some((r) => r.problems?.some((p) => /format not declared/.test(p))), 'not reported as undeclared')
  // anthropic-messages under the prefix is still undeclared: strict refuses, naming both declared formats.
  await assert.rejects(strict(`${ROOT}/v1/messages`, post), (e) => e.code === 'INVALID_ARGUMENT' && e.data.format === 'anthropic-messages' && e.data.declared.join() === 'openai-chat,acme-chat')
  // Not strict: sent, and onReport says it was not verified. / 非 strict：发出，onReport 说明未核验。
  const lax = ai.createVerifyingFetch({ service, fetch: stub, formats: [chat, acme], strict: false, onReport: (r) => reports.push(r) })
  reports.length = 0
  const r = await lax(`${ROOT}/v1/embeddings`, post)
  assert.equal(r.status, 400)
  assert.equal(sent.at(-1), `${ROOT}/v1/embeddings`)
  assert.equal(reports.length, 1); assert.equal(reports[0].mismatch, true)
  assert.match(reports[0].problems[0], /^not verified: format not declared: POST https:\/\/relay\.example\/team\/v1\/embeddings is a metered openai-embeddings call/)
})
