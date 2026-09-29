// The LiteLLM package (server.mjs, smoke.mjs): LiteLLM's profile over the new-api package's entry, the adjustment
// to how LiteLLM's Responses streams are read (litellmFormats), the files an operator copies, and calls through the sidecar to a
// LiteLLM-shaped stand-in, raw and through the official SDKs in strict mode. Network-free (loopback only), no Docker,
// no LiteLLM: the run against a real LiteLLM Proxy is e2e.mjs.
// LiteLLM 一键包：基于 new-api 入口的 LiteLLM 配置、读 LiteLLM Responses 流的调整、运营者要复制的文件，以及经旁路调用按 LiteLLM
// 改写的替身（原始调用与 strict 模式的官方 SDK）。不联网（只用回环地址），不需要 Docker 与 LiteLLM；对真实 LiteLLM 的演练见 e2e.mjs。
import { test } from 'node:test'
import http from 'node:http'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createTapeAPI, ai } from '@tapeapi/sdk'
import { readConfig, createSidecar, litellmFormats, LITELLM_PROFILE, DEFAULT_UPSTREAM, DEFAULT_MODELS_FILE, REQUIRED } from './server.mjs'
import { startSidecar as startPlainSidecar, readConfig as readNewApiConfig, NEW_API_PROFILE } from '../new-api-sidecar/server.mjs'
import { throwawayIdentity, startStack, callAndVerify, streamProblems, CALLS, EXAMPLE_MODELS, asLiteLLM } from './smoke.mjs'
import { fakeConfig } from './e2e.mjs'
import { DEMO_KEY, createFakeUpstream } from '../ai-proxy/fake-upstream.mjs'

const here = (name) => fileURLToPath(new URL(name, import.meta.url))
const complete = (extra = {}) => ({ ...throwawayIdentity(), PUBLIC_URL: 'https://api.example.com', MODELS_FILE: EXAMPLE_MODELS, ...extra })
const fmt = (formats, name) => formats.find((f) => f.name === name)

let OpenAI = null, Anthropic = null
try { ({ default: OpenAI } = await import('openai')) } catch { /* not installed */ }
try { ({ default: Anthropic } = await import('@anthropic-ai/sdk')) } catch { /* not installed */ }
const noSdks = !OpenAI || !Anthropic ? 'the official openai / @anthropic-ai/sdk packages are not installed (npm install at the repository root)' : false

test('litellm-sidecar: LiteLLM is the default upstream, and a wrong one is named as LiteLLM\'s', () => {
  const s = readConfig(complete())
  assert.equal(s.ok, true, s.problem)
  assert.equal(s.config.upstreamBaseUrl, 'http://litellm:4000/v1')
  assert.equal(DEFAULT_UPSTREAM, 'http://litellm:4000/v1')
  assert.equal(s.config.models.length, 4)
  assert.match(readConfig(complete({ UPSTREAM_BASE_URL: 'litellm:4000' })).problem, /UPSTREAM_BASE_URL must be LiteLLM's \/v1 base, such as http:\/\/litellm:4000\/v1/)
  // Setup mode is the new-api package's, unchanged. / 设置模式与 new-api 一键包相同。
  assert.deepEqual(readConfig({}).missing, ['SIGNER_KEY (secret)', ...REQUIRED])
  // The price table defaults to models.json next to this package's server.mjs, not new-api's. / 价目表默认取本包旁的 models.json。
  const withoutFile = { ...complete() }; delete withoutFile.MODELS_FILE
  assert.equal(DEFAULT_MODELS_FILE, here('models.json'))
  assert.ok(readConfig(withoutFile).problem.includes(here('models.json')), readConfig(withoutFile).problem)
})

test('litellm-sidecar: the new-api package keeps its defaults (the profile is an addition)', () => {
  assert.equal(NEW_API_PROFILE.upstreamName, 'new-api')
  assert.equal(readNewApiConfig(complete()).config.upstreamBaseUrl, 'http://new-api:3000/v1')
  assert.match(readNewApiConfig(complete({ UPSTREAM_BASE_URL: 'x' })).problem, /UPSTREAM_BASE_URL must be new-api's \/v1 base/)
  assert.equal(NEW_API_PROFILE.formats, undefined)
})

test('litellm-sidecar: litellmFormats ends a Responses stream at data: [DONE] too, and changes nothing else', () => {
  const before = JSON.stringify(ai.FORMATS.map((f) => f.stream))
  const formats = litellmFormats()
  assert.equal(JSON.stringify(ai.FORMATS.map((f) => f.stream)), before, 'ai.FORMATS is not mutated')
  assert.deepEqual(formats.map((f) => f.name), ai.FORMATS.map((f) => f.name))
  const r = fmt(formats, 'openai-responses'), orig = fmt(ai.FORMATS, 'openai-responses')
  assert.deepEqual(r.stream.final.event, orig.stream.final.event)
  assert.deepEqual(r.stream.final.data, ['[DONE]'])
  assert.equal(r.stream.sentinel, '[DONE]')
  assert.equal(r.method, orig.method)
  // The Chat adapter already ends at data: [DONE]: the Responses adjustment mirrors it. / Chat 适配器本来就以 [DONE] 结束。
  assert.deepEqual(fmt(ai.FORMATS, 'openai-chat').stream.final.data, ['[DONE]'])
  for (const name of ['anthropic-messages', 'openai-embeddings']) assert.equal(fmt(formats, name), fmt(ai.FORMATS, name))
  assert.equal(LITELLM_PROFILE.formats.length, ai.FORMATS.length)
  // Idempotent. / 幂等。
  assert.deepEqual(fmt(litellmFormats(formats), 'openai-responses').stream.final.data, ['[DONE]'])
})

test('litellm-sidecar: the Chat usage chunk LiteLLM sends ({ index: 0, delta: {} }) counts as the injected one, nothing else does -- in the SDK itself now (FIXED P101-b)', () => {
  const chat = fmt(ai.FORMATS, 'openai-chat')
  assert.equal(fmt(litellmFormats(), 'openai-chat'), chat, 'litellmFormats leaves the Chat adapter as it is')
  const usage = { prompt_tokens: 2, completion_tokens: 4, total_tokens: 6 }
  assert.equal(chat.isInjectedEvent({ choices: [], usage }), true)   // OpenAI's own shape / OpenAI 自己的形状
  assert.equal(chat.isInjectedEvent({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {} }], usage }), true)
  assert.equal(chat.isInjectedEvent({ choices: [{ index: 0, delta: {}, finish_reason: null }], usage }), true)
  assert.equal(chat.isInjectedEvent({ choices: [{ index: 0, delta: { content: 'x' } }], usage }), false)
  assert.equal(chat.isInjectedEvent({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage }), false)
  assert.equal(chat.isInjectedEvent({ choices: [{ index: 0, delta: {} }] }), false)
  assert.equal(chat.isInjectedEvent({ choices: [{ index: 0, delta: {} }], usage: null }), false)
  assert.equal(chat.prepareUpstream, fmt(ai.FORMATS, 'openai-chat').prepareUpstream)
})

test('litellm-sidecar: a configuration createAIProxy accepts with ai.FORMATS it accepts with litellmFormats', () => {
  const s = createSidecar(complete(), { log: () => {} })
  assert.equal(s.state.ok, true, s.state.problem)
  assert.deepEqual(s.proxy.manifest().ai.endpoints.map((e) => e.format), ai.FORMATS.map((f) => f.name))
})

test('litellm-sidecar: the files an operator copies agree with each other', () => {
  const models = JSON.parse(readFileSync(EXAMPLE_MODELS, 'utf8'))
  ai.validateAIField({ endpoints: ai.FORMATS.map((f) => ({ format: f.name, baseUrl: 'https://api.example.com' + f.baseSuffix })), models })
  assert.ok(models.every((m) => Array.isArray(m.prices) && m.price === undefined))
  const ids = models.map((m) => m.id).sort()
  // Every LiteLLM model_name is priced: LiteLLM reports model_name in the answer. / 每个 model_name 都有价格：LiteLLM 在回答里报告 model_name。
  const names = [...readFileSync(here('config.example.yaml'), 'utf8').matchAll(/^\s*- model_name: (\S+)\s*$/gm)].map((m) => m[1]).sort()
  assert.deepEqual(names, ids)
  assert.deepEqual([...fakeConfig('http://127.0.0.1:1/v1', 'sk-x').matchAll(/model_name: (\S+)/g)].map((m) => m[1]).sort(), ids)
  assert.deepEqual([...new Set(CALLS.map((c) => c.body.model))].sort(), ids)
  // The config reads every secret from the environment. / 配置里的秘密都来自环境变量。
  const config = readFileSync(here('config.example.yaml'), 'utf8')
  for (const m of config.matchAll(/^\s*(api_key|master_key|database_url):\s*(\S+)/gm)) assert.match(m[2], /^os\.environ\/[A-Z_]+$/, m[0])
  // env.example: placeholders only, the secrets left empty. / env.example 只有占位符，秘密留空。
  const env = readFileSync(here('env.example'), 'utf8')
  for (const k of ['SIGNER_KEY', 'LITELLM_MASTER_KEY', 'LITELLM_SALT_KEY', 'POSTGRES_PASSWORD', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY', 'DELEGATION_SIG']) assert.match(env, new RegExp(`^${k}=$`, 'm'), k)
  assert.doesNotMatch(env, /sk-[A-Za-z0-9]{8,}|0x[0-9a-fA-F]{64}/)
})

test('litellm-sidecar: compose pins LiteLLM by version and builds the sidecar from this checkout, loopback only', () => {
  const compose = readFileSync(here('docker-compose.yml'), 'utf8')
  assert.match(compose, /^\s*image: ghcr\.io\/berriai\/litellm:v1\.103\.0$/m)
  assert.doesNotMatch(compose, /litellm:(main-)?(latest|stable)|main-stable/)
  assert.match(compose, /^\s*image: postgres:16\.\d+-alpine$/m)
  assert.match(compose, /^\s*newapi: \.\.\/new-api-sidecar$/m)
  assert.match(compose, /UPSTREAM_BASE_URL: http:\/\/litellm:4000\/v1/)
  for (const m of compose.matchAll(/^\s*- "([^"]+:\d+)"$/gm)) assert.match(m[1], /^(127\.0\.0\.1|\$\{SIDECAR_BIND:-127\.0\.0\.1\}):/, m[1])
  const dockerfile = readFileSync(here('Dockerfile'), 'utf8')
  assert.match(dockerfile, /COPY --from=newapi server\.mjs \.\/examples\/new-api-sidecar\/server\.mjs/)
  assert.match(dockerfile, /COPY server\.mjs \.\/examples\/litellm-sidecar\/server\.mjs/)
  assert.deepEqual(readFileSync(here('.dockerignore'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#')), ['*', '!server.mjs'])
})

test('litellm-sidecar: every call through the sidecar to a LiteLLM-shaped stand-in carries a receipt that verifies', async () => {
  const stack = await startStack()
  try {
    for (const c of CALLS) {
      const { res, stream, envelope, verdict, responseBytes } = await callAndVerify({ manifest: stack.manifest, ...c })
      assert.equal(res.status, 200, c.label)
      assert.ok(verdict.ok, `${c.label}: ${verdict.problems.join('; ')}`)
      assert.equal(envelope.result.complete, true, c.label)
      assert.ok(envelope.result.prices, c.label)
      assert.equal(res.headers.get('x-litellm-version'), '1.103.0', `${c.label}: LiteLLM's headers pass through`)
      if (stream) assert.deepEqual(streamProblems({ path: c.path, body: c.body, responseBytes }), [], c.label)
    }
  } finally { await stack.close() }
})

test('litellm-sidecar: the stand-in is LiteLLM-shaped (data-only Responses events ended by [DONE], a usage chunk with one empty choice)', async () => {
  const sse = (text) => new Response(text, { headers: { 'content-type': 'text/event-stream' } })
  const r = await (await asLiteLLM('/v1/responses', sse('event: response.created\ndata: {"type":"response.created"}\n\nevent: response.completed\ndata: {"type":"response.completed"}\n\n'))).text()
  assert.equal(r, 'data: {"type":"response.created"}\n\ndata: {"type":"response.completed"}\n\ndata: [DONE]\n\n')
  const c = await (await asLiteLLM('/v1/chat/completions', sse('data: {"choices":[],"usage":{"total_tokens":1}}\n\ndata: [DONE]\n\n'))).text()
  assert.equal(c, 'data: {"choices":[{"index":0,"delta":{}}],"usage":{"total_tokens":1}}\n\ndata: [DONE]\n\n')
})

test('litellm-sidecar: without litellmFormats, a strict client refuses LiteLLM\'s Responses stream; a Chat stream is clean with the SDK alone (FIXED P101-b)', { skip: noSdks }, async () => {
  const stack = await startStack({ start: startPlainSidecar })
  try {
    const chat = CALLS.find((c) => c.label === 'OpenAI Chat, streamed')
    const { responseBytes, verdict } = await callAndVerify({ manifest: stack.manifest, ...chat })
    assert.ok(verdict.ok)
    // Before P101-b: ['a usage chunk the client did not ask for'] / P101-b 之前：客户端没要的用量块留在流里
    assert.deepEqual(streamProblems({ path: chat.path, body: chat.body, responseBytes }), [])
    const responses = CALLS.find((c) => c.label === 'OpenAI Responses, streamed')
    const raw = await callAndVerify({ manifest: stack.manifest, ...responses })
    assert.deepEqual(streamProblems({ path: responses.path, body: responses.body, responseBytes: raw.responseBytes }), ['the receipt comes after the end of the stream'])
    const api = createTapeAPI({ dev: true })
    const service = await api.resolve({ dev: stack.sidecar.url })
    const client = new OpenAI({ baseURL: `${stack.sidecar.url}/v1`, apiKey: DEMO_KEY, fetch: ai.createVerifyingFetch({ api, service, onReport: () => {} }), maxRetries: 0 })
    await assert.rejects(async () => { for await (const e of await client.responses.create({ model: 'gpt-5-mini', stream: true, input: 'hello' })) void e }, (e) => e.code === 'RECEIPT_INVALID')
  } finally { await stack.close() }
})

test('litellm-sidecar: the official SDKs, streamed and not, verify every receipt in strict mode', { skip: noSdks }, async () => {
  const stack = await startStack()
  try {
    const api = createTapeAPI({ dev: true })
    const service = await api.resolve({ dev: stack.sidecar.url })
    const reports = []
    const fetch = ai.createVerifyingFetch({ api, service, onReport: (r) => reports.push(r) })
    const oa = new OpenAI({ baseURL: `${stack.sidecar.url}/v1`, apiKey: DEMO_KEY, fetch, maxRetries: 0 })
    const an = new Anthropic({ baseURL: stack.sidecar.url, apiKey: DEMO_KEY, fetch, maxRetries: 0 })
    const anBearer = new Anthropic({ baseURL: stack.sidecar.url, apiKey: null, authToken: DEMO_KEY, fetch, maxRetries: 0 })   // as Claude Code
    const drain = async (s) => { for await (const e of s) void e }
    const cases = {
      'chat': () => oa.chat.completions.create({ model: 'gpt-5-mini', messages: [{ role: 'user', content: 'hi' }] }),
      'chat stream': async () => drain(await oa.chat.completions.create({ model: 'deepseek-chat', stream: true, messages: [{ role: 'user', content: 'hi' }] })),
      'responses': () => oa.responses.create({ model: 'gpt-5-mini', input: 'hi' }),
      'responses stream': async () => drain(await oa.responses.create({ model: 'gpt-5-mini', stream: true, input: 'hi' })),
      'responses.stream()': () => oa.responses.stream({ model: 'gpt-5-mini', input: 'hi' }).finalResponse(),
      'embeddings': () => oa.embeddings.create({ model: 'text-embedding-3-small', input: 'tape out' }),
      'messages': () => an.messages.create({ model: 'claude-sonnet-4-5', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] }),
      'messages stream': async () => drain(await an.messages.create({ model: 'claude-sonnet-4-5', max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'hi' }] })),
      'messages stream, Bearer': async () => drain(await anBearer.messages.create({ model: 'claude-sonnet-4-5', max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'hi' }] })),
      'messages.stream()': () => an.messages.stream({ model: 'claude-sonnet-4-5', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] }).finalMessage(),
    }
    for (const [label, run] of Object.entries(cases)) {
      reports.length = 0
      await run()
      await new Promise((r) => setTimeout(r, 20))
      assert.equal(reports.length, 1, label)
      assert.ok(reports[0].ok, `${label}: ${reports[0].problems.join('; ')} ${reports[0].warnings.join('; ')}`)
    }
  } finally { await stack.close() }
})

test('litellm-sidecar: with litellmFormats an event-framed Responses stream verifies too, with or without a trailing data: [DONE]', { skip: noSdks }, async () => {
  // A later LiteLLM (or another upstream) may send event: lines; the receipt must still come once, before the end.
  // 以后的 LiteLLM（或别的上游）可能带 event 行；回执仍须只出现一次、并在结束之前。
  const { handle } = createFakeUpstream()
  for (const trailingDone of [false, true]) {
    const server = http.createServer(async (req, res) => {
      const chunks = []; for await (const c of req) chunks.push(c)
      const headers = new Headers(); for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1])
      const r = await handle(new Request(new URL(req.url, 'http://127.0.0.1'), { method: req.method, headers, body: req.method === 'GET' ? undefined : Buffer.concat(chunks) }))
      let body = await r.text()
      if (trailingDone && (r.headers.get('content-type') || '').includes('event-stream')) body += 'data: [DONE]\n\n'
      const h = Object.fromEntries(r.headers); delete h['content-length']
      res.writeHead(r.status, h); res.end(body)
    })
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
    const stack = await startStack({ upstreamBaseUrl: `http://127.0.0.1:${server.address().port}/v1` })
    try {
      const c = CALLS.find((x) => x.label === 'OpenAI Responses, streamed')
      const { verdict, responseBytes } = await callAndVerify({ manifest: stack.manifest, ...c })
      assert.ok(verdict.ok, verdict.problems.join('; '))
      assert.equal((new TextDecoder().decode(responseBytes).match(/: tapeapi-receipt /g) || []).length, 1)
      assert.deepEqual(streamProblems({ path: c.path, body: c.body, responseBytes }), [])
      const api = createTapeAPI({ dev: true })
      const service = await api.resolve({ dev: stack.sidecar.url })
      const reports = []
      const oa = new OpenAI({ baseURL: `${stack.sidecar.url}/v1`, apiKey: DEMO_KEY, fetch: ai.createVerifyingFetch({ api, service, onReport: (r) => reports.push(r) }), maxRetries: 0 })
      for await (const e of await oa.responses.create({ model: 'gpt-5-mini', stream: true, input: 'hi' })) void e
      await new Promise((r) => setTimeout(r, 20))
      assert.deepEqual(reports.map((r) => r.ok), [true], `trailing [DONE]: ${trailingDone}`)
    } finally { await stack.close(); server.closeAllConnections(); await new Promise((ok) => server.close(ok)) }
  }
})

test('litellm-sidecar: the smoke script runs as a program and every receipt verifies', async () => {
  const { spawnSync } = await import('node:child_process')
  const r = spawnSync(process.execPath, [here('smoke.mjs')], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

test('litellm-sidecar: e2e.mjs without LiteLLM says what it needs and exits 2', async () => {
  const { spawnSync } = await import('node:child_process')
  const env = { ...process.env }; delete env.LITELLM_URL; delete env.LITELLM_BIN
  const r = spawnSync(process.execPath, [here('e2e.mjs')], { encoding: 'utf8', env })
  if (noSdks) return
  assert.equal(r.status, 2, r.stdout + r.stderr)
  assert.match(r.stderr, /set LITELLM_BIN .* or LITELLM_URL and LITELLM_KEY/)
})
