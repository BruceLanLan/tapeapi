// FIXED AI-RESER (1.6 design review, 2026-10-04): to ask the upstream for the usage of a stream Chat request, the sidecar
// sent JSON.stringify(prepareUpstream(JSON.parse(body)).body): `seed: 12345678901234567890` reached the upstream as
// 12345678901234567000, `1e400` as null, a duplicate key nested in a message was merged, whitespace and escapes were
// rewritten and the client's salt was dropped, against TAPI-21 §3.5 ("MUST NOT change the request body it sends upstream
// in any other way"). The member is now set in the client's bytes with the same splice the client uses
// (ai.requestUsageBody); where it refuses, the body is re-serialised as before. The receipt is unchanged either way.
// FIXED AI-RESER：旁路为流式 Chat 请求向上游要用量时，发出的是 JSON.stringify 重新序列化的正文：大整数被改值、1e400 变 null、
// 嵌套的重复键被合并、空白与转义被改写、客户端的盐被丢掉，违反 TAPI-21 §3.5。现在在客户端字节上用与客户端相同的拼接设置成员；
// 拼接拒绝时照旧重新序列化。两种情况下回执都不变。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createAIProxy } from '../src/ai-proxy.js'
import { ai } from '@tapeapi/sdk'

const KEY = '0x' + '42'.repeat(32)
const MODELS = [{ id: 'demo-chat', prices: [{ currency: 'BEM', unit: '1M tokens', input: '0.15', output: '0.6' }] }]
const te = new TextEncoder(), td = new TextDecoder('utf-8', { ignoreBOM: true })
const chat = ai.FORMATS.find((f) => f.name === 'openai-chat')
const STREAM = 'data: {"id":"chatcmpl-r1","object":"chat.completion.chunk","model":"demo-chat","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n' +
  'data: {"id":"chatcmpl-r1","object":"chat.completion.chunk","model":"demo-chat","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":1,"total_tokens":6}}\n\ndata: [DONE]\n\n'

function sidecar(formats) {
  const seen = []
  const p = createAIProxy({
    upstream: { baseUrl: 'https://up.example/v1' }, signerKey: KEY, models: MODELS, log: () => {}, rateLimit: false, ...(formats ? { formats } : {}),
    manifestBase: { name: 'AI', circuits: '0xe02c26c7432A7121168AA9B610DE24eCf9a1a414', tokenId: '11', container: '0x1b2A657BcBa9D3229f57aC2f4FcbEE2AA756aAe8', delegation: null, dev: true, endpoints: { live: ['https://ai.example/tapeapi/v1'], async: false } },
    fetch: async (url, init) => { seen.push(new Uint8Array(init.body)); return new Response(STREAM, { headers: { 'content-type': 'text/event-stream' } }) },
  })
  return { p, seen }
}
async function through(body, headers = { 'content-type': 'application/json' }, formats) {
  const { p, seen } = sidecar(formats)
  const res = await p.handleRequest(new Request('https://ai.example/v1/chat/completions', { method: 'POST', headers, body }), { clientIp: '1.1.1.1' })
  const out = await res.text()
  const env = ai.readSseReceipt(out)
  return { upstream: td.decode(seen[0]), out, env, manifest: p.manifest() }
}
const SO = '"stream_options":{"include_usage":true}'
const SALT = ' \t\r\n'.repeat(16)

// [name, the client's bytes, what the upstream gets]. / [名称, 客户端字节, 上游收到的]。
const EXACT = [
  ['an integer beyond 2^53', '{"model":"demo-chat","seed":12345678901234567890,"messages":[],"stream":true}', `{"model":"demo-chat","seed":12345678901234567890,"messages":[],"stream":true,${SO}}`],
  ['1e400', '{"model":"demo-chat","temperature":1e400,"messages":[],"stream":true}', `{"model":"demo-chat","temperature":1e400,"messages":[],"stream":true,${SO}}`],
  ['a nested duplicate key', '{"model":"demo-chat","messages":[{"role":"user","content":"a","content":"b"}],"stream":true}', `{"model":"demo-chat","messages":[{"role":"user","content":"a","content":"b"}],"stream":true,${SO}}`],
  ['the client\'s salt', `{"model":"demo-chat","messages":[],"stream":true}${SALT}`, `{"model":"demo-chat","messages":[],"stream":true,${SO}}${SALT}`],
  ['indentation', '{\n  "model": "demo-chat",\n  "stream": true\n}', `{\n  "model": "demo-chat",\n  "stream": true,${SO}\n}`],
  ['escapes', '{"model":"demo-chat","messages":[{"role":"user","content":"caf\\u00e9 \\ud83d\\ude00 a\\/b"}],"stream":true}', `{"model":"demo-chat","messages":[{"role":"user","content":"caf\\u00e9 \\ud83d\\ude00 a\\/b"}],"stream":true,${SO}}`],
  ['stream_options with include_usage false, in place', '{"model":"demo-chat", "stream":true,"stream_options":{ "include_usage": false, "x":1 },"messages":[]}', '{"model":"demo-chat", "stream":true,"stream_options":{ "include_usage": true, "x":1 },"messages":[]}'],
]
for (const [name, body, want] of EXACT) {
  test(`FIXED AI-RESER: the sidecar sets the usage member in the client's bytes, nothing else changes: ${name}; the receipt is as before`, async () => {
    const r = await through(body)
    assert.equal(r.upstream, want)
    assert.notEqual(r.upstream, JSON.stringify(chat.prepareUpstream(JSON.parse(body)).body), 'not the re-serialised body')
    // The same parse as before (what an upstream reads), the receipt over the client's bytes, the chunk stripped.
    // 与以前同样的解析结果；回执覆盖客户端字节；用量块照旧去掉。
    assert.equal(JSON.stringify(JSON.parse(r.upstream)), JSON.stringify(chat.prepareUpstream(JSON.parse(body)).body))
    assert.equal(r.env.params.requestSha256, ai.sha256Hex(body))
    assert.equal(r.env.result.usageInjected, true)
    assert.deepEqual(r.env.result.usage, { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 })
    assert.doesNotMatch(r.out, /"usage"/, 'the client gets no usage chunk it did not ask for')
    assert.deepEqual(ai.verifyUsageReceipt({ envelope: r.env, manifest: r.manifest, requestBytes: body, responseBytes: r.out, stream: true }).problems, [])
  })
}

test('AI-RESER: where the splice refuses, the sidecar re-serialises exactly as 1.5 did (top-level duplicate, byte order mark, non-JSON Content-Type, a custom format without usageMember)', async () => {
  const old = (body) => JSON.stringify(chat.prepareUpstream(JSON.parse(td.decode(te.encode(body)).replace(/^\ufeff/, ''))).body)
  const cases = [
    ['{"model":"demo-chat","model":"demo-chat","messages":[],"stream":true}', undefined],
    ['\ufeff{"model":"demo-chat","messages":[],"stream":true}', undefined],
    ['{"model":"demo-chat","messages":[],"stream":true}', { 'content-type': 'text/plain' }],
  ]
  for (const [body, headers] of cases) {
    const r = await through(body, headers)
    assert.equal(r.upstream, old(body), JSON.stringify(body))
    assert.equal(r.env.params.requestSha256, ai.sha256Hex(body))
    assert.equal(r.env.result.usageInjected, true)
  }
  const custom = [{ ...chat, usageMember: undefined }, ...ai.FORMATS.filter((f) => f !== chat)]
  const body = '{"model":"demo-chat","seed":12345678901234567890,"messages":[],"stream":true}'
  const r = await through(body, undefined, custom)
  assert.equal(r.upstream, old(body))
  assert.match(r.upstream, /12345678901234567000/, 'a custom format keeps 1.5\'s behaviour')
})

test('AI-RESER: requests that are not injected still go upstream byte for byte (asked already, not a stream, another format)', async () => {
  for (const body of [`{"model":"demo-chat","stream":true,${SO},"seed":12345678901234567890}${SALT}`, `{"model":"demo-chat","seed":12345678901234567890,"stream":false}${SALT}`]) {
    const r = await through(body)
    assert.equal(r.upstream, body)
  }
})

// FIXED AI-RESER-SDK (Fable review F2): with an SDK older than 1.6, ai.requestUsageBody is missing and the sidecar used to
// fall back to re-serialising in silence. It still degrades gracefully, and says so once when it is created. The old SDK
// is simulated in a child process whose loader hands ai-proxy.js a copy of @tapeapi/sdk without that export.
// FIXED AI-RESER-SDK：SDK 早于 1.6 时没有 ai.requestUsageBody，旁路曾静默退回重新序列化。现在仍优雅降级，并在创建时说一次。
// 旧 SDK 由子进程模拟：其加载器给 ai-proxy.js 一份不含该导出的 @tapeapi/sdk。
test('FIXED AI-RESER-SDK: an @tapeapi/sdk without requestUsageBody: one log line at creation, the body re-serialised as in 1.5, the call still answered', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { pathToFileURL } = await import('node:url')
  const { spawnSync } = await import('node:child_process')
  const dir = mkdtempSync(join(tmpdir(), 'tapeapi-oldsdk-'))
  const url = (p) => pathToFileURL(p).href
  const sdk = new URL('../../sdk/src/index.js', import.meta.url).href
  const proxyUrl = new URL('../src/ai-proxy.js', import.meta.url).href
  try {
    writeFileSync(join(dir, 'shim.mjs'), `import * as real from ${JSON.stringify(sdk)}\nexport * from ${JSON.stringify(sdk)}\nconst { requestUsageBody, ...rest } = real.ai\nexport const ai = Object.freeze(rest)\n`)
    writeFileSync(join(dir, 'hooks.mjs'), `export async function resolve(spec, ctx, next) {\n  if (spec === '@tapeapi/sdk' && String(ctx.parentURL).endsWith('/server/src/ai-proxy.js')) return { url: ${JSON.stringify(url(join(dir, 'shim.mjs')))}, shortCircuit: true }\n  return next(spec, ctx)\n}\n`)
    writeFileSync(join(dir, 'register.mjs'), `import { register } from 'node:module'\nregister(${JSON.stringify(url(join(dir, 'hooks.mjs')))})\n`)
    const run = (old) => {
      writeFileSync(join(dir, 'child.mjs'), `
import { createAIProxy } from ${JSON.stringify(proxyUrl)}
const logs = [], seen = []
const p = createAIProxy({ upstream: { baseUrl: 'https://up.example/v1' }, signerKey: '0x' + '42'.repeat(32), models: [{ id: 'demo-chat', prices: [{ currency: 'BEM', unit: '1M tokens', input: '0.15', output: '0.6' }] }], log: (...a) => logs.push(a.join(' ')), rateLimit: false,
  manifestBase: { name: 'AI', circuits: '0xe02c26c7432A7121168AA9B610DE24eCf9a1a414', tokenId: '11', container: '0x1b2A657BcBa9D3229f57aC2f4FcbEE2AA756aAe8', delegation: null, dev: true, endpoints: { live: ['https://ai.example/tapeapi/v1'], async: false } },
  fetch: async (u, i) => { seen.push(new TextDecoder().decode(i.body)); return new Response(${JSON.stringify(STREAM)}, { headers: { 'content-type': 'text/event-stream' } }) } })
const res = await p.handleRequest(new Request('https://ai.example/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"model":"demo-chat","seed":12345678901234567890,"messages":[],"stream":true}' }), { clientIp: '1.1.1.1' })
const out = await res.text()
console.log(JSON.stringify({ logs, seen, status: res.status, receipt: /tapeapi-receipt/.test(out) }))
`)
      const r = spawnSync(process.execPath, [...(old ? ['--import', url(join(dir, 'register.mjs'))] : []), join(dir, 'child.mjs')], { encoding: 'utf8' })
      assert.equal(r.status, 0, r.stderr)
      return JSON.parse(r.stdout.trim().split('\n').pop())
    }
    const old = run(true)
    const line = '@tapeapi/server 1.6 needs @tapeapi/sdk 1.6 or later: the request is re-serialised the way 1.5 did / @tapeapi/server 1.6 需要 @tapeapi/sdk 1.6 或更高版本：请求按 1.5 的方式重新序列化'
    assert.deepEqual(old.logs.filter((l) => l.includes('needs @tapeapi/sdk')), [line], 'said once')
    assert.match(old.seen[0], /"seed":12345678901234567000,.*"stream_options":\{"include_usage":true\}\}$/, 're-serialised as in 1.5')
    assert.deepEqual([old.status, old.receipt], [200, true])
    const cur = run(false)
    assert.ok(!cur.logs.some((l) => l.includes('needs @tapeapi/sdk')), 'not with this SDK')
    assert.match(cur.seen[0], /"seed":12345678901234567890,/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// A stream Chat request nested thousands of levels deep: JSON.stringify could not re-serialise it, the exception escaped
// and the sidecar answered HTTP 500 (1.5). Now the sidecar's own 400 (no upstream call, no receipt, x-should-retry: false).
// 嵌套数千层的流式 Chat 请求：JSON.stringify 无法重新序列化，异常外泄，旁路回 HTTP 500（1.5）。现在是旁路自己的 400。
test('AI-RESER: a stream Chat request too deep to re-serialise gets the sidecar\'s own HTTP 400 request_too_deep, not a 500; asking for the usage itself goes through', async () => {
  const deep = `{"model":"demo-chat","x":${'['.repeat(20000)}${']'.repeat(20000)},"messages":[],"stream":true}`
  const { p, seen } = sidecar()
  const res = await p.handleRequest(new Request('https://ai.example/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: deep }), { clientIp: '1.1.1.1' })
  assert.equal(res.status, 400)
  assert.equal(res.headers.get('x-should-retry'), 'false')
  assert.equal(res.headers.get(ai.SIDECAR_ERROR_HEADER), '1')
  assert.equal((await res.json()).error.code, 'request_too_deep')
  assert.equal(seen.length, 0, 'nothing went upstream')
  const asked = deep.replace('"stream":true', `"stream":true,${SO}`)
  const r = await through(asked)
  assert.equal(r.upstream, asked, 'already asked: sent on as it is')
})
