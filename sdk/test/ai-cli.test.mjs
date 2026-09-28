// The SDK's format adapters and verifiers over the streams recorded behind the real Claude Code and Codex CLIs
// (sdk/test/fixtures/ai-cli.json, from examples/ai-proxy/e2e-cli.mjs --save-fixtures): Anthropic Messages with thinking
// (thinking_delta, signature_delta), tool_use (input_json_delta), ping and cache usage; OpenAI Responses with reasoning,
// function_call and message items. What each adapter reads is checked against the events themselves; the digest over the
// raw bytes equals the digest over the data payloads; createVerifyingFetch accepts Claude Code's ?beta=true path.
// SDK 的格式适配器与核验方，跑在真实 Claude Code 与 Codex CLI 背后录下的流上：适配器读出的内容与事件本身逐项核对；原始字节的
// 哈希等于 data 载荷的哈希；createVerifyingFetch 认得 Claude Code 的 ?beta=true 路径。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as ai from '../src/ai.js'
import { createAIProxy } from '../../server/src/ai-proxy.js'

const FIX = JSON.parse(readFileSync(new URL('./fixtures/ai-cli.json', import.meta.url), 'utf8'))
const streams = FIX.calls.filter((c) => c.upstream && /event-stream/.test(c.upstream.headers['content-type'] || ''))
const datas = (text) => {
  const out = []
  for (const block of text.split('\n\n')) {
    const lines = block.split('\n').filter((l) => l.startsWith('data:'))
    if (lines.length) out.push({ event: (/^event: ?(.*)$/m.exec(block) || [])[1] ?? '', data: lines.map((l) => l.slice(l.startsWith('data: ') ? 6 : 5)).join('\n') })
  }
  return out
}

test('the recorded streams cover what the CLIs read: thinking, tool_use, ping; reasoning, function_call; and streams cut short', () => {
  const all = streams.map((c) => c.upstream.body).join('')
  for (const t of ['thinking_delta', 'signature_delta', 'input_json_delta', 'event: ping', 'response.reasoning_summary_text.delta', 'response.function_call_arguments.delta', 'response.output_item.done']) assert.ok(all.includes(t), t)
  assert.ok(streams.some((c) => c.cli === 'claude' && c.upstream.body.includes('event: error')), 'an Anthropic stream ended by an error event')
  assert.ok(streams.some((c) => c.cli === 'codex' && !c.upstream.body.includes('response.completed')), 'a Responses stream closed early')
  assert.ok(FIX.versions.claude && FIX.versions.codex, 'the CLI versions are recorded')
})

for (const c of streams) {
  test(`${c.cli} / ${c.turn}: the adapter reads id, model and usage as the events say; the raw-byte digest equals the payload digest`, () => {
    const format = ai.formatFor('POST', c.path)
    const evs = datas(c.upstream.body)
    const s = ai.scanSse(c.upstream.body, { format })
    assert.equal(s.responseSha256, ai.sseDigestOfPayloads(evs.map((e) => e.data), { sentinel: format.stream.sentinel }))
    assert.equal(s.events, evs.filter((e) => e.data !== format.stream.sentinel).length)
    const json = evs.map((e) => JSON.parse(e.data))
    if (format.name === 'anthropic-messages') {
      const start = json.find((j) => j.type === 'message_start').message
      const delta = json.filter((j) => j.type === 'message_delta').at(-1)
      assert.equal(s.id, start.id); assert.equal(s.model, start.model)
      // message_delta is cumulative and wins; without one (a stream cut by an error event) message_start's usage stands.
      // message_delta 为累计值并以它为准；没有它时（被错误事件截断的流）沿用 message_start 的 usage。
      const u = { ...start.usage, ...(delta?.usage ?? {}) }
      const prompt = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
      const want = { prompt_tokens: prompt, completion_tokens: u.output_tokens, total_tokens: prompt + u.output_tokens, cache_read_tokens: u.cache_read_input_tokens, cache_write_tokens: u.cache_creation_input_tokens }
      if (u.cache_creation) want.cache_write_1h_tokens = u.cache_creation.ephemeral_1h_input_tokens
      assert.deepEqual(s.usage, want)
      assert.equal(s.complete, json.some((j) => j.type === 'message_stop') && !json.some((j) => j.type === 'error'))
      if (!delta) assert.deepEqual([s.usage.completion_tokens, s.complete], [1, false], 'a cut stream: message_start\'s placeholder output count, not complete (priced all the same)')
    } else {
      const created = json.find((j) => j.type === 'response.created').response
      const done = json.find((j) => j.type === 'response.completed')?.response
      assert.equal(s.id, created.id); assert.equal(s.model, created.model)
      assert.equal(s.complete, !!done)
      if (!done) { assert.equal(s.usage, null, 'closed before response.completed: no usage, so no price'); return }
      const u = done.usage
      assert.deepEqual(s.usage, { prompt_tokens: u.input_tokens, completion_tokens: u.output_tokens, total_tokens: u.total_tokens, cache_read_tokens: u.input_tokens_details.cached_tokens, reasoning_tokens: u.output_tokens_details.reasoning_tokens })
    }
  })
}

test('createVerifyingFetch, as an Anthropic or OpenAI SDK would use it, verifies the recorded CLI calls through a sidecar (the ?beta=true query included)', async () => {
  const BASE = 'https://ai.example'
  const models = [
    { id: FIX.models.claude, formats: ['anthropic-messages'], prices: [{ currency: 'BEM', unit: '1M tokens', input: '3', output: '15', cacheRead: '0.3', cacheWrite: '3.75' }] },
    { id: FIX.models.codex, formats: ['openai-responses'], prices: [{ currency: 'BEM', unit: '1M tokens', input: '1.25', output: '10', cacheRead: '0.125' }] },
  ]
  let current = null
  const p = createAIProxy({
    upstream: { baseUrl: 'https://up.example/v1' }, signerKey: '0x' + '42'.repeat(32), models, rateLimit: false, log: () => {},
    manifestBase: { name: 'CLI replay', circuits: '0xe02c26c7432A7121168AA9B610DE24eCf9a1a414', tokenId: '11', container: '0x1b2A657BcBa9D3229f57aC2f4FcbEE2AA756aAe8', delegation: null, endpoints: { live: [`${BASE}/tapeapi/v1`], async: false } },
    fetch: async () => new Response(current.upstream.body, { status: current.upstream.status, headers: current.upstream.headers }),
  })
  const manifest = await p.ready
  const reports = []
  const vf = ai.createVerifyingFetch({ service: { manifest, container: manifest.container, verified: { dev: true } }, fetch: (url, init) => p.handleRequest(new Request(url, init), { clientIp: '127.0.0.1' }), onReport: (r) => reports.push(r) })
  for (const c of FIX.calls.filter((x) => x.method === 'POST' && x.upstream)) {
    current = c
    const res = await vf(BASE + c.path + c.search, { method: 'POST', headers: c.headers, body: c.body })
    await res.arrayBuffer()
    const r = reports.at(-1)
    assert.deepEqual(r.problems, [], `${c.cli} ${c.turn}`)
    assert.equal(r.status, c.upstream.status)
  }
  assert.equal(reports.length, FIX.calls.filter((x) => x.method === 'POST' && x.upstream).length, 'every call was checked')
})
