// Guessable answer ids (docs/PLAN-2026Q4.md, privacy item 1). Ollama's OpenAI-compatible API numbers its chat ids
// "chatcmpl-" and 0..998 (ollama/ollama#18655); TAP-21 §3.5 makes the sidecar keep the upstream's id, and the free
// `receipt` method answers anyone who names an id. So: the sidecar estimates the ids' entropy and says so in its log;
// receipts are stored per (id, requestSha256), so answers that share an id keep a receipt each; the `receipt` method has
// its own per-IP budget (an unsigned 429 past it); the lifetime is configurable; and the optional `requestSha256`
// parameter (TAP-21 §3.5, MAY) picks one receipt, or is required when the operator says so. The receipt itself is
// unchanged. No network.
// 可猜的回答 id：Ollama 的 OpenAI 兼容接口把对话 id 编成 "chatcmpl-" 加 0..998；规范要求旁路沿用上游 id，而免费的 receipt 方法
// 回应任何给出 id 的人。因此：旁路估计 id 的熵并在日志中说明；回执按 (id, requestSha256) 存储，共用 id 的回答各留一份；receipt
// 方法有自己的按 IP 预算（超出回未签名的 429）；保留时长可配置；可选参数 requestSha256 挑出其中一份，或按运营者要求成为必填。
// 回执本身不变。不联网。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createAIProxy, idEntropyBits, ID_ENTROPY_MIN_BITS, RECEIPT_LOOKUPS_PER_MIN } from '../src/ai-proxy.js'
import { ai } from '@tapeapi/sdk'
import { privateKeyToAddress, recoverResponseSigner } from '../../sdk/src/sig.js'
import { build } from '../../examples/ai-proxy/worker.js'
import { readConfig } from '../../examples/new-api-sidecar/server.mjs'
import { throwawayIdentity, EXAMPLE_MODELS } from '../../examples/new-api-sidecar/smoke.mjs'

const KEY = '0x' + '42'.repeat(32)
const SIGNER = privateKeyToAddress(KEY)
const CIRCUITS = '0xe02c26c7432A7121168AA9B610DE24eCf9a1a414', CONTAINER = '0x1b2A657BcBa9D3229f57aC2f4FcbEE2AA756aAe8'
const BASE = 'https://ai.example'
const MODELS = [{ id: 'llama3', prices: [{ currency: 'USDT', unit: '1M tokens', input: '0.1', output: '0.2' }] }]
const manifestBase = () => ({ name: 'Local llama', circuits: CIRCUITS, tokenId: '11', container: CONTAINER, delegation: null, endpoints: { live: [`${BASE}/tapeapi/v1`], async: false } })
const td = new TextDecoder()
const CHAT = '/v1/chat/completions'

// An Ollama-like upstream: ids "chatcmpl-<n>" with n from a list (a stand-in for rand.Intn(999)), then random.
// 类 Ollama 上游：id 为 "chatcmpl-<n>"，n 先取自给定列表（代替 rand.Intn(999)），用完后随机。
function ollama(ns = []) {
  const queue = [...ns]
  const calls = []
  const fetch = async (url, init = {}) => {
    const body = JSON.parse(td.decode(new Uint8Array(init.body)))
    calls.push(body)
    const n = queue.length ? queue.shift() : Math.floor(Math.random() * 999)
    const answer = { id: `chatcmpl-${n}`, object: 'chat.completion', created: 1, model: 'llama3', system_fingerprint: 'fp_ollama', choices: [{ index: 0, message: { role: 'assistant', content: `echo: ${body.messages[0].content}` }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return { fetch, calls }
}
const make = (fetch, extra = {}, logs = []) => createAIProxy({ upstream: { baseUrl: 'http://127.0.0.1:11434/v1' }, manifestBase: manifestBase(), signerKey: KEY, models: MODELS, fetch, log: (...a) => logs.push(a.join(' ')), ...extra })
const ask = async (p, content, ip = '1.1.1.1') => {
  const body = JSON.stringify({ model: 'llama3', messages: [{ role: 'user', content }] })
  const res = await p.handleRequest(new Request(BASE + CHAT, { method: 'POST', headers: { 'content-type': 'application/json' }, body }), { clientIp: ip })
  return { body, text: await res.text(), env: ai.decodeReceiptHeader(res.headers.get(ai.RECEIPT_HEADER)) }
}
const lookup = async (p, params, ip = '9.9.9.9') => {
  const res = await p.handleRequest(new Request(`${BASE}/tapeapi/v1/receipt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'q', params }) }), { clientIp: ip })
  return { status: res.status, headers: res.headers, body: await res.json() }
}

test('idEntropyBits: every Ollama chat id is far below the threshold; OpenAI, Anthropic, Responses, UUID and the sidecar\'s own ids are far above', () => {
  let max = 0
  for (let n = 0; n < 999; n++) max = Math.max(max, idEntropyBits(`chatcmpl-${n}`))
  assert.ok(max <= 10, `Ollama ids estimate at most ${max} bits`)
  assert.ok(max < ID_ENTROPY_MIN_BITS)
  for (const id of ['chatcmpl-B9MHDbslfkBeAs8l4bebGdFOJ6PeG', 'msg_01XFDUDYJgAACzvnptvVoYEL', 'resp_67ccd2bed1ec8190b14f964abc0542670bb6a6b452d3795b',
    'chatcmpl-550e8400-e29b-41d4-a716-446655440000', 'tapeapi-0123456789abcdef01234567']) {
    assert.ok(idEntropyBits(id) >= ID_ENTROPY_MIN_BITS, `${id}: ${idEntropyBits(id)} bits`)
  }
  // A timestamp looks as random as its digits: an upper bound, so it is still flagged. / 时间戳按位数估计，仍被标出。
  assert.ok(idEntropyBits('chatcmpl-1790000000123') < ID_ENTROPY_MIN_BITS)
  assert.equal(idEntropyBits(''), 0); assert.equal(idEntropyBits('chatcmpl-'), 0); assert.equal(idEntropyBits(undefined), 0)
})

test('Ollama-style ids: the log says once that they are guessable; stats carry the estimate; ids from the OpenAI shape raise nothing', async () => {
  const logs = []
  const p = make(ollama([417, 3, 998]).fetch, {}, logs)
  await ask(p, 'a'); await ask(p, 'b'); await ask(p, 'c')
  const warned = logs.filter((l) => /response ids look guessable/.test(l))
  assert.equal(warned.length, 1, 'said once')
  assert.match(warned[0], /about \d+ bits in "chatcmpl-417"/)
  assert.match(warned[0], /RECEIPT_REQUIRE_HASH=1/, 'and names the switch')
  const s = p.stats()
  assert.equal(s.guessableIdsSeen, true); assert.ok(s.idEntropyMinBits <= 10); assert.equal(s.guessableIds, 3); assert.equal(s.requireRequestHash, false)

  const quiet = []
  const q = make(async () => new Response(JSON.stringify({ id: 'chatcmpl-B9MHDbslfkBeAs8l4bebGdFOJ6PeG', model: 'llama3', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { headers: { 'content-type': 'application/json' } }), {}, quiet)
  await ask(q, 'x')
  assert.equal(quiet.filter((l) => /guessable/.test(l)).length, 0)
  assert.equal(q.stats().guessableIdsSeen, false); assert.ok(q.stats().idEntropyMinBits >= ID_ENTROPY_MIN_BITS)
})

test('two answers that share an Ollama id keep a receipt each, told apart by requestSha256; an id-only lookup serves the later one', async () => {
  const logs = []
  const p = make(ollama([417, 417]).fetch, {}, logs)
  const a = await ask(p, 'first question'), b = await ask(p, 'second question')
  assert.equal(a.env.id, 'chatcmpl-417'); assert.equal(b.env.id, 'chatcmpl-417')
  assert.notEqual(a.env.params.requestSha256, b.env.params.requestSha256)
  assert.equal(a.env.params.requestSha256, ai.sha256Hex(a.body))
  const gotA = await lookup(p, { id: 'chatcmpl-417', requestSha256: a.env.params.requestSha256 })
  const gotB = await lookup(p, { id: 'chatcmpl-417', requestSha256: b.env.params.requestSha256 })
  assert.deepEqual(gotA.body.result, a.env, 'the first receipt is still there, not overwritten')
  assert.deepEqual(gotB.body.result, b.env)
  assert.deepEqual((await lookup(p, { id: 'chatcmpl-417' })).body.result, b.env, 'id only: the later one (TAP-21 §3.5)')
  // The answer to a lookup with the hash is signed over the params as sent, hash included. / 带哈希的查询，其回答按原样的参数签名。
  assert.equal(recoverResponseSigner({ container: gotA.body.container, id: 'q', method: 'receipt', params: { id: 'chatcmpl-417', requestSha256: a.env.params.requestSha256 }, ok: true, body: gotA.body.result, ts: gotA.body.ts }, gotA.body.sig), SIGNER)
  const miss = await lookup(p, { id: 'chatcmpl-417', requestSha256: 'ab'.repeat(32) })
  assert.equal(miss.status, 400); assert.match(miss.body.error.message, /no receipt for chatcmpl-417/)
  for (const bad of ['AB'.repeat(32), 'ab', 7, null]) assert.match((await lookup(p, { id: 'chatcmpl-417', requestSha256: bad })).body.error.message, /64 lowercase hex/)
  assert.equal(p.stats().duplicateIds, 1)
  assert.ok(logs.some((l) => /kept under \(id, requestSha256\)/.test(l)))
  assert.equal(p.stats().receiptsKept, 2)
  // The same request bytes answered under the same id again: a replay, which replaces. / 同样的请求字节、同一个 id：重放，替换。
  const again = make(ollama([5, 5]).fetch)
  await ask(again, 'same'); const second = await ask(again, 'same')
  assert.equal(again.stats().receiptsKept, 1)
  assert.deepEqual((await lookup(again, { id: 'chatcmpl-5' })).body.result, second.env)
})

test('an id seen twice within the receipt lifetime counts as guessable even when its shape looks random', async () => {
  const logs = []
  const p = make(async () => new Response(JSON.stringify({ id: 'chatcmpl-B9MHDbslfkBeAs8l4bebGdFOJ6PeG', model: 'llama3' }), { headers: { 'content-type': 'application/json' } }), {}, logs)
  await ask(p, 'one'); await ask(p, 'two')
  assert.equal(p.stats().guessableIdsSeen, true)
  assert.ok(logs.some((l) => /came twice within 1 hour/.test(l)))
})

test('enumerating the 999 ids: the receipt method stops one IP after its own budget with an unsigned 429 (TAP-21 §3.4); another IP has its own', async () => {
  const p = make(ollama(Array.from({ length: 20 }, (_, i) => i)).fetch)
  const victims = []
  for (let i = 0; i < 20; i++) victims.push(await ask(p, `private question ${i}`, `10.0.0.${i}`))
  const seen = []
  let refused = null
  for (let n = 0; n < 999 && !refused; n++) {
    const r = await lookup(p, { id: `chatcmpl-${n}` }, '6.6.6.6')
    if (r.status === 429) refused = r
    else seen.push(r)
  }
  assert.equal(seen.length, RECEIPT_LOOKUPS_PER_MIN, `${RECEIPT_LOOKUPS_PER_MIN} lookups, then refused`)
  assert.equal(refused.status, 429)
  assert.ok(Number(refused.headers.get('retry-after')) >= 1)
  assert.equal(refused.body.ok, false); assert.equal(refused.body.error.code, 'RATE_LIMITED'); assert.ok(refused.body.error.data.retryAfterS >= 1)
  assert.equal(refused.body.sig, undefined, 'unsigned'); assert.equal(refused.body.container, undefined)
  assert.equal((await lookup(p, { id: 'chatcmpl-0' }, '7.7.7.7')).status, 200, 'another IP is not affected')
  assert.equal(p.stats().receiptRateLimited, 1)
  // The answers themselves are not limited by it. / 回答本身不受它限制。
  assert.ok((await ask(p, 'still answered', '6.6.6.6')).env)
  // Configurable, and off with false. / 可配置，false 关闭。
  const wide = make(ollama().fetch, { receiptRateLimit: { ip: 2, windowMs: 60_000 } })
  assert.deepEqual([(await lookup(wide, { id: 'x' })).status, (await lookup(wide, { id: 'x' })).status, (await lookup(wide, { id: 'x' })).status], [400, 400, 429])
  const off = make(ollama().fetch, { receiptRateLimit: false })
  for (let i = 0; i < RECEIPT_LOOKUPS_PER_MIN + 5; i++) assert.equal((await lookup(off, { id: 'x' })).status, 400)
  assert.throws(() => make(ollama().fetch, { receiptRateLimit: { ip: -1 } }), /receiptRateLimit/)
})

test('requireRequestHash: an id-only lookup is refused (signed BAD_REQUEST), so a guessed id reaches nothing; with the hash it answers', async () => {
  const p = make(ollama([12]).fetch, { requireRequestHash: true })
  const a = await ask(p, 'my private prompt')
  const idOnly = await lookup(p, { id: 'chatcmpl-12' })
  assert.equal(idOnly.status, 400); assert.equal(idOnly.body.error.code, 'BAD_REQUEST'); assert.match(idOnly.body.error.message, /only with params\.requestSha256/)
  assert.match(idOnly.body.sig, /^0x[0-9a-f]{130}$/, 'a provider refusal, signed as usual')
  const withHash = await lookup(p, { id: 'chatcmpl-12', requestSha256: a.env.params.requestSha256 })
  assert.equal(withHash.status, 200); assert.deepEqual(withHash.body.result, a.env)
  assert.throws(() => make(ollama().fetch, { requireRequestHash: 'yes' }), /requireRequestHash/)
})

test('the receipt lifetime is configurable: shorter is logged, the method description states it, and the default description is unchanged', async () => {
  const def = make(ollama().fetch)
  assert.equal((await def.ready).methods[0].description, 'The signed usage receipt of an AI response, by the response id (kept for 1 hour after the answer).')
  assert.deepEqual((await def.ready).methods[0].params, { id: 'string' }, 'the manifest entry names id only (TAP-21 §3.5)')
  const logs = []
  const p = make(ollama([1]).fetch, { receiptTtlMs: 150 }, logs)
  assert.match((await p.ready).methods[0].description, /kept for 150 ms after the answer/)
  assert.ok(logs.some((l) => /less than the hour TAP-21 §3\.5 recommends/.test(l)))
  assert.match((await make(ollama().fetch, { receiptTtlMs: 900_000 }).ready).methods[0].description, /kept for 15 min/)
  assert.match((await make(ollama().fetch, { receiptTtlMs: 7_200_000 }).ready).methods[0].description, /kept for 2 hours/)
  const a = await ask(p, 'short-lived')
  assert.equal((await lookup(p, { id: a.env.id })).status, 200)
  await new Promise((r) => setTimeout(r, 200))
  assert.equal((await lookup(p, { id: a.env.id, requestSha256: a.env.params.requestSha256 })).status, 400, 'expired')
  assert.equal(p.stats().receiptsKept, 0, 'dropped when a lookup finds it expired')
})

test('the receipt is unchanged: same members in the same order, verifies with the unchanged client check (frozen shape)', async () => {
  const p = make(ollama([7]).fetch)
  const { body, text, env } = await ask(p, 'shape')
  assert.deepEqual(Object.keys(env), ['id', 'ok', 'result', 'container', 'ts', 'method', 'params', 'sig'])
  assert.deepEqual(Object.keys(env.params), ['path', 'requestSha256'])
  assert.deepEqual(Object.keys(env.result), ['model', 'usage', 'responseSha256', 'stream', 'complete', 'status', 'prices', 'modelMatchedBy'])
  const v = ai.verifyUsageReceipt({ envelope: env, manifest: await p.ready, requestBytes: body, responseBytes: text, stream: false, path: CHAT, status: 200 })
  assert.deepEqual(v.problems, []); assert.equal(v.ok, true)
})

test('the Worker and the new-api sidecar pass the settings through (RECEIPT_TTL_S, RECEIPT_LOOKUPS_PER_MIN, RECEIPT_REQUIRE_HASH)', async () => {
  const env = {
    SIGNER_KEY: KEY, UPSTREAM_BASE_URL: 'https://up.example/v1', MODELS_JSON: JSON.stringify(MODELS), CIRCUITS, TOKEN_ID: '11', CONTAINER,
    DELEGATION_EXPIRES: '1900000000', DELEGATION_SIG: '0x' + '11'.repeat(65), PUBLIC_URL: BASE,
  }
  const quiet = { log: () => {} }
  assert.match((await build(env, quiet).ready).methods[0].description, /kept for 1 hour/)
  const w = build({ ...env, RECEIPT_TTL_S: '600', RECEIPT_LOOKUPS_PER_MIN: '3', RECEIPT_REQUIRE_HASH: '1' }, quiet)
  assert.match((await w.ready).methods[0].description, /kept for 10 min/)
  assert.equal(w.stats().requireRequestHash, true)
  const statuses = []
  for (let i = 0; i < 4; i++) statuses.push((await lookup(w, { id: 'x' })).status)
  assert.deepEqual(statuses, [400, 400, 400, 429])
  const complete = { ...throwawayIdentity(), PUBLIC_URL: 'https://api.example.com', MODELS_FILE: EXAMPLE_MODELS }
  const c = readConfig({ ...complete, RECEIPT_TTL_S: '900', RECEIPT_REQUIRE_HASH: '1' })
  assert.equal(c.ok, true, c.problem); assert.equal(c.config.receiptTtlS, 900); assert.equal(c.config.requireRequestHash, true)
  assert.equal(readConfig(complete).config.requireRequestHash, false); assert.equal(readConfig(complete).config.receiptTtlS, 3600)
  assert.match(readConfig({ ...complete, RECEIPT_TTL_S: 'soon' }).problem, /RECEIPT_TTL_S/)
  assert.match(readConfig({ ...complete, RECEIPT_REQUIRE_HASH: 'yes' }).problem, /RECEIPT_REQUIRE_HASH/)
})

test('TAP-21 §3.5: the optional requestSha256 parameter is in both halves, and the two halves keep the same MUST/SHOULD/MAY counts', async () => {
  const { readFileSync } = await import('node:fs')
  const text = readFileSync(new URL('../../spec/TAP-21.md', import.meta.url), 'utf8')
  const at = text.indexOf('\n## 1. 摘要')
  assert.ok(at > 0)
  const en = text.slice(0, at), zh = text.slice(at)
  assert.match(en, /The method MAY also take a second, optional parameter `requestSha256`/)
  assert.match(en, /MAY refuse a lookup that does not name `requestSha256`/)
  assert.match(zh, /该方法 MAY 另外接受第二个、可选的参数 `requestSha256`/)
  assert.match(zh, /MAY 拒绝没有给出 `requestSha256` 的取回/)
  const count = (s, k) => (s.match(new RegExp(`\\b${k}\\b`, 'g')) || []).length
  for (const k of ['MUST NOT', 'MUST', 'SHOULD NOT', 'SHOULD', 'MAY', 'REQUIRED', 'OPTIONAL', 'RECOMMENDED']) assert.equal(count(en, k), count(zh, k), k)
  // The manifest entry stays { id: "string" } in both. / 两半都保持清单条目只有 id。
  assert.match(en, /`params: \{ id: "string" \}`/); assert.match(zh, /`params: \{ id: "string" \}`/)
})
