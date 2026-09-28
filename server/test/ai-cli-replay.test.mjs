// The sidecar replaying what the real Claude Code and Codex CLIs sent, and what the upstream streamed back, captured by
// examples/ai-proxy/e2e-cli.mjs --save-fixtures (sdk/test/fixtures/ai-cli.json): the exact header sets (anthropic-beta,
// anthropic-version, x-api-key; authorization, Codex's session headers), paths with their query (?beta=true), request
// bodies of the CLIs' shape (tools, thinking, tool results) and full upstream streams with thinking, tool_use,
// reasoning and function_call items. Each is replayed in several chunkings; the client must get the upstream's events
// unchanged plus one receipt comment right before the final event, and the receipt must verify. No CLI, no network.
// 旁路重放真实 Claude Code 与 Codex CLI 发出的请求与上游流回的内容（由 e2e-cli.mjs --save-fixtures 录下）：确切的请求头集合、
// 带查询串的路径、CLI 形状的请求体，以及含 thinking、tool_use、reasoning、function_call 的完整上游流。每个都按多种切块方式重放；
// 客户端必须原样收到上游的事件，外加最终事件之前的一个回执注释，回执必须能核验。不需要 CLI，不联网。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createAIProxy } from '../src/ai-proxy.js'
import { ai } from '@tapeapi/sdk'
// pricesOf is not in the public face (review RC-7): the implementation module. / pricesOf 不在公开门面里：用实现模块。
import { pricesOf } from '../../sdk/src/ai.js'
import { createFakeUpstream } from '../../examples/ai-proxy/fake-upstream.mjs'

const FIX = JSON.parse(readFileSync(new URL('../../sdk/test/fixtures/ai-cli.json', import.meta.url), 'utf8'))
const KEY = '0x' + '42'.repeat(32)
const BASE = 'https://ai.example'
const UP = 'https://upstream.example/v1'
const MODELS = [
  { id: FIX.models.claude, formats: ['anthropic-messages'], prices: [{ currency: 'BEM', unit: '1M tokens', input: '3', output: '15', cacheRead: '0.3', cacheWrite: '3.75' }] },
  { id: FIX.models.codex, formats: ['openai-responses'], prices: [{ currency: 'BEM', unit: '1M tokens', input: '1.25', output: '10', cacheRead: '0.125' }] },
]
const manifestBase = () => ({ name: 'Replay', circuits: '0xe02c26c7432A7121168AA9B610DE24eCf9a1a414', tokenId: '11', container: '0x1b2A657BcBa9D3229f57aC2f4FcbEE2AA756aAe8', delegation: null, endpoints: { live: [`${BASE}/tapeapi/v1`], async: false } })
const te = new TextEncoder()
const RECEIPT_BLOCK = /: tapeapi-receipt [A-Za-z0-9_-]+\n\n/g

function chunked(bytes, size) {
  let i = 0
  return new ReadableStream({ pull(c) { if (i >= bytes.length) return c.close(); c.enqueue(bytes.slice(i, i + size)); i += size } })
}
// What a spec-compliant client dispatches: [{ event, data }]. / 符合规范的客户端所分派的事件。
function events(text) {
  const out = []
  let data = null, event = ''
  for (const line of text.split(/\r\n|\r|\n/).slice(0, -1)) {
    if (line === '') { if (data !== null) out.push({ event, data: data.join('\n') }); data = null; event = ''; continue }
    if (line.startsWith(':')) continue
    const k = line.indexOf(':'), field = k < 0 ? line : line.slice(0, k)
    let v = k < 0 ? '' : line.slice(k + 1)
    if (v.startsWith(' ')) v = v.slice(1)
    if (field === 'data') (data ??= []).push(v); else if (field === 'event') event = v
  }
  return out
}
function proxyWith(fixture, size, seen) {
  return createAIProxy({
    upstream: { baseUrl: UP }, manifestBase: manifestBase(), signerKey: KEY, models: MODELS, log: () => {}, rateLimit: false,
    fetch: async (url, init) => {
      seen.push({ url, headers: Object.fromEntries(new Headers(init.headers)), body: init.body })
      const u = fixture.upstream
      return new Response(chunked(te.encode(u.body), size), { status: u.status, headers: u.headers })
    },
  })
}
const requestOf = (f) => new Request(BASE + f.path + f.search, { method: f.method, headers: f.headers, body: f.body ?? undefined })
const FINAL = { 'anthropic-messages': 'event: message_stop', 'openai-responses': 'event: response.completed' }

const posts = FIX.calls.filter((c) => c.method === 'POST' && c.upstream)
test('the fixture holds both CLIs: streamed, tool-use and thinking/reasoning turns', () => {
  for (const cli of ['claude', 'codex']) {
    const mine = posts.filter((c) => c.cli === cli)
    assert.ok(mine.length >= 4, `${cli}: at least 4 metered calls`)
    assert.ok(mine.some((c) => /tool_use|function_call/.test(c.upstream.body)), `${cli}: a tool call`)
    assert.ok(mine.some((c) => /thinking_delta|reasoning_summary_text/.test(c.upstream.body)), `${cli}: a thinking / reasoning block`)
    assert.ok(mine.some((c) => /tool_result|function_call_output/.test(c.body)), `${cli}: a request carrying a tool result`)
    assert.ok(mine.some((c) => c.upstream.status >= 500), `${cli}: an upstream error the CLI retried`)
    assert.ok(mine.some((c) => /event-stream/.test(c.upstream.headers['content-type']) && !/response\.completed|message_stop/.test(c.upstream.body)), `${cli}: a stream cut short`)
  }
  // After a stream that ended in an error event, Claude Code retried WITHOUT streaming. / 流以错误事件结束后，Claude Code 改用非流式重试。
  assert.ok(posts.some((c) => c.cli === 'claude' && JSON.parse(c.body).stream === false && c.upstream.status === 200), 'claude: the non-streaming fallback')
  assert.ok(posts.filter((c) => c.cli === 'codex').every((c) => JSON.parse(c.body).stream === true), 'codex always streams')
})

for (const f of posts) {
  const isStream = /event-stream/.test(f.upstream.headers['content-type'] || '')
  const format = ai.formatFor(f.method, f.path)
  const hasFinal = isStream && f.upstream.body.includes(`${FINAL[format.name]}\n`)
  const what = !isStream ? `JSON ${f.upstream.status}, receipt header` : hasFinal ? 'events unchanged, one receipt before the final event' : 'a stream cut short, receipt appended'
  test(`${f.cli} / ${f.turn}: ${f.method} ${f.path}${f.search} -> headers forwarded as the CLI needs, ${what}, verified`, async () => {
    assert.ok(format, 'a metered path')
    for (const size of [1, 3, 17, 256, 1 << 20]) {
      const seen = []
      const p = proxyWith(f, size, seen)
      const res = await p.handleRequest(requestOf(f), { clientIp: '127.0.0.1' })
      assert.equal(res.status, f.upstream.status)
      assert.equal(seen.length, 1)
      assert.equal(seen[0].url, UP + f.path.slice(3) + f.search, 'the query (?beta=true) goes upstream')
      // The recorded run predates the wider allow-list (it forwarded f.upstream.forwarded only); now the CLI's identity and
      // session headers go too, verbatim. / 录制时的允许列表更窄；现在 CLI 的身份与会话头也原样转发。
      const sent = Object.fromEntries(f.headers.map(([k, v]) => [k.toLowerCase(), v]))
      assert.deepEqual(Object.keys(seen[0].headers).sort(), Object.keys(sent).filter((k) => ai.forwardsHeader(k)).sort())
      for (const k of f.upstream.forwarded) assert.ok(k in seen[0].headers, `${k} still forwarded`)
      for (const k of Object.keys(seen[0].headers)) assert.equal(seen[0].headers[k], sent[k], `${k} verbatim`)
      for (const k of f.cli === 'claude' ? ['user-agent', 'x-app', 'x-claude-code-session-id', 'x-stainless-os'] : ['user-agent', 'originator', 'session-id', 'thread-id', 'x-codex-turn-metadata']) assert.ok(k in seen[0].headers, `${f.cli} sends ${k}; it goes upstream`)
      assert.ok(!('accept-encoding' in seen[0].headers) && !('connection' in seen[0].headers))
      assert.deepEqual(new Uint8Array(seen[0].body), te.encode(f.body), 'the request bytes go upstream unchanged')
      if (!isStream) {
        const out = await res.text()
        assert.equal(out, f.upstream.body, 'the answer is passed on unchanged')
        const env = ai.decodeReceiptHeader(res.headers.get(ai.RECEIPT_HEADER))
        assert.deepEqual(ai.verifyUsageReceipt({ envelope: env, manifest: p.manifest(), requestBytes: f.body, responseBytes: out, stream: false, path: f.path, status: f.upstream.status, maxSkewS: 60 }).problems, [])
        assert.equal(env.result.status, f.upstream.status)
        if (f.upstream.status >= 400) assert.deepEqual([env.result.usage, env.result.prices, env.result.complete], [null, null, false], 'a failed call is attributable, not billable')
        else assert.ok(env.result.prices, 'priced')
        continue
      }
      const out = await res.text()
      if (!hasFinal) {
        // No final event: one comment line after the stream, so the cut stays visible to the client exactly as it was.
        // 没有最终事件：流之后一行注释，客户端看到的截断与原来完全一样。
        assert.ok(out.startsWith(f.upstream.body), 'the stream as it came')
        assert.match(out.slice(f.upstream.body.length), /^: tapeapi-receipt [A-Za-z0-9_-]+\n$/)
        assert.deepEqual(events(out), events(f.upstream.body))
        const env = ai.readSseReceipt(out)
        assert.deepEqual(ai.verifyUsageReceipt({ envelope: env, manifest: p.manifest(), requestBytes: f.body, responseBytes: out, stream: true, path: f.path, status: 200, maxSkewS: 60 }).problems, [])
        assert.equal(env.result.complete, false, 'cut short: not complete')
        continue
      }
      const blocks = out.match(RECEIPT_BLOCK) || []
      assert.equal(blocks.length, 1, 'exactly one receipt block')
      assert.equal(out.replace(RECEIPT_BLOCK, ''), f.upstream.body, 'nothing else is added, removed or reordered')
      assert.ok(out.slice(out.indexOf(blocks[0]) + blocks[0].length).startsWith(FINAL[format.name]), 'right before the final event')
      assert.deepEqual(events(out), events(f.upstream.body), 'a client dispatches the same events')
      const env = ai.readSseReceipt(out)
      const v = ai.verifyUsageReceipt({ envelope: env, manifest: p.manifest(), requestBytes: f.body, responseBytes: out, stream: true, path: f.path, status: 200, maxSkewS: 60 })
      assert.deepEqual(v.problems, [])
      const read = ai.scanSse(f.upstream.body, { format })
      assert.equal(env.id, read.id)
      assert.deepEqual(env.result.usage, read.usage)
      assert.ok(env.result.prices, 'priced')
      assert.deepEqual(env.result.prices, pricesOf(ai.modelEntryOf(MODELS, env.result.model, format.name), env.result.usage))
      assert.equal(env.result.complete, true)
    }
  })
}

test('claude: the HEAD /api/hello probe Claude Code sends before each run is not an API path: answered by the provider, nothing goes upstream', async () => {
  const f = FIX.calls.find((c) => c.cli === 'claude' && c.method === 'HEAD')
  assert.ok(f, 'recorded')
  assert.equal(f.path, '/api/hello')
  const seen = []
  const p = proxyWith({ upstream: { status: 200, headers: {}, body: '' } }, 1, seen)
  const res = await p.handleRequest(requestOf(f), { clientIp: '127.0.0.1' })
  assert.equal(res.status, 404)
  assert.equal(seen.length, 0)
})

// The same request bodies, answered by the fake upstream as JSON: Claude Code falls back to a non-streaming call when a
// stream fails; the receipt then rides in the header. / 同样的请求体，由模拟上游以 JSON 作答：流失败时 Claude Code 退回非流式
// 调用；回执放在响应头。
test('the non-streaming fallback of both CLIs\' requests: a JSON answer with the receipt header, verified', async () => {
  // Plain answers only (the prompts' failure directives would otherwise fire). / 只给普通回答（否则提示里的失败指令会生效）。
  const fake = createFakeUpstream({ keys: ['sk-demo'], script: () => ({ text: 'Hi! A plain answer.' }) })
  const p = createAIProxy({ upstream: { baseUrl: UP }, manifestBase: manifestBase(), signerKey: KEY, models: MODELS, log: () => {}, rateLimit: false, fetch: (url, init) => fake.fetch(url.replace(UP, 'http://fake/v1'), init) })
  for (const f of posts) {
    const body = JSON.stringify({ ...JSON.parse(f.body), stream: false })
    const res = await p.handleRequest(new Request(BASE + f.path + f.search, { method: 'POST', headers: f.headers, body }), { clientIp: '127.0.0.1' })
    assert.equal(res.status, 200, `${f.cli} ${f.turn}`)
    const bytes = new Uint8Array(await res.arrayBuffer())
    const env = ai.decodeReceiptHeader(res.headers.get(ai.RECEIPT_HEADER))
    const v = ai.verifyUsageReceipt({ envelope: env, manifest: p.manifest(), requestBytes: body, responseBytes: bytes, stream: false, path: f.path, status: 200 })
    assert.deepEqual(v.problems, [], `${f.cli} ${f.turn}`)
    assert.ok(env.result.prices && env.result.usage.prompt_tokens > 0)
  }
})
