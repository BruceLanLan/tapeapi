// FIXED SSE-END (1.0.0–1.4.0): a streamed answer is verified where the stream first ends (its final event, `[DONE]` or the
// upstream closing, whichever comes first; review RC-2), but the verifier took the receipt hash, and let the adapter read,
// after the whole network chunk that carried the end. Events after the end that arrived in that same chunk were hashed and
// read as well, so a stream cut short by an inserted `[DONE]` (OpenAI Chat and Responses) verified when the cut and the rest
// came in one chunk, and failed when they came one event per chunk. The end is now a point in the stream: the scanner keeps
// the hash, event count and offset there (info.digestAtEnd, eventsAtEnd, endOffset), the adapter reads up to it, strict
// passes the stream on up to that point only and closes it, and not strict reports what follows.
// The review of that fix (SSE-EOF, SSE-BOM) found two shapes that clients parse differently from the receipt rule, both
// now fail-closed: an event the stream closes on before its blank line (discarded by the rule, dispatched by the openai
// SDK) and a line that starts with U+FEFF (an unknown field to the rule, a field to the SDKs, which strip a byte order mark
// from every line). These tests replay signed answers, honest or edited on the way, under many cuttings of their bytes (one
// event per chunk, all in one, the end and the rest in one, byte by byte, seeded random cuts, LF and CRLF) and assert that
// the verdict, and in strict mode the bytes handed on, never depend on the cutting. The receipt hash itself (TAPI-21 §3.5:
// every dispatched event of the stream, the sentinel left out) is unchanged.
// FIXED SSE-END（1.0.0–1.4.0）：流式回答在流第一次结束处核验，但核验方取回执哈希、让适配器读取，都是在处理完承载结束点的那一整块
// 之后。同一块里结束之后的事件也被计入哈希、被读到：插入 [DONE] 截断的流（OpenAI Chat 与 Responses）在截断点与其余内容同块到达时
// 核验通过。现在结束是流中的一点：扫描器保留那一点的哈希、事件数与偏移，适配器只读到那里，strict 只转交到这一点并关闭流，非 strict
// 报告其后的内容。对该修复的审查（SSE-EOF、SSE-BOM）又发现两种客户端与回执规则解析不一致的形态，现在都失败关闭：流在空行之前
// 关闭的事件（规则丢弃，openai SDK 分派），以及以 U+FEFF 开头的行（规则视为未知字段，SDK 逐行去掉字节序标记后视为字段）。本测试
// 按多种切分重放签名回答（诚实的或途中被改过的），断言结论以及 strict 下转交的字节都与切分无关。回执哈希本身不变。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createTapeAPI, ai } from '../src/index.js'
import { sseDigestOfPayloads } from '../src/ai.js'
import { createAIProxy } from '../../server/src/ai-proxy.js'
import { createFakeUpstream } from '../../examples/ai-proxy/fake-upstream.mjs'

const te = new TextEncoder(), td = new TextDecoder('utf-8', { ignoreBOM: true })
const fmt = (name) => ai.FORMATS.find((f) => f.name === name)
const scannerFor = (format) => ai.createSseScanner({ sentinel: format.stream.sentinel ?? null, final: format.stream.final ?? null })
const FORMAT_OF = { R: 'openai-responses', C: 'openai-chat', A: 'anthropic-messages' }
const BOM = '﻿'
const LATE = 'an event after the end of the stream is not covered by its receipt'
const UNFINISHED = 'an unfinished event at the close of the stream (no blank line after it) is not covered by its receipt, and some clients dispatch it'
const AMBIGUOUS = 'a line that starts with U+FEFF (a byte order mark) is read differently by different clients: the stream cannot be verified'

// ---- cuttings / 切分 ----
// Seeded, so a failure names a cutting that can be replayed. / 带种子：失败时给出的切分可以重放。
function rng(seed) { let s = seed >>> 0; return (n) => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return (s >>> 8) % n } }
const splitAt = (b, at) => { const out = []; let p = 0; for (const c of at) { if (c > p && c < b.length) { out.push(b.subarray(p, c)); p = c } } out.push(b.subarray(p)); return out.filter((x) => x.length) }
// Events end at a blank line, LF or CRLF. / 事件以空行结束，LF 或 CRLF。
const eventsOf = (s) => s.split(/(?<=\r?\n\r?\n)/)
const isEnd = (e) => /^data: ?\[DONE\]\r?\n\r?\n$/.test(e) || /^event: ?(response\.completed|response\.incomplete|response\.failed|message_stop)\r?\n/.test(e)
function cuttings(text, seed) {
  const b = te.encode(text)
  const ev = eventsOf(text)
  const at = (parts) => { const out = []; let p = 0; for (const x of parts.slice(0, -1)) { p += te.encode(x).length; out.push(p) } return out }
  const endIx = ev.findIndex(isEnd)
  const r = rng(seed)
  const out = [
    ['perEvent', splitAt(b, at(ev))],
    ['whole', [b]],
    // one chunk per event up to the first end marker, then the marker and everything after it in one
    // 第一个结束标记之前每事件一块，然后结束标记与其后的全部内容一块
    ['tail', endIx < 0 ? splitAt(b, at(ev)) : splitAt(b, at([...ev.slice(0, endIx), ev.slice(endIx).join('')]))],
    // the event before the end marker in a chunk of its own, the rest in one / 结束标记前一事件单独一块，其余一块
    ['tail-1', endIx < 1 ? [b] : splitAt(b, [te.encode(ev.slice(0, endIx - 1).join('')).length, te.encode(ev.slice(0, endIx).join('')).length])],
    ['bytewise', splitAt(b, Array.from({ length: b.length - 1 }, (_, k) => k + 1))],
  ]
  for (let i = 0; i < 12; i++) out.push([`random#${seed}.${i}`, splitAt(b, [...new Set(Array.from({ length: 1 + r(16) }, () => 1 + r(b.length - 1)))].sort((x, y) => x - y))])
  return out
}
// Where a stream (as text) first ends, in bytes; the whole length when it never does. / 流第一次结束处的字节偏移；从未结束时为全长。
function endOf(kind, text) {
  const s = scannerFor(fmt(FORMAT_OF[kind])), b = te.encode(text)
  s.push(b)
  return s.info.endOffset ?? b.length
}

// ---- the scanner / 扫描器 ----
// digestAtEnd is the digest of a scanner fed only up to the end, under every cutting, and stays put whatever follows;
// endOffset points just past the end in the chunk that reached it; digest() is still the whole stream's (the receipt rule,
// unchanged). / digestAtEnd 等于只喂到结束处的扫描器的 digest()，在任何切分下都如此；endOffset 指向到达结束的那一块中结束点之后；
// digest() 仍是整条流的（回执规则不变）。
test('FIXED SSE-END: createSseScanner: digestAtEnd / eventsAtEnd / endOffset are the hash, count and place of the first end under every cutting, and do not move with later events in the same chunk', () => {
  const streams = [
    ['openai-chat', 'data: {"a":1}\n\ndata: {"b":2}\n\n: tapeapi-receipt r1\n\n', 'data: [DONE]\n\n', 'data: {"late":1}\n\n: tapeapi-receipt r2\n\ndata: [DONE]\n\n'],
    ['openai-responses', 'event: response.output_text.delta\ndata: {"d":"x"}\n\n: tapeapi-receipt r1\n\n', 'event: response.completed\ndata: {"type":"response.completed"}\n\n', 'data: [DONE]\n\nevent: response.output_text.delta\ndata: {"late":1}\n\n'],
    ['openai-responses', 'event: response.output_text.delta\ndata: {"d":"x"}\n\n: tapeapi-receipt r1\n\n', 'data: [DONE]\n\n', 'event: response.completed\ndata: {"type":"response.completed"}\n\n'],
    ['anthropic-messages', 'event: message_start\ndata: {"m":1}\n\n: tapeapi-receipt r1\n\n', 'event: message_stop\ndata: {"type":"message_stop"}\n\n', 'event: content_block_delta\ndata: {"late":1}\n\n'],
  ]
  for (const [name, head, end, rest] of streams) for (const nl of [(s) => s, crlf]) {
    const format = fmt(name)
    const ref = scannerFor(format); ref.push(te.encode(nl(head + end)))
    const whole = scannerFor(format); whole.push(te.encode(nl(head + end + rest))); whole.end()
    assert.notEqual(ref.digest(), whole.digest(), `${name}: the rest is hashed into the whole stream's digest`)
    assert.equal(whole.info.endOffset, te.encode(nl(head + end)).length, `${name}: endOffset in one chunk`)
    // The receipt rule over the whole stream is unchanged: the digest of every dispatched event's data, sentinel left out.
    // 整条流的回执规则不变：全部已分派事件数据的摘要，sentinel 除外。
    assert.equal(whole.digest(), ai.scanSse(te.encode(nl(head + end + rest)), { format }).responseSha256)
    for (const [cut, parts] of cuttings(nl(head + end + rest), 7)) {
      const s = scannerFor(format)
      let seen = null, before = 0
      for (const p of parts) {
        const open = s.info.receiptsAtEnd === null
        s.push(p)
        if (open && s.info.receiptsAtEnd !== null) {
          // The bytes before this chunk plus endOffset are the stream up to its end; a CR that ends the blank line at the
          // end of a chunk leaves its LF for the next one. / 此前各块的字节加 endOffset 即到结束为止的流；块末的 CR 结束空行时，LF 留在下一块。
          const upTo = before + s.info.endOffset
          const want = te.encode(nl(head + end)).length
          assert.ok(upTo === want || (upTo === want - 1 && s.info.endOffset === p.length && s.state().pendingCR), `${name} ${cut}: endOffset ${upTo} vs ${want}`)
        }
        before += p.length
        if (s.info.digestAtEnd !== null) {
          if (seen === null) seen = s.info.digestAtEnd
          assert.equal(s.info.digestAtEnd, seen, `${name} ${cut}: digestAtEnd moved`)
        } else assert.deepEqual([s.info.eventsAtEnd, s.info.endOffset], [null, null])
      }
      s.end()
      assert.equal(s.info.digestAtEnd, ref.digest(), `${name} ${cut}: digestAtEnd is the digest at the end`)
      assert.equal(s.info.eventsAtEnd, ref.info.events, `${name} ${cut}`)
      assert.equal(s.info.receiptsAtEnd, 1, `${name} ${cut}`)
      assert.ok(s.info.events > s.info.eventsAtEnd, `${name} ${cut}: events after the end are counted`)
      assert.equal(s.digest(), whole.digest(), `${name} ${cut}: digest() is still the whole stream's`)
    }
  }
  // No end (the upstream closed first): null, and the whole stream's digest is the one to check. / 没有结束：为 null。
  const c = scannerFor(fmt('openai-chat'))
  c.push(te.encode('data: {"a":1}\n\n: tapeapi-receipt r1\n\ndata: [DO')); c.end()
  assert.deepEqual([c.info.receiptsAtEnd, c.info.eventsAtEnd, c.info.digestAtEnd, c.info.endOffset], [null, null, null, null])
  // The sentinel is never hashed: with nothing after it, the digest at [DONE] is the whole stream's. / sentinel 从不计入。
  const d = scannerFor(fmt('openai-chat')); d.push(te.encode('data: {"a":1}\n\ndata: [DONE]\n\n')); d.end()
  assert.equal(d.info.digestAtEnd, d.digest())
  assert.equal(d.info.digestAtEnd, sseDigestOfPayloads(['{"a":1}', '[DONE]'], { sentinel: '[DONE]' }))
})

// FIXED SSE-BOM: a line that starts with U+FEFF, anywhere but at the very start of the stream, is counted (however it is
// cut); the stream's own leading mark is not, nor are a mark in the middle of a line or bytes that only begin like one.
// FIXED SSE-BOM：流最开头之外以 U+FEFF 开头的行被计数（无论怎样切分）；流开头自己的标记、行中间的标记、只是开头像标记的字节不计。
test('FIXED SSE-BOM: createSseScanner counts the lines that start with U+FEFF other than at the very start of the stream (info.ambiguous, ambiguousAtEnd)', () => {
  const count = (text, parts) => {
    const s = scannerFor(fmt('openai-chat'))
    const b = typeof text === 'string' ? te.encode(text) : text
    for (const p of parts ? parts(b) : [b]) s.push(p)
    s.end()
    return s.info.ambiguous
  }
  const byte = (b) => Array.from(b, (x) => Uint8Array.of(x))
  const cases = [
    [`${BOM}data: {"a":1}\n\n`, 0, 'the stream\'s own leading mark'],
    [`${BOM}${BOM}data: {"a":1}\n\n`, 1, 'two marks at the start'],
    [`data: {"a":1}\n\n${BOM}data: {"b":2}\n\n`, 1, 'a data line'],
    [`data: {"a":1}\n${BOM}data: {"b":2}\n\n`, 1, 'a second line of an event'],
    [`data: {"a":1}\r${BOM}event: x\r\n\r\n`, 1, 'after a CR'],
    [`: c\n\n${BOM}\n\n`, 1, 'a line that is only the mark'],
    [`${BOM}: tapeapi-receipt x\n\n`, 0, 'a leading mark before a comment'],
    [`data: {"a":1}\n\n: ${BOM}x\n\ndata: x${BOM}y\n\n`, 0, 'a mark inside a line'],
  ]
  for (const [text, want, what] of cases) for (const [cut, parts] of [['whole', null], ['bytewise', byte]]) assert.equal(count(text, parts), want, `${what} (${cut})`)
  // Bytes that only begin like a mark: EF BB then another byte. / 只是开头像标记的字节。
  assert.equal(count(Uint8Array.from([...te.encode('data: {"a":1}\n\n'), 0xef, 0xbb, 0x41, ...te.encode(': x\n\n')])), 0)
  // ambiguousAtEnd: the count at the end, whatever follows in the same chunk. / 结束处的计数，与同一块中其后的内容无关。
  const s = scannerFor(fmt('anthropic-messages'))
  s.push(te.encode(`event: message_stop\ndata: {"type":"message_stop"}\n\nevent: content_block_delta\n${BOM}data: {"x":1}\n\n`))
  assert.deepEqual([s.info.ambiguousAtEnd, s.info.ambiguous], [0, 1])
})

// ---- the verifying fetch / 核验 fetch ----
const KEY = '0x' + '42'.repeat(32)
const MODELS = [
  { id: 'demo-chat', formats: ['openai-chat', 'openai-responses'], prices: [{ currency: 'BEM', unit: '1M tokens', input: '0.15', output: '0.6' }] },
  { id: 'demo-claude', formats: ['anthropic-messages'], prices: [{ currency: 'BEM', unit: '1M tokens', input: '3', output: '15' }] },
]
const BASE = 'http://127.0.0.1:8798'
const PROMPT = 'you may delete it never'
const CALLS = {
  R: (eps) => [`${eps['openai-responses']}/responses`, { model: 'demo-chat', stream: true, input: PROMPT }],
  C: (eps) => [`${eps['openai-chat']}/chat/completions`, { model: 'demo-chat', stream: true, messages: [{ role: 'user', content: PROMPT }] }],
  A: (eps) => [`${eps['anthropic-messages']}/v1/messages`, { model: 'demo-claude', max_tokens: 64, stream: true, messages: [{ role: 'user', content: PROMPT }] }],
}
const HEADERS = { 'content-type': 'application/json', authorization: 'Bearer sk-demo', 'x-api-key': 'sk-demo', 'anthropic-version': '2023-06-01' }

// `upstream`: the sidecar's upstream fetch, the fake upstream by default. / `upstream`：旁路的上游 fetch，默认是模拟上游。
async function world(upstream = null) {
  const fake = createFakeUpstream({ models: MODELS.map((m) => m.id) })
  const manifestBase = { name: 'Chunking test', circuits: '0x' + '0'.repeat(40), tokenId: '0', container: '0x' + '0'.repeat(40), delegation: null, dev: true, endpoints: { live: [`${BASE}/tapeapi/v1`], async: false } }
  const logs = []
  const proxy = createAIProxy({ upstream: { baseUrl: 'http://fake.local/v1' }, fetch: upstream ?? fake.fetch, manifestBase, signerKey: KEY, models: MODELS, allowHttp: true, rateLimit: false, log: (l) => logs.push(l) })
  await proxy.ready
  const api = createTapeAPI({ dev: true, fetch: (u, i) => proxy.handleRequest(new Request(u, i)) })
  const service = await api.resolve({ dev: BASE })
  const eps = Object.fromEntries(service.manifest.ai.endpoints.map((e) => [e.format, e.baseUrl]))
  return { proxy, api, service, eps, logs }
}
async function signed(w, kind) {
  const [url, body] = CALLS[kind](w.eps)
  const r = await w.proxy.handleRequest(new Request(url, { method: 'POST', headers: HEADERS, body: JSON.stringify(body) }))
  assert.equal(r.status, 200)
  const captured = { status: r.status, headers: new Headers(r.headers) }
  captured.headers.delete('content-length')
  return { text: Buffer.from(await r.arrayBuffer()).toString('utf8'), captured }
}

// One signed answer per case, replayed under every cutting. The salt is off: a salted request differs on every replay, and
// its receipt would then not be the one captured (requestSha256). Read raw, to the end, as a client that does not stop at
// the end would. `fail`: error the body after the last chunk instead of closing it.
// 每个用例一份签名回答，在每种切分下重放。不加盐：加盐的请求每次重放都不同，捕获的回执就对不上。按原始字节读到底（如同不在结束处
// 停止读取的客户端）。`fail`：最后一块之后以错误结束正文，而不是正常关闭。
// `after`: what the body does after its last chunk: 'close' (default), 'reset' (errors) or 'hold' (stays open, sends nothing).
// `after`：正文在最后一块之后做什么：'close'（默认）、'reset'（出错）或 'hold'（保持连接、不再发送）。
async function replay(w, { strict, kind, parts, captured, after = 'close' }) {
  const reports = []
  const vf = ai.createVerifyingFetch({ api: w.api, service: w.service, salt: false, strict, onReport: (r) => reports.push(r), fetch: async () => {
    let i = 0
    const body = new ReadableStream({ pull(c) { if (i < parts.length) c.enqueue(parts[i++]); else if (after === 'reset') c.error(new TypeError('socket reset')); else if (after === 'close') c.close() } })
    return new Response(body, { status: captured.status, headers: captured.headers })
  } })
  const [url, body] = CALLS[kind](w.eps)
  const res = await vf(url, { method: 'POST', headers: HEADERS, body: JSON.stringify(body) })
  let got = '', threw = null
  const rd = res.body.getReader(), dec = new TextDecoder('utf-8', { ignoreBOM: true })   // one per answer: no state carried over / 每个回答一个，不带入上一个的状态
  try { for (;;) { const { done, value } = await rd.read(); if (done) break; got += dec.decode(value, { stream: true }) } } catch (e) { threw = e?.code ?? String(e) }
  return { reports, got, threw }
}
const verdictOf = (r) => ({ threw: r.threw, anyFail: r.reports.some((x) => !x.ok), problems: [...new Set(r.reports.flatMap((x) => x.problems))].sort() })

const RECEIPT = /: ?tapeapi-receipt [A-Za-z0-9_-]*\n\n/
const receiptToStart = (s) => { const m = RECEIPT.exec(s); return m[0] + s.replace(RECEIPT, '') }
const beforeWord = (word, what) => (s) => { const ev = eventsOf(s); const i = ev.findIndex((e) => e.includes(`" ${word}"`)); assert.ok(i > 0, word); ev.splice(i, 0, what); return ev.join('') }
const DONE = 'data: [DONE]\n\n'
const lateChat = 'data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"demo-chat-late","choices":[{"index":0,"delta":{"content":" EXTRA"},"finish_reason":null}]}\n\n'
const lateResponses = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"x","output_index":0,"content_index":0,"delta":" EXTRA","logprobs":[]}\n\n'
const lateAnthropic = 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" EXTRA"}}\n\n'
const unterminated = (late) => late.replace(/\n\n$/, '')
const bomData = (late) => late.replace(/(^|\n)data:/, `$1${BOM}data:`)
const LATE_OF = { R: lateResponses, C: lateChat, A: lateAnthropic }
const stripDone = (s) => s.replace(/data: \[DONE\]\n\n$/, '')
// [kind, name, edit, verdict in strict mode, verdict not strict ('ok', or the problem expected among the reports)]
// [格式, 名称, 改动, strict 下的结论, 非 strict 下的结论（'ok'，或报告中应出现的问题）]
const CASES = [
  ...['R', 'C', 'A'].map((k) => [k, 'honest', (s) => s, 'ok', 'ok']),
  ['R', 'honest, [DONE] after response.completed (optional for Responses)', (s) => s + DONE, 'ok', 'ok'],
  ...['R', 'C', 'A'].map((k) => [k, 'a junk receipt comment after the end', (s) => s + ': tapeapi-receipt AAAA\n\n', 'ok', 'ok']),
  ...['R', 'C', 'A'].map((k) => [k, 'the receipt twice, at the start too', (s) => RECEIPT.exec(s)[0] + s, 'ok', 'ok']),
  ['C', 'the upstream closes before [DONE] (the sentinel is not hashed)', stripDone, 'ok', 'ok'],
  ['A', 'the upstream closes before message_stop', (s) => s.replace(/event: message_stop\n[^\n]*\n\n$/, ''), 'fail', 'responseSha256'],
  ['R', 'R-a: [DONE] before response.completed (receipt kept before it)', (s) => s.replace(/event: response\.completed\n/, `${DONE}event: response.completed\n`), 'fail', 'responseSha256'],
  ['R', 'R-b: receipt to the start, [DONE] before " never"', (s) => beforeWord('never', DONE)(receiptToStart(s)), 'fail', 'responseSha256'],
  ['C', 'C-b: receipt to the start, [DONE] before " never"', (s) => beforeWord('never', DONE)(receiptToStart(s)), 'fail', 'responseSha256'],
  ['A', 'A-b: receipt to the start, an extra message_stop before " never"', (s) => beforeWord('never', 'event: message_stop\ndata: {"type":"message_stop"}\n\n')(receiptToStart(s)), 'fail', 'responseSha256'],
  ['R', 'R-c: receipt to the start, the first delta renamed response.completed', (s) => receiptToStart(s).replace('event: response.output_text.delta\n', 'event: response.completed\n'), 'fail', 'responseSha256'],
  ['A', 'A-c: receipt to the start, the first text delta renamed message_stop', (s) => receiptToStart(s).replace(/event: content_block_delta\n(data: [^\n]*text_delta)/, 'event: message_stop\n$1'), 'fail', 'responseSha256'],
  // After the end: strict passes the stream on up to it and closes; not strict reports a dispatched event.
  // 结束之后：strict 只转交到结束处并关闭；非 strict 报告被分派的事件。
  ...['R', 'C', 'A'].map((k) => [k, `${k}-d: an event appended after the end`, (s) => s + LATE_OF[k], 'ok', LATE]),
  ['R', 'R-d\': an event after response.completed and [DONE]', (s) => s + DONE + lateResponses, 'ok', LATE],
  ['C', 'a comment, a data-less event and a second [DONE] after the end', (s) => s + ': hello\n\nevent: injected\n\n' + DONE, 'ok', 'ok'],
  // SSE-EOF: an event left without its blank line when the stream closes. / 流关闭时缺少空行的事件。
  ['C', 'EOF: [DONE] stripped, an unterminated chunk appended', (s) => stripDone(s) + unterminated(lateChat), 'fail', UNFINISHED],
  ['C', 'EOF: [DONE] stripped, an unterminated chunk with one line end', (s) => stripDone(s) + unterminated(lateChat) + '\n', 'fail', UNFINISHED],
  ['C', 'EOF: [DONE] stripped, a data-less event left open', (s) => stripDone(s) + 'event: x\n', 'fail', UNFINISHED],
  ['R', 'EOF: an unterminated delta after response.completed', (s) => s + unterminated(lateResponses), 'ok', UNFINISHED],
  ['A', 'EOF: an unterminated delta after message_stop', (s) => s + unterminated(lateAnthropic), 'ok', UNFINISHED],
  // SSE-BOM: a line that starts with U+FEFF. / 以 U+FEFF 开头的行。
  ...['R', 'C', 'A'].map((k) => [k, `BOM: a data line led by U+FEFF inserted before " never"`, beforeWord('never', bomData(LATE_OF[k])), 'fail', AMBIGUOUS]),
  ['A', 'BOM: a data line led by U+FEFF after message_stop', (s) => s + bomData(lateAnthropic), 'ok', AMBIGUOUS],
  ['C', 'BOM: a comment led by U+FEFF before the receipt', (s) => s.replace(RECEIPT, (m) => `${BOM}: hi\n\n${m}`), 'fail', AMBIGUOUS],
]
const crlf = (s) => s.replace(/\n/g, '\r\n')

for (const strict of [true, false]) {
  test(`FIXED SSE-END, SSE-EOF, SSE-BOM: createVerifyingFetch ${strict ? 'strict' : 'not strict'}: every shape gets the same verdict under every cutting (one event per chunk, whole, tail, byte by byte, random; LF and CRLF)${strict ? ', and exactly the stream up to its end is handed on' : ', and every byte is handed on'}`, async () => {
    const w = await world()
    let seed = strict ? 1000 : 2000
    for (const [kind, name, edit, inStrict, notStrict] of CASES) for (const [nlName, nl] of [['LF', (s) => s], ['CRLF', crlf]]) {
      const what = `${kind} | ${name} | ${nlName}`
      const { text: raw, captured } = await signed(w, kind)
      const text = nl(edit(raw))
      const want = strict ? inStrict : notStrict
      const upToEnd = td.decode(te.encode(text).subarray(0, endOf(kind, text)))
      let ref = null
      for (const [cut, parts] of cuttings(text, seed++)) {
        const v = await replay(w, { strict, kind, parts, captured })
        const verdict = verdictOf(v)
        if (want === 'ok') {
          assert.deepEqual(verdict, { threw: null, anyFail: false, problems: [] }, `${what} | ${cut}: must verify`)
          assert.ok(v.reports.length >= 1, `${what} | ${cut}: reported`)
        } else {
          assert.equal(verdict.anyFail, true, `${what} | ${cut}: must fail`)
          assert.equal(verdict.threw, strict ? 'RECEIPT_INVALID' : null, `${what} | ${cut}`)
          if (want !== 'fail') assert.ok(verdict.problems.some((p) => p.includes(want)), `${what} | ${cut}: ${verdict.problems}`)
        }
        // Strict hands on the stream up to its end and nothing after it; not strict hands on every byte.
        // strict 只转交到结束为止的流，其后的一概不转交；非 strict 转交每个字节。
        if (!strict) assert.equal(v.got, text, `${what} | ${cut}: not strict holds nothing back`)
        // (a cut between the CR and LF of the blank line that ends the stream ends it at the CR: the LF is not waited for)
        // （切在结束空行的 CR 与 LF 之间时，流在 CR 处结束：不等那个 LF）
        else if (want === 'ok') assert.ok(v.got === upToEnd || (upToEnd.endsWith('\r\n') && v.got === upToEnd.slice(0, -1)), `${what} | ${cut}: strict hands on the stream up to its end`)
        else assert.ok(upToEnd.startsWith(v.got), `${what} | ${cut}: nothing past the end: ${JSON.stringify(v.got.slice(-80))} / ${JSON.stringify(upToEnd.slice(v.got.length - 80, v.got.length + 10))}`)
        if (ref === null) ref = { cut, verdict }
        else assert.deepEqual(verdict, ref.verdict, `${what}: the verdict under ${cut} differs from ${ref.cut}`)
      }
    }
  })
}

// The adapter reads up to the end only: a late chunk naming another model, in the same network chunk as [DONE], does not
// change what the receipt is checked against; the late chunk is reported on its own. / 适配器只读到结束处：与 [DONE] 同一块的、
// 写着别的模型的迟到块不改变回执所核对的内容；迟到块单独报告。
test('FIXED SSE-END: not strict, the receipt is checked against the answer up to the end even when a later event shares its chunk; the late event is reported once', async () => {
  const w = await world()
  const { text: raw, captured } = await signed(w, 'C')
  const text = raw + lateChat + lateChat
  for (const [cut, parts] of cuttings(text, 31)) {
    const v = await replay(w, { strict: false, kind: 'C', parts, captured })
    assert.deepEqual(v.reports.map((x) => [x.ok, x.problems]), [[true, []], [false, [LATE]]], cut)
    assert.equal(v.reports[0].receipt.result.model, 'demo-chat', cut)
  }
})

// Strict: when the blank line that ends the stream is a CR at the end of a chunk, the stream ends right there. Waiting for
// the LF that may follow hung when the upstream kept the connection open and sent nothing more (review round 2); every
// client dispatches the event at a bare CR followed by the end of the body, so the LF is dropped. Holding the connection,
// resetting it or sending the LF all end the same way, deterministically: a hang fails at the guard's cap.
// strict：结束流的空行是某块末尾的 CR 时，流就在那里结束。等待可能随后的 LF，在上游保持连接却不再发送时会挂住（第二轮审查）；裸 CR
// 之后正文结束，各客户端都会分派该事件，所以 LF 丢弃。保持连接、重置连接或发来 LF，结果都一样，且是确定的：挂住会在保护上限处失败。
test('FIXED SSE-END: strict, the blank line that ends the stream is a CR at the end of a chunk: the stream ends at the CR whether the upstream then holds, resets or sends the LF', async () => {
  const w = await world()
  const guard = (p, what) => { let t; return Promise.race([p, new Promise((_, fail) => { t = setTimeout(() => fail(new Error(`${what}: hung`)), 10_000) })]).finally(() => clearTimeout(t)) }
  for (const kind of ['R', 'C', 'A']) for (const [nl, shape] of [['CRLF', crlf], ['CR', (s) => s.replace(/\n/g, '\r')], ['LF+CR', (s) => s.replace(/\n\n/g, '\n\r')]]) {
    const { text: raw, captured } = await signed(w, kind)
    const text = shape(raw + LATE_OF[kind])
    const b = te.encode(text)
    // the end, cut at the CR of its blank line / 结束处，切在其空行的 CR 之后
    const s = scannerFor(fmt(FORMAT_OF[kind])); s.push(b)
    const atCR = nl === 'CRLF' ? s.info.endOffset - 1 : s.info.endOffset
    assert.equal(b[atCR - 1], 0x0d, `${kind} ${nl}`)
    const upToCR = td.decode(b.subarray(0, atCR))
    for (const after of ['hold', 'reset', 'close']) {
      const parts = after === 'close' ? [b.subarray(0, atCR), b.subarray(atCR)] : [b.subarray(0, atCR)]
      const v = await guard(replay(w, { strict: true, kind, parts, captured, after }), `${kind} ${nl} ${after}`)
      assert.deepEqual([v.threw, v.reports.map((r) => r.ok), v.got], [null, [true], upToCR], `${kind} ${nl} ${after}`)
    }
  }
})

// ---- offline: verifyUsageReceipt({ responseBytes }) / 离线核验 ----
// FIXED SSE-BOM, SSE-EOF (review round 2): the offline check hashed the whole stream and passed a signed stream with a
// data line led by U+FEFF inserted, or with an unterminated event appended, although clients show content the hash does
// not cover. It now reports both shapes (scanSse returns `ambiguous` and `unfinished`). Honest streams still verify, and a
// stream with events after its end keeps its §3.5 meaning: they are hashed, so the hash no longer matches.
// 离线核验原先对整条流取哈希，插入以 U+FEFF 开头的 data 行、或追加未结束事件的签名流都能通过，尽管客户端会显示哈希不覆盖的内容。
// 现在报告这两种形态（scanSse 返回 ambiguous 与 unfinished）。诚实的流照常通过；结束之后还有事件的流保持 §3.5 的语义：它们计入
// 哈希，所以哈希不再一致。
test('FIXED SSE-BOM, SSE-EOF: offline verifyUsageReceipt({ responseBytes }) reports a line led by U+FEFF and an unfinished event at the close; honest streams verify; events after the end keep their §3.5 meaning', async () => {
  const w = await world()
  const offline = (kind, text) => {
    const format = fmt(FORMAT_OF[kind])
    const sc = ai.scanSse(text, { format })
    const [url, body] = CALLS[kind](w.eps)
    // the last receipt that decodes (a junk comment is skipped, as the clients do) / 最后一个能解码的回执（与客户端一样跳过垃圾注释）
    const envelope = sc.receipts.map((x) => { try { return ai.decodeReceiptHeader(x) } catch { return null } }).filter(Boolean).at(-1)
    return { sc, v: ai.verifyUsageReceipt({ envelope, manifest: w.service.manifest, requestBytes: JSON.stringify(body), responseBytes: text, stream: true, path: new URL(url).pathname, status: 200 }) }
  }
  for (const kind of ['R', 'C', 'A']) {
    const { text: raw } = await signed(w, kind)
    for (const [what, edit, want] of [
      ['honest', (s) => s, []],
      ['honest, CRLF', crlf, []],
      ['a junk receipt comment after the end', (s) => s + ': tapeapi-receipt AAAA\n\n', []],
      ['a data line led by U+FEFF', beforeWord('never', bomData(LATE_OF[kind])), [AMBIGUOUS]],
      ['an unterminated event appended', (s) => (kind === 'C' ? stripDone(s) : s) + unterminated(LATE_OF[kind]), [UNFINISHED]],
      ['an event after the end (hashed by §3.5)', (s) => s + LATE_OF[kind], ['responseSha256 does not match the response that was received']],
    ]) {
      const { sc, v } = offline(kind, edit(raw))
      // the shapes leave the hash as it was: only the shape is reported; a late event also changes what the answer reports
      // 形态不改变哈希：只报告形态；结束后的事件还会改变回答里读到的内容
      if (want[0]?.startsWith('responseSha256')) assert.ok(v.problems.includes(want[0]), `${kind} ${what}: ${v.problems}`)
      else assert.deepEqual(v.problems, want, `${kind} ${what}`)
      assert.equal(v.ok, want.length === 0, `${kind} ${what}`)
      assert.equal(typeof sc.ambiguous, 'number'); assert.equal(typeof sc.unfinished, 'boolean')
    }
  }
  {
    // Honest streams from the sidecar over an upstream that ends without [DONE]: the receipt line at the end is no
    // unfinished event. / 上游不发 [DONE] 时旁路产出的诚实流：末尾的回执行不算未结束事件。
    let body = UPSTREAM.clean
    const w2 = await world(async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    const { text } = await signed(w2, 'C')
    const sc = ai.scanSse(text, { format: fmt('openai-chat') })
    assert.deepEqual([sc.ambiguous, sc.unfinished], [0, false])
    body = UPSTREAM.midEvent
    const cut = await signed(w2, 'C')
    assert.equal(ai.scanSse(cut.text, { format: fmt('openai-chat') }).unfinished, true, 'cut mid-event: refused, as documented')
  }
})

// ---- the sidecar's own streams (regression for the fail-closed predicates) / 旁路自己产出的流（失败关闭判据的回归） ----
// The reference sidecar over an upstream that streams these Chat bodies: (a) clean events and no [DONE], so the receipt is
// one comment line at the end with no blank line after it, which must still verify under every cutting; (b) cut off in the
// middle of an event, the receipt line after it: some clients would dispatch that event, so it is not verified (a known
// cost of SSE-EOF); (c) a data line led by U+FEFF: the sidecar signs nothing (SSE-BOM).
// 参考旁路，上游流式返回以下 Chat 正文：(a) 事件完整、没有 [DONE]，回执是末尾的一行注释，其后没有空行，在任何切分下都必须核验通过；
// (b) 在事件中途断开，回执行在其后：有些客户端会分派那个事件，因此不通过核验（SSE-EOF 的已知代价）；(c) 一行以 U+FEFF 开头的
// data：旁路不签名。
const chunk = (content, finish = null) => `data: {"id":"chatcmpl-up1","object":"chat.completion.chunk","created":1,"model":"demo-chat","choices":[{"index":0,"delta":${content === null ? '{}' : JSON.stringify({ content })},"finish_reason":${finish ? JSON.stringify(finish) : 'null'}}]}\n\n`
const usage = 'data: {"id":"chatcmpl-up1","object":"chat.completion.chunk","created":1,"model":"demo-chat","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n'
const UPSTREAM = {
  clean: chunk('Hello') + chunk(' world') + chunk(null, 'stop') + usage,
  midEvent: chunk('Hello') + chunk(' world').slice(0, 60),
  bom: chunk('Hello') + bomData(chunk(' INJECTED')) + chunk(null, 'stop') + usage + DONE,
}
test('FIXED SSE-EOF, SSE-BOM: the sidecar\'s own streams: a receipt line at the end verifies under every cutting; a stream cut mid-event is not verified; a stream with a line led by U+FEFF gets no receipt', async () => {
  let body = null
  const w = await world(async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
  for (const [name, upstream] of Object.entries(UPSTREAM)) {
    body = upstream
    const { text, captured } = await signed(w, 'C')
    if (name === 'clean') assert.match(text, /\n: tapeapi-receipt [A-Za-z0-9_-]+\n$/, 'one comment line at the end, no blank line after it')
    if (name === 'midEvent') assert.match(text, /\n: tapeapi-receipt [A-Za-z0-9_-]+\n$/)
    if (name === 'bom') {
      assert.doesNotMatch(text, /tapeapi-receipt/, 'no receipt for a stream that clients read differently')
      assert.equal(text, upstream.replace(usage, ''), 'the bytes are passed on as they are (less the usage chunk the sidecar asked for)')
      assert.ok(w.logs.some((l) => /starts with U\+FEFF/.test(l)))
    }
    for (const strict of [true, false]) {
      let ref = null
      for (const [cut, parts] of cuttings(text, 77)) {
        const v = await replay(w, { strict, kind: 'C', parts, captured })
        const verdict = verdictOf(v)
        if (name === 'clean') assert.deepEqual(verdict, { threw: null, anyFail: false, problems: [] }, `${name} strict=${strict} ${cut}`)
        else {
          assert.equal(verdict.threw, strict ? 'RECEIPT_INVALID' : null, `${name} strict=${strict} ${cut}`)
          assert.ok(verdict.problems.includes(name === 'bom' ? AMBIGUOUS : UNFINISHED), `${name} strict=${strict} ${cut}: ${verdict.problems}`)
        }
        if (ref === null) ref = { cut, verdict }
        else assert.deepEqual(verdict, ref.verdict, `${name} strict=${strict}: ${cut} differs from ${ref.cut}`)
      }
    }
  }
})
