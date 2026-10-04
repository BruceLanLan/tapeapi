// createVerifyingFetch({ requestUsage: true }) (1.6): the client asks for the usage of a stream OpenAI Chat request in its
// bytes, the sidecar then injects and strips nothing, and the usage chunk is part of the signed stream the application
// receives (DESIGN-1.6: no stripping on the client). What 1.5 left unverifiable by design (TAPI-21 §3.5 check 4: an
// injected stream's usage) is compared like a whole answer's. Covered here: the A/B differential against 1.5's injection
// under every cutting and line end, forged and moved usage chunks, a sidecar that strips anyway, an upstream that ignores
// the member, look-alike chunks (nothing is ever taken out), the body forms, the gates in strict and not, requests the
// option does not concern, and the official openai package.
// createVerifyingFetch({ requestUsage: true })：客户端在字节里替流式 OpenAI Chat 请求要用量，旁路随之不注入、不剥离，用量块成为
// 应用收到的、被签名的流的一部分（不在客户端剥块）。1.5 按设计无法核验的部分（注入流的用量）从此像整体回答一样比对。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createTapeAPI, ai, TapeAPIError } from '../src/index.js'
import { requestUsageBody, receiptComment, USAGE_REQUEST_SKIPS } from '../src/ai.js'
import { signResponse } from '../src/sig.js'
import { createAIProxy } from '../../server/src/ai-proxy.js'
import { createFakeUpstream } from '../../examples/ai-proxy/fake-upstream.mjs'
import { KEY, MODELS, BASE, manifestBase, cannedWorld } from './helpers/ai-canned.mjs'
import { deterministic } from './helpers/deterministic.mjs'

let OpenAI = null
try { ({ default: OpenAI } = await import('openai')) } catch { /* not installed */ }

const te = new TextEncoder(), td = new TextDecoder('utf-8', { ignoreBOM: true })
const chat = ai.FORMATS.find((f) => f.name === 'openai-chat')
const CHAT_URL = `${BASE}/v1/chat/completions`
const USAGE = { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 }
const INFLATED = { prompt_tokens: 9_000_009, completion_tokens: 3, total_tokens: 9_000_012 }
const RECEIPT = /: tapeapi-receipt [A-Za-z0-9_-]+\n\n/g
const noReceipt = (s) => s.replace(RECEIPT, '')
const REQ = JSON.stringify({ model: 'demo-chat', messages: [{ role: 'user', content: 'Say hello' }], stream: true })
const json = { 'content-type': 'application/json', authorization: 'Bearer sk-demo' }

// ---- the upstream: one Chat stream, its usage chunk only when asked / 上游：一条 Chat 流，只有要了才有用量块 ----
// `eol` the line end; `shape` 'openai' (choices: []) or 'litellm' ([{ index: 0, delta: {} }]); `usageNull` adds
// "usage": null to every other chunk (OpenAI does when include_usage is set); `lookalike` puts a chunk that looks like a
// usage chunk but carries text in another member before the finish; `ignore`: the upstream never sends the usage chunk.
// eol 行尾；shape 用量块形状；usageNull 给其它块加 "usage": null；lookalike 在结束前放一个像用量块、却在别的成员里带文字的块；ignore：上游从不发用量块。
function upstreamText({ eol = '\n', shape = 'openai', usageNull = false, lookalike = false, withUsage = true } = {}) {
  const c = (o) => `data: ${JSON.stringify({ id: 'chatcmpl-ab1', object: 'chat.completion.chunk', created: 1, model: 'demo-chat', ...o, ...(usageNull && !o.usage ? { usage: null } : {}) })}${eol}${eol}`
  return c({ choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }) +
    c({ choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }] }) +
    (lookalike ? c({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, x_text: 'words the application must see' }) : '') +
    c({ choices: [{ index: 0, delta: { content: ' there' }, finish_reason: null }] }) +
    c({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) +
    (withUsage ? c({ choices: shape === 'litellm' ? [{ index: 0, delta: {} }] : [], usage: USAGE }) : '') +
    `data: [DONE]${eol}${eol}`
}
const usageEventOf = (text, eol = '\n') => text.split(new RegExp(`(?<=${eol === '\n' ? '\\n\\n' : eol === '\r' ? '\\r\\r' : '\\r\\n\\r\\n'})`)).find((e) => e.includes(`"usage":${JSON.stringify(USAGE)}`))

// ---- cuttings / 切分 ----
function rng(seed) { let s = seed >>> 0; return (n) => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return (s >>> 8) % n } }
const splitAt = (b, at) => { const out = []; let p = 0; for (const c of at) { if (c > p && c < b.length) { out.push(b.subarray(p, c)); p = c } } out.push(b.subarray(p)); return out.filter((x) => x.length) }
function cut(bytes, how) {
  const text = td.decode(bytes)
  if (how === 'whole') return [bytes]
  if (how === 'bytewise') return splitAt(bytes, Array.from({ length: bytes.length - 1 }, (_, k) => k + 1))
  if (how === 'event') { const at = []; const re = /\r\n\r\n|\n\n|\r\r/g; let m; while ((m = re.exec(text))) at.push(te.encode(text.slice(0, m.index + m[0].length)).length); return splitAt(bytes, at) }
  if (how === 'crlf-split') { const at = []; for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0x0d) at.push(i + 1); return splitAt(bytes, at) }
  const r = rng(Number(how.slice(7)))
  return splitAt(bytes, [...new Set(Array.from({ length: 1 + r(24) }, () => 1 + r(bytes.length - 1)))].sort((x, y) => x - y))
}
const CUTS = ['whole', 'event', 'bytewise', 'crlf-split', ...Array.from({ length: 6 }, (_, i) => `random#${101 + i}`)]
const streamOf = (chunks) => new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(x); c.close() } })

// ---- a world: the reference sidecar over that upstream, and a verifying fetch / 世界：该上游前的参考旁路与核验 fetch ----
async function world(variant = {}) {
  const sent = [], upstream = []
  const fetch = async (url, init) => {
    const raw = new Uint8Array(await new Response(init.body).arrayBuffer())
    upstream.push(raw)
    let body = {}
    try { body = JSON.parse(td.decode(raw)) } catch { /* not JSON */ }
    if (body.stream !== true) return new Response(JSON.stringify({ id: 'chatcmpl-w', object: 'chat.completion', model: 'demo-chat', choices: [{ index: 0, message: { role: 'assistant', content: 'Hello there' }, finish_reason: 'stop' }], usage: USAGE }), { headers: { 'content-type': 'application/json' } })
    const text = upstreamText({ ...variant, withUsage: body.stream_options?.include_usage === true && !variant.ignore })
    return new Response(streamOf(cut(te.encode(text), variant.upCut ?? 'event')), { headers: { 'content-type': 'text/event-stream' } })
  }
  const proxy = createAIProxy({ upstream: { baseUrl: 'http://upstream.local/v1' }, fetch, manifestBase: manifestBase(), signerKey: KEY, models: MODELS, allowHttp: true, rateLimit: false, log: () => {} })
  const service = await createTapeAPI({ dev: true, fetch: (u, i) => proxy.handleRequest(new Request(u, i)) }).resolve({ dev: BASE })
  const state = { edit: null, cut: 'whole' }
  // Between the sidecar and the client: an optional edit of the whole answer, then the chosen cutting.
  // 旁路与客户端之间：可选地改动整个回答，再按选定方式切分。
  const route = async (u, i) => {
    sent.push({ body: new Uint8Array(await new Response(i.body).arrayBuffer()), headers: new Headers(i.headers) })
    const r = await proxy.handleRequest(new Request(u, i))
    if (!r.body) return r
    let bytes = new Uint8Array(await r.arrayBuffer())
    if (state.edit) bytes = te.encode(state.edit(td.decode(bytes)))
    const h = new Headers(r.headers); h.delete('content-length')
    return new Response(streamOf(cut(bytes, state.cut)), { status: r.status, headers: h })
  }
  const verifying = (opts = {}) => { const reports = []; return { reports, fetch: ai.createVerifyingFetch({ service, fetch: route, onReport: (r) => reports.push(r), ...opts }) } }
  return { proxy, service, sent, upstream, state, verifying }
}
const call = async (vf, body = REQ, headers = json) => { const res = await vf(CHAT_URL, { method: 'POST', headers, body }); return td.decode(new Uint8Array(await res.arrayBuffer())) }
const codeOf = (e) => (e instanceof TapeAPIError ? e.code : e?.cause instanceof TapeAPIError ? e.cause.code : e?.code)
// Edit a stream's receipt and re-sign it with the service key (what the operator of a sidecar can do).
// 改流的回执并用服务密钥重签（旁路运营方能做的事）。
function resignStream(text, patch) {
  const m = /: tapeapi-receipt ([A-Za-z0-9_-]+)\n\n/.exec(text)
  const env = ai.decodeReceiptHeader(m[1])
  const result = { ...env.result, ...patch }
  for (const k of Object.keys(result)) if (result[k] === undefined) delete result[k]
  if (result.usage) result.prices = ai.pricingOf(MODELS, { reported: result.model, usage: result.usage, format: 'openai-chat' }).prices
  const forged = { ...env, result, sig: signResponse({ container: env.container, id: env.id, method: env.method, params: env.params, ok: true, body: result, ts: env.ts }, KEY) }
  return text.replace(m[0], receiptComment(forged) + '\n\n')
}
const digestUpToDone = (text) => ai.scanSse(text.slice(0, text.indexOf('data: [DONE]')), { format: chat }).responseSha256

test('CONFIRMED AI-ASK-2: of the built-in formats only openai-chat changes the request (prepareUpstream), and it names its usageMember', () => {
  assert.deepEqual(ai.FORMATS.filter((f) => typeof f.prepareUpstream === 'function').map((f) => f.name), ['openai-chat'])
  for (const f of ai.FORMATS.filter((x) => x.prepareUpstream)) assert.deepEqual([...f.usageMember], ['stream_options', 'include_usage'])
})

test('requestUsage: the request is sent with the member set, then salted; the sidecar injects nothing; the usage reaches the application and is compared', async () => {
  const w = await world()
  const { fetch, reports } = w.verifying({ requestUsage: true })
  const got = await call(fetch, REQ, { ...json, 'content-length': String(REQ.length) })
  const spliced = td.decode(requestUsageBody(REQ, { format: chat }).bytes)
  assert.equal(spliced, REQ.slice(0, -1) + ',"stream_options":{"include_usage":true}}')
  const sent = td.decode(w.sent[0].body)
  assert.equal(sent.slice(0, spliced.length), spliced, 'the member first')
  assert.match(sent.slice(spliced.length), /^[ \t\r\n]{64}$/, 'then the salt, after the JSON text')
  assert.equal(w.sent[0].headers.get('content-length'), null, 'the stale content-length is dropped')
  assert.deepEqual(w.upstream.map((b) => td.decode(b)), [sent], 'the sidecar sends the bytes on as they are')
  assert.equal(noReceipt(got), upstreamText(), 'the application gets the upstream stream, usage chunk included')
  const r = reports[0]
  assert.deepEqual([r.ok, r.problems, r.warnings, r.usageRequested, r.salted, 'usageRequestSkipped' in r], [true, [], [], true, true, false])
  assert.ok(!r.unchecked.some((x) => /^usage/.test(x)), r.unchecked.join())
  assert.equal(r.receipt.result.usageInjected, undefined)
  assert.deepEqual(r.receipt.result.usage, USAGE)
  assert.equal(r.receipt.params.requestSha256, ai.sha256Hex(w.sent[0].body), 'requestSha256 is the hash of the bytes finally sent')
})

// The compatibility claim, as a differential: the same upstream stream U; A = 1.5 (the sidecar injects and strips), B =
// requestUsage. Without the receipt comment, B is U byte for byte and A is U without the usage event: B is A plus exactly
// that one event, whatever the line ends, the usage chunk's shape, the cutting on either side, strict or not.
// 兼容性主张的差分：同一上游流 U；A = 1.5（旁路注入并剥离），B = requestUsage。去掉回执注释后，B 逐字节等于 U，A 等于 U 去掉用量事件：
// B 恰好比 A 多那一个事件，与行尾、用量块形状、两侧切分、strict 与否都无关。
for (const variant of [{}, { eol: '\r\n' }, { eol: '\r' }, { shape: 'litellm' }, { usageNull: true }, { eol: '\r\n', shape: 'litellm', usageNull: true }]) {
  test(`requestUsage A/B: B (asked) = A (1.5, injected and stripped) + the usage event, every cutting, strict and not: ${JSON.stringify(variant)}`, async () => {
    const U = upstreamText({ ...variant, withUsage: true })
    const usageEvent = usageEventOf(U, variant.eol ?? '\n')
    assert.ok(usageEvent)
    for (const how of CUTS) {
      for (const strict of [true, false]) {
        const w = await world({ ...variant, upCut: how })
        w.state.cut = how
        const a = w.verifying({ strict, salt: false }), b = w.verifying({ strict, salt: false, requestUsage: true })
        // Strict ends the stream at a blank line that is a CR at the end of a chunk without waiting for the LF of its CRLF
        // (1.5, FIXED SSE-END): both paths alike. / strict 在块末 CR 构成的空行处结束，不等 CRLF 的 LF（1.5 行为）：两条路径相同。
        const lf = (x) => (strict && x.endsWith('\r') && U.endsWith('\r\n') ? x + '\n' : x)
        const A = lf(noReceipt(await call(a.fetch))), B = lf(noReceipt(await call(b.fetch)))
        const at = `${how} strict=${strict}`
        assert.equal(B, U, `B is the upstream stream (${at})`)
        // 1.5's strip passes on the LF of a CRLF that ends a stripped event when the CRLF is split across upstream chunks: one
        // stray blank line, which dispatches nothing and is not hashed (found by this test; the strip path is unchanged in 1.6).
        // 1.5 的剥离在被剥事件结尾的 CRLF 跨上游块时会放出其中的 LF：多一个空行，不分派任何事件、不计入哈希（本测试发现；1.6 不动剥离路径）。
        const stray = (variant.eol === '\r\n' && A === U.replace(usageEvent, '\n'))
        assert.ok(A === U.replace(usageEvent, '') || stray, `A is it without the usage event (${at}):\n${JSON.stringify(A)}`)
        assert.deepEqual([a.reports[0].ok, b.reports[0].ok], [true, true], at)
        assert.equal(a.reports[0].receipt.result.usageInjected, true)
        assert.ok(a.reports[0].unchecked.some((x) => /^usage/.test(x)), 'A: usage not checked')
        assert.ok(!b.reports[0].unchecked.some((x) => /^usage/.test(x)), 'B: usage checked')
        assert.deepEqual([a.reports[0].receipt.result.usage, b.reports[0].receipt.result.usage], [USAGE, USAGE])
      }
    }
  })
}

test('FIXED AI-ASK-1: the sidecar raises the usage, recomputes the prices and re-signs: with requestUsage the stream fails (strict: the iterator throws RECEIPT_INVALID); in 1.5\'s injected path the same forgery passes unchecked', async () => {
  for (const how of ['whole', 'event', 'bytewise']) {
    const w = await world()
    w.state.cut = how
    w.state.edit = (s) => resignStream(s, { usage: INFLATED })
    // 1.5: the request did not ask, the sidecar injected; the forged receipt passes with the usage unchecked (the gap).
    // 1.5：请求没要，旁路注入；伪造的回执以"用量未核"通过（缺口所在）。
    const old = w.verifying({ salt: false })
    await call(old.fetch)
    assert.equal(old.reports[0].ok, true, how)
    assert.ok(old.reports[0].unchecked.some((x) => /^usage/.test(x)))
    assert.deepEqual(old.reports[0].receipt.result.usage, INFLATED)
    // 1.6, strict: the usage the stream carries is compared with the receipt's. / 1.6 strict：比对流里的用量与回执的用量。
    const asked = w.verifying({ requestUsage: true })
    await assert.rejects(call(asked.fetch), (e) => codeOf(e) === 'RECEIPT_INVALID', how)
    assert.match(asked.reports[0].problems.join(' | '), /the receipt says usage .*9000009.*but the answer reports .*"prompt_tokens":9,/)
    // Not strict: the answer arrives, the report fails. / 非 strict：回答照常到达，报告失败。
    const loose = w.verifying({ requestUsage: true, strict: false })
    assert.match(await call(loose.fetch), /Hello/)
    assert.equal(loose.reports[0].ok, false)
    assert.match(loose.reports[0].problems.join(), /but the answer reports/)
  }
})

test('FIXED AI-ASK-END: the sidecar moves the usage chunk after [DONE] and signs the hash up to the end with the usage it read: strict cuts at the end and fails RECEIPT_INVALID; not strict reports the late event and the mismatch', async () => {
  const move = (s) => {
    const ev = usageEventOf(s)
    const moved = s.replace(ev, '') + ev
    return resignStream(moved, { responseSha256: digestUpToDone(moved) })
  }
  for (const how of CUTS) {
    const w = await world()
    w.state.cut = how
    w.state.edit = move
    const strict = w.verifying({ requestUsage: true })
    await assert.rejects(call(strict.fetch), (e) => codeOf(e) === 'RECEIPT_INVALID', how)
    assert.ok(strict.reports[0].problems.some((p) => /the receipt says usage .*but the answer reports null/.test(p)), `${how}: ${strict.reports[0].problems.join(' | ')}`)
    assert.ok(!strict.reports[0].problems.some((p) => /responseSha256/.test(p)), 'the hash itself holds: the usage is what fails')
    const loose = w.verifying({ requestUsage: true, strict: false })
    await call(loose.fetch)
    const all = loose.reports.flatMap((r) => r.problems)
    assert.ok(all.some((p) => /but the answer reports null/.test(p)) && all.includes('an event after the end of the stream is not covered by its receipt'), `${how}: ${all.join(' | ')}`)
  }
  // Without requestUsage the same move is invisible: the receipt says usageInjected and nothing is compared (1.5's gap).
  // 不开 requestUsage 时同样的挪动看不出来：回执标 usageInjected，什么都不比（1.5 的缺口）。
  const w = await world()
  w.state.edit = (s) => { const t = s.replace(/: tapeapi-receipt [A-Za-z0-9_-]+\n\n/, (m) => m) + `data: ${JSON.stringify({ id: 'chatcmpl-ab1', choices: [], usage: USAGE })}\n\n`; return t }
  const off = w.verifying({ salt: false })
  await call(off.fetch)
  assert.equal(off.reports[0].ok, true)
})

test('requestUsage: a non-conforming sidecar that strips the usage chunk although the request asked fails (with or without usageInjected), and the report says why', async () => {
  for (const flag of [undefined, true]) {
    const w = await world()
    w.state.edit = (s) => { const t = s.replace(usageEventOf(s), ''); return resignStream(t, { responseSha256: digestUpToDone(t), usageInjected: flag }) }
    const { fetch, reports } = w.verifying({ requestUsage: true, strict: false })
    await call(fetch)
    const r = reports[0]
    assert.equal(r.ok, false)
    assert.match(r.problems.join(' | '), /the receipt says usage .*but the answer reports null/)
    if (flag) assert.match(r.problems.join(' | '), /usageInjected, but the request already asked for the usage/)
    assert.ok(r.warnings.some((x) => /asked for the usage \(requestUsage\), but the stream carries none/.test(x)), r.warnings.join())
    const strict = w.verifying({ requestUsage: true })
    await assert.rejects(call(strict.fetch), (e) => codeOf(e) === 'RECEIPT_INVALID')
  }
})

test('requestUsage: an upstream that ignores the member is an honest null: verified, usage null, and a warning says none came', async () => {
  const w = await world({ ignore: true })
  const { fetch, reports } = w.verifying({ requestUsage: true })
  assert.equal(noReceipt(await call(fetch)), upstreamText({ withUsage: false }))
  const r = reports[0]
  assert.deepEqual([r.ok, r.receipt.result.usage, r.receipt.result.prices, r.usageRequested], [true, null, null, true])
  assert.deepEqual(r.warnings, ['the request asked for the usage (requestUsage), but the stream carries none: the upstream did not send it, or something on the way took it out'])
})

test('CONFIRMED AI-ASK-NOSTRIP: nothing is taken out on the client: a chunk that looks like a usage chunk but carries text reaches the application whole with requestUsage (1.5\'s injected path strips it), every cutting', async () => {
  for (const how of CUTS) {
    const w = await world({ lookalike: true })
    w.state.cut = how
    const b = w.verifying({ requestUsage: true }), a = w.verifying({})
    const B = noReceipt(await call(b.fetch)), A = noReceipt(await call(a.fetch))
    assert.equal(B, upstreamText({ lookalike: true }), how)
    assert.match(B, /words the application must see/)
    assert.doesNotMatch(A, /words the application must see/, '1.5: the sidecar strips every chunk its rule matches')
    // The hash covers exactly what the application holds. / 哈希覆盖的正是应用手里的字节。
    assert.equal(b.reports[0].receipt.result.responseSha256, ai.scanSse(B, { format: chat }).responseSha256)
    assert.deepEqual(b.reports[0].receipt.result.usage, USAGE, 'the last usage counts')
  }
})

test('requestUsage: every body form (string, bytes, ArrayBuffer, DataView, ReadableStream, Blob, a Request, a Request with init) is rewritten once, then salted, the stream body read once', async () => {
  const forms = {
    string: () => [CHAT_URL, { method: 'POST', headers: json, body: REQ }],
    bytes: () => [CHAT_URL, { method: 'POST', headers: json, body: te.encode(REQ) }],
    arraybuffer: () => [CHAT_URL, { method: 'POST', headers: json, body: te.encode(REQ).buffer }],
    dataview: () => [CHAT_URL, { method: 'POST', headers: json, body: new DataView(te.encode(REQ).buffer) }],
    stream: () => { let pulls = 0; return [CHAT_URL, { method: 'POST', headers: json, duplex: 'half', body: new ReadableStream({ pull(c) { if (pulls++) return c.close(); const x = te.encode(REQ); c.enqueue(x.subarray(0, 5)); c.enqueue(x.subarray(5)) } }) }] },
    blob: () => [CHAT_URL, { method: 'POST', headers: { authorization: 'Bearer sk-demo' }, body: new Blob([REQ], { type: 'application/json' }) }],
    request: () => [new Request(CHAT_URL, { method: 'POST', headers: { ...json, 'content-length': String(REQ.length) }, body: REQ })],
    'request+init': () => [new Request(CHAT_URL, { method: 'POST', headers: json, body: '{"stream":false}' }), { body: REQ, method: 'POST', duplex: 'half' }],
  }
  const spliced = td.decode(requestUsageBody(REQ, { format: chat }).bytes)
  for (const [name, make] of Object.entries(forms)) {
    const w = await world()
    const { fetch, reports } = w.verifying({ requestUsage: true })
    const res = await fetch(...make())
    assert.equal(noReceipt(td.decode(new Uint8Array(await res.arrayBuffer()))), upstreamText(), name)
    const sent = td.decode(w.sent[0].body)
    assert.equal(sent.slice(0, spliced.length), spliced, name)
    assert.match(sent.slice(spliced.length), /^[ \t\r\n]{64}$/, name)
    assert.equal(w.sent[0].headers.get('content-length'), null, name)
    assert.deepEqual([reports[0].ok, reports[0].usageRequested], [true, true], name)
  }
})

test('requestUsage, strict: a body the gates refuse is INVALID_ARGUMENT before anything is sent; not strict: sent as it is, usageRequestSkipped, the usage unchecked as in 1.5', async () => {
  const bodies = [
    ['content-type', REQ, { ...json, 'content-type': 'text/plain' }],
    ['not-object', '\ufeff' + REQ, json],
    ['duplicate-member', '{"model":"demo-chat","model":"demo-chat","messages":[],"stream":true}', json],
    // FIXED AI-ASK-CASE (Fable review F1, attacks.mjs #1): a Go-style gateway would read INCLUDE_USAGE: false last.
    // Go 式网关会以后出现的 INCLUDE_USAGE: false 为准。
    ['duplicate-member', '{"model":"demo-chat","messages":[],"stream":true,"stream_options":{"include_usage":false,"INCLUDE_USAGE":false}}', json],
    ['content-encoding', REQ, { ...json, 'content-encoding': 'identity, gzip' }],
  ]
  for (const [reason, body, headers] of bodies) {
    const w = await world()
    const strict = w.verifying({ requestUsage: true })
    await assert.rejects(strict.fetch(CHAT_URL, { method: 'POST', headers, body }), (e) => e instanceof TapeAPIError && e.code === 'INVALID_ARGUMENT' && e.data.reason === reason && e.data.format === 'openai-chat' && e.message.includes(`(${reason}: `), reason)
    assert.equal(w.sent.length, 0, `${reason}: nothing was sent`)
    assert.equal(strict.reports.length, 0)
    if (reason === 'content-encoding') continue   // the sidecar cannot be given such a body meaningfully / 旁路无法有意义地处理
    const loose = w.verifying({ requestUsage: true, strict: false, salt: false })
    await call(loose.fetch, body, headers)
    assert.equal(td.decode(w.sent[0].body), body, `${reason}: sent as given`)
    const r = loose.reports[0]
    assert.deepEqual([r.ok, r.usageRequested, r.usageRequestSkipped], [true, false, reason], reason)
    assert.ok(r.unchecked.some((x) => /^usage/.test(x)), `${reason}: the sidecar injected, the usage is unchecked as before`)
  }
  assert.ok(USAGE_REQUEST_SKIPS.includes('content-type'))
})

test('requestUsage: requests it does not concern (Responses, Anthropic, a whole Chat answer, a stream that asked) are sent and delivered exactly as without it; reports only add usageRequested: false', async () => {
  const cases = [
    ['/v1/responses', { model: 'demo-chat', input: 'hi', stream: true }, json],
    ['/v1/messages', { model: 'demo-claude', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }], stream: true }, { 'content-type': 'application/json', 'x-api-key': 'sk-demo', 'anthropic-version': '2023-06-01' }],
    ['/v1/chat/completions', { model: 'demo-chat', messages: [{ role: 'user', content: 'hi' }] }, json],
    ['/v1/chat/completions', { model: 'demo-chat', messages: [{ role: 'user', content: 'hi' }], stream: true, stream_options: { include_usage: true } }, json],
  ]
  const run = async (opts, path, body, headers) => {
    const restore = deterministic({ seed: 3 })
    try {
      const { proxy, service } = await cannedWorld()
      const sent = [], reports = []
      const vf = ai.createVerifyingFetch({ service, onReport: (r) => reports.push(r), fetch: async (u, i) => { sent.push(td.decode(new Uint8Array(await new Response(i.body).arrayBuffer()))); return proxy.handleRequest(new Request(u, i)) }, ...opts })
      const res = await vf(BASE + path, { method: 'POST', headers, body: JSON.stringify(body) })
      const text = td.decode(new Uint8Array(await res.arrayBuffer()))
      return { sent, reports, text }
    } finally { restore() }
  }
  for (const [path, body, headers] of cases) {
    const off = await run({}, path, body, headers), on = await run({ requestUsage: true }, path, body, headers)
    assert.deepEqual(on.sent, off.sent, path)
    assert.equal(on.reports.length, off.reports.length)
    assert.deepEqual(on.reports.map((r) => r.usageRequested), off.reports.map(() => false), path)
    assert.deepEqual(on.reports.map(({ usageRequested, ...r }) => ({ ...r, receipt: r.receipt?.result })), off.reports.map((r) => ({ ...r, receipt: r.receipt?.result })), path)
    assert.ok(off.reports.every((r) => !('usageRequested' in r) && !('usageRequestSkipped' in r)), 'off: no new fields')
  }
})

test('requestUsage: only true turns it on (1, "yes", {} do not); off adds no report field', async () => {
  for (const v of [1, 'yes', 'true', {}, false, undefined, null]) {
    const w = await world()
    const { fetch, reports } = w.verifying({ requestUsage: v, salt: false })
    await call(fetch)
    assert.equal(td.decode(w.sent[0].body), REQ, String(v))
    assert.ok(!('usageRequested' in reports[0]) && reports[0].receipt.result.usageInjected === true, String(v))
  }
})

// The official openai package: what an application sees with requestUsage. The extra chunk has `choices: []`, as when
// the application sets include_usage itself: code that reads chunk.choices[0] unguarded throws on it (documented), the
// optional-chaining pattern and the .stream() helper do not, and the helper's final completion carries the usage.
// 官方 openai 包：开启 requestUsage 后应用看到什么。多出的块 choices: []，与应用自己设 include_usage 时相同：不加防护地读
// chunk.choices[0] 会在它上面抛错（写进文档），可选链写法与 .stream() 助手不会，助手的最终结果带着用量。
test('requestUsage with the official openai package: create({ stream }) and .stream() run; the usage chunk is visible; the usage is checked', { skip: !OpenAI && 'the openai package is not installed' }, async () => {
  const fake = createFakeUpstream({ models: MODELS.map((m) => m.id) })
  const proxy = createAIProxy({ upstream: { baseUrl: 'http://fake.local/v1' }, fetch: fake.fetch, manifestBase: manifestBase(), signerKey: KEY, models: MODELS, allowHttp: true, rateLimit: false, log: () => {} })
  const service = await createTapeAPI({ dev: true, fetch: (u, i) => proxy.handleRequest(new Request(u, i)) }).resolve({ dev: BASE })
  const reports = [], sent = []
  const fetch = ai.createVerifyingFetch({ service, requestUsage: true, onReport: (r) => reports.push(r), fetch: async (u, i) => { sent.push(td.decode(new Uint8Array(await new Response(i.body).arrayBuffer()))); return proxy.handleRequest(new Request(u, i)) } })
  const oa = new OpenAI({ baseURL: `${BASE}/v1`, apiKey: 'sk-demo', fetch, maxRetries: 0 })
  const chunks = []
  for await (const c of await oa.chat.completions.create({ model: 'demo-chat', stream: true, messages: [{ role: 'user', content: 'hello there' }] })) chunks.push(c)
  assert.match(chunks.map((c) => c.choices?.[0]?.delta?.content ?? '').join(''), /hello there/)
  const usageChunk = chunks.find((c) => c.choices.length === 0)
  assert.ok(usageChunk && usageChunk.usage.prompt_tokens > 0, 'one chunk with choices: [] and the usage')
  assert.throws(() => { for (const c of chunks) void c.choices[0].delta }, TypeError, 'unguarded chunk.choices[0] throws on it')
  assert.match(sent[0], /"stream_options":\{"include_usage":true\}\}[ \t\r\n]{64}$/)
  // The helper. / 助手。
  const final = await oa.chat.completions.stream({ model: 'demo-chat', messages: [{ role: 'user', content: 'helper too' }] }).finalChatCompletion()
  assert.match(final.choices[0].message.content, /helper too/)
  assert.deepEqual(reports.map((r) => [r.ok, r.usageRequested, r.unchecked.some((x) => /^usage/.test(x))]), [[true, true, false], [true, true, false]], reports.map((r) => r.problems.join('; ')).join(' | '))
  assert.equal(final.usage?.prompt_tokens, reports[1].receipt.result.usage.prompt_tokens, 'the final completion carries the usage the receipt states')
  // An application that asks itself: not rewritten again. / 应用自己要了：不再改写。
  for await (const c of await oa.chat.completions.create({ model: 'demo-chat', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'mine' }] })) void c
  assert.equal(reports[2].usageRequested, false)
  assert.equal((sent[2].match(/include_usage/g) || []).length, 1)
})
