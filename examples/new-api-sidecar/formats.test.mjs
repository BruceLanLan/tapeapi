// E14: the FORMATS switch of the new-api package (server.mjs) and of the Worker sidecar (examples/ai-proxy/worker.js).
// The manifest is a public statement on chain: it should declare only the API formats the relay really serves. FORMATS
// selects them; unset is the four formats 2.0.0 published, with a warning naming the variable (B-6); an unknown name is
// setup mode naming the variable; a model limited to a disabled format is a clear error; the manifest and the receipts
// carry exactly the selected formats. Network-free (loopback only).
// E14：new-api 一键包与 Worker 旁路的 FORMATS 开关。清单是链上的公开声明，应只声明中转站真正提供的格式。未设 = 2.0.0 发布的四种格式，
// 并警告、点名该变量（B-6）；名字不认识 = 设置模式并点名该变量；模型限定了被禁用的格式 = 明确报错；清单与回执恰好只含所选格式。
// 不联网（只用回环地址）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ai } from '@tapeapi/sdk'
import { readConfig, readModels, createSidecar, startSidecar, selectFormats, FORMATS_VAR, NEW_API_PROFILE, REQUIRED } from './server.mjs'
import { throwawayIdentity, startStack, callAndVerify, EXAMPLE_MODELS } from './smoke.mjs'
import { readConfig as readLiteLLMConfig, createSidecar as createLiteLLMSidecar } from '../litellm-sidecar/server.mjs'
import worker, { build as buildWorker, formatsOf } from '../ai-proxy/worker.js'
import { diagnose, formatReport } from '../../sdk/src/doctor.js'
import { DEMO_KEY } from '../ai-proxy/fake-upstream.mjs'

const tmp = mkdtempSync(join(tmpdir(), 'new-api-formats-'))
test.after(() => rmSync(tmp, { recursive: true, force: true }))
const file = (name, value) => { const p = join(tmp, name); writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value)); return p }
const price = (input, output) => [{ currency: 'USD', unit: '1M tokens', input, output }]
// A chat-only table, as a relay whose channels are OpenAI-compatible writes it. / 只有 Chat 的价目表。
const CHAT_ONLY = file('chat-only.json', [{ id: 'model-a', prices: price('0.25', '2') }, { id: 'gpt-5-mini', prices: price('0.25', '2') }])
const complete = (extra = {}) => ({ ...throwawayIdentity(), PUBLIC_URL: 'https://api.example.com', MODELS_FILE: CHAT_ONLY, ...extra })
const ALL = ai.FORMATS.map((f) => f.name)

// B-6 (2.1 review, "FORMATS unset defaults to all with a warning"): an unset FORMATS no longer stops the sidecar in setup
// mode (a 2.0.0 deployment answered every /v1/* call 503 after the upgrade). It publishes and signs the four formats, as
// 2.0.0 did, and says so in the startup log and in /tapeapi/v1/health, naming FORMATS and its values. Setting FORMATS
// still narrows the formats exactly as before (E14-2, E14-7).
// 未设 FORMATS 不再停在设置模式（2.0.0 的部署升级后所有 /v1/* 都会 503），而是像 2.0.0 一样发布并签四种格式，并在启动日志与
// /tapeapi/v1/health 里点名 FORMATS 与可选值。设了 FORMATS 仍按原样收窄（E14-2、E14-7）。
const UNSET_WARNING = /^FORMATS is not set, so every format is published and signed \(openai-chat, openai-responses, anthropic-messages, openai-embeddings\), as 2\.0\.0 did; set FORMATS to the formats your new-api really serves, comma-separated among openai-chat, openai-responses, anthropic-messages, openai-embeddings, or all \(a relay whose channels are OpenAI-compatible only sets FORMATS=openai-chat\)$/

test('FIXED E14-1 (B-6): FORMATS unset publishes the four formats, as 2.0.0 did, with a warning naming FORMATS; set, no warning', async () => {
  const s = readConfig(complete())
  assert.equal(s.ok, true, s.problem)
  assert.deepEqual(s.config.formats.map((f) => f.name), ALL)
  assert.match(s.config.formatsWarning, UNSET_WARNING)
  // Empty and whitespace count as unset (values pasted with a trailing newline). / 空串与空白都算未设。
  for (const v of ['', ' ', '\n']) assert.match(readConfig(complete({ FORMATS: v })).config.formatsWarning, UNSET_WARNING, JSON.stringify(v))
  // Nothing set: FORMATS is not among the missing variables. / 什么都没设：FORMATS 不在缺项里。
  assert.deepEqual(readConfig({}).missing, ['SIGNER_KEY (secret)', ...REQUIRED])
  assert.equal(NEW_API_PROFILE.warnFormatsUnset, true)
  // Set, even to all: no warning, the formats as chosen. / 设了（哪怕是 all）：没有警告，格式按所选。
  for (const v of ['all', 'openai-chat']) assert.equal(readConfig(complete({ FORMATS: v })).config.formatsWarning, null, v)
  // Over HTTP: health ok with the warning, the manifest has the four endpoints, an AI call goes through.
  // HTTP：health 正常并带警告，清单有四个端点，AI 调用正常转发。
  const sc = await startSidecar({ env: complete({ PUBLIC_URL: undefined, MODELS_FILE: EXAMPLE_MODELS }), port: 0, host: '127.0.0.1', quiet: true, localPublicUrl: true, log: () => {} })
  try {
    const h = await (await fetch(`${sc.url}/tapeapi/v1/health`)).json()
    assert.equal(h.setup, undefined); assert.match(h.warning, UNSET_WARNING)
    assert.deepEqual(h.ai.endpoints.map((e) => e.format), ALL)
    const m = await (await fetch(`${sc.url}/.well-known/tapeapi.json`)).json()
    assert.deepEqual(m.ai.endpoints.map((e) => e.format), ALL)
    assert.equal(JSON.stringify(m).includes('warning'), false, 'the manifest itself carries no warning')
  } finally { await sc.close() }
  // Explicitly set: health has no warning. / 显式设置：health 没有警告。
  const set = await startSidecar({ env: complete({ PUBLIC_URL: undefined, FORMATS: 'openai-chat' }), port: 0, host: '127.0.0.1', quiet: true, localPublicUrl: true, log: () => {} })
  try { assert.equal((await (await fetch(`${set.url}/tapeapi/v1/health`)).json()).warning, undefined) } finally { await set.close() }
})

test('FIXED E14-1b (B-6): the startup log warns when FORMATS is unset, naming FORMATS and its values, and not when it is set', async () => {
  const logOf = async (env) => {
    const lines = []
    const orig = console.log
    console.log = (l) => lines.push(String(l))
    let sc
    try { sc = await startSidecar({ env, port: 0, host: '127.0.0.1', localPublicUrl: true, log: () => {} }) } finally { console.log = orig }
    await sc.close()
    return lines.join('\n')
  }
  const unset = await logOf(complete({ PUBLIC_URL: undefined, MODELS_FILE: EXAMPLE_MODELS }))
  assert.doesNotMatch(unset, /SETUP MODE/)
  assert.match(unset, /WARNING {2}FORMATS is not set, so every format is published and signed \(openai-chat, openai-responses, anthropic-messages, openai-embeddings\), as 2\.0\.0 did; set FORMATS to the formats your new-api really serves, comma-separated among .*, or all \(a relay whose channels are OpenAI-compatible only sets FORMATS=openai-chat\)/)
  assert.doesNotMatch(await logOf(complete({ PUBLIC_URL: undefined, FORMATS: 'openai-chat' })), /WARNING|FORMATS is not set/)
})

test('FIXED E14-2: FORMATS=openai-chat publishes exactly one endpoint, and the order of the names does not matter', async () => {
  const s = readConfig(complete({ FORMATS: 'openai-chat' }))
  assert.equal(s.ok, true, s.problem)
  assert.deepEqual(s.config.formats.map((f) => f.name), ['openai-chat'])
  const sc = createSidecar(complete({ FORMATS: 'openai-chat' }), { log: () => {} })
  assert.deepEqual(sc.proxy.manifest().ai.endpoints, [{ format: 'openai-chat', baseUrl: 'https://api.example.com/v1' }])
  // Any spelling of a selection gives the same manifest bytes: canonical order, duplicates once. / 同一选择任何写法清单字节相同。
  const two = (v) => JSON.stringify(createSidecar(complete({ FORMATS: v }), { log: () => {} }).proxy.manifest().ai.endpoints)
  assert.equal(two('anthropic-messages,openai-chat'), two('openai-chat, anthropic-messages'))
  assert.equal(two('openai-chat anthropic-messages openai-chat'), two('openai-chat,anthropic-messages'))
  assert.deepEqual(JSON.parse(two('anthropic-messages,openai-chat')).map((e) => e.format), ['openai-chat', 'anthropic-messages'])
  // "all" is the four, explicitly chosen. / all 即四种，须显式选择。
  assert.deepEqual(readConfig(complete({ FORMATS: 'all', MODELS_FILE: EXAMPLE_MODELS })).config.formats.map((f) => f.name), ALL)
  assert.deepEqual(readConfig(complete({ FORMATS: 'ALL', MODELS_FILE: EXAMPLE_MODELS })).config.formats.map((f) => f.name), ALL)
  // The served manifest and a verified receipt, end to end over HTTP. / 经 HTTP 端到端：提供的清单与核验通过的回执。
  const stack = await startStack({ env: { FORMATS: 'openai-chat', MODELS_FILE: CHAT_ONLY } })
  try {
    assert.deepEqual(stack.manifest.ai.endpoints.map((e) => e.format), ['openai-chat'])
    const { res, verdict, envelope } = await callAndVerify({ manifest: stack.manifest, format: 'openai-chat', path: '/v1/chat/completions', body: { model: 'gpt-5-mini', messages: [{ role: 'user', content: 'hi' }] } })
    assert.equal(res.status, 200); assert.ok(verdict.ok, verdict.problems.join('; ')); assert.ok(envelope.result.prices)
    assert.deepEqual(stack.sidecar.proxy.stats().formats, ['openai-chat'])
  } finally { await stack.close() }
})

test('FIXED E14-3: an unknown format name, or no name at all, is setup mode naming FORMATS and the name', () => {
  const cases = [
    ['openai', /FORMATS names a format this sidecar does not know \("openai"\): choose among openai-chat, openai-responses, anthropic-messages, openai-embeddings \(comma-separated\), or all; a relay whose channels are OpenAI-compatible only sets FORMATS=openai-chat/],
    ['openai-chat,claude', /does not know \("claude"\)/],
    ['gemini, openai-image', /formats this sidecar does not know \("gemini", "openai-image"\)/],
    ['OpenAI-Chat', /does not know \("OpenAI-Chat"\)/],   // names are exact / 名字逐字匹配
    ['all,openai-chat', /does not know \("all"\)/],        // "all" stands alone / all 只能单独使用
    [',', /FORMATS names no format/],
  ]
  for (const [v, re] of cases) {
    const s = readConfig(complete({ FORMATS: v }))
    assert.equal(s.ok, false, v)
    assert.match(s.problem, re, v)
    assert.equal(createSidecar(complete({ FORMATS: v }), { log: () => {} }).proxy, null, `${v}: never a crash, never a proxy`)
  }
  assert.equal(typeof selectFormats('openai-chat'), 'object')
})

test('FIXED E14-4: a model whose "formats" lists a format FORMATS does not enable is a clear error naming the model and FORMATS', () => {
  const p = file('limited.json', [{ id: 'model-a', prices: price('1', '2') }, { id: 'embed-x', formats: ['openai-embeddings'], prices: price('0.02', '0') }])
  const s = readConfig(complete({ FORMATS: 'openai-chat', MODELS_FILE: p }))
  assert.equal(s.ok, false)
  assert.equal(s.problem, `the price table in ${p} is not valid: models[1] (embed-x) lists openai-embeddings in "formats", which FORMATS does not enable (enabled: openai-chat); remove it from the model's "formats" or add it to FORMATS`)
  // The same table is fine once the format is enabled; the repository's example table needs embeddings too.
  // 启用该格式后同一张表没问题；仓库的示例价目表同样需要 embeddings。
  assert.equal(readConfig(complete({ FORMATS: 'openai-chat,openai-embeddings', MODELS_FILE: p })).ok, true)
  assert.match(readConfig(complete({ FORMATS: 'openai-chat', MODELS_FILE: EXAMPLE_MODELS })).problem, /\(text-embedding-3-small\) lists openai-embeddings in "formats", which FORMATS does not enable/)
  // A name no adapter knows keeps the generic rule. / 没有适配器认识的名字仍按通用规则报错。
  assert.match(readModels(file('unknown.json', [{ id: 'm', formats: ['gemini'], prices: price('1', '1') }]), undefined, selectFormats('openai-chat')), /formats must list formats among the endpoints/)
  // readModels keeps its default (every format) for callers that pass none. / 不传格式的调用者保持默认（全部格式）。
  assert.ok(Array.isArray(readModels(p)))
})

test('FIXED E14-5: the Worker sidecar has the same switch: unset is the four formats with a warning in health, unknown is setup mode naming FORMATS; the manifest carries the selection', async () => {
  const id = throwawayIdentity()
  const env = (extra = {}) => ({ ...id, PUBLIC_URL: 'https://ai.example.com', UPSTREAM_BASE_URL: 'https://up.example/v1', MODELS_JSON: readFileSync(CHAT_ONLY, 'utf8'), ...extra })
  const health = async (e) => (await worker.fetch(new Request('https://ai.example.com/tapeapi/v1/health'), e)).json()
  // B-6: unset is the four formats, as 2.0.0 published, and health carries the warning (the Node package's sentence).
  // 未设：四种格式（与 2.0.0 相同），health 带警告（与 Node 版同一句话）。
  const warns = [], orig = console.warn
  console.warn = (...a) => warns.push(a.join(' '))
  let unset
  try { unset = await health(env()) } finally { console.warn = orig }
  assert.equal(unset.setup, undefined)
  assert.match(unset.warning, /^FORMATS is not set, so every format is published and signed \(openai-chat, openai-responses, anthropic-messages, openai-embeddings\), as 2\.0\.0 did; set FORMATS to the formats your upstream really serves, comma-separated among .*, or all \(an upstream that is OpenAI-compatible only sets FORMATS=openai-chat\)$/)
  assert.deepEqual(unset.ai.endpoints.map((e) => e.format), ALL)
  assert.ok(warns.some((w) => /^\[ai-proxy\] WARNING FORMATS is not set/.test(w)), 'one console warning')
  assert.deepEqual(formatsOf(env()).map((f) => f.name), ALL)
  assert.deepEqual((await buildWorker(env(), { log: () => {} }).ready).ai.endpoints.map((e) => e.format), ALL)
  assert.match((await health(env({ FORMATS: 'openai' }))).problem, /FORMATS names a format this sidecar does not know \("openai"\)/)
  assert.match(formatsOf({ FORMATS: ' , ' }), /FORMATS names no format/)
  // Selected: exactly the chosen endpoints, in canonical order. / 已选：恰好所选端点，固定顺序。
  const w = buildWorker(env({ FORMATS: 'openai-chat' }), { log: () => {} })
  assert.deepEqual((await w.ready).ai.endpoints, [{ format: 'openai-chat', baseUrl: 'https://ai.example.com/v1' }])
  assert.deepEqual((await buildWorker(env({ FORMATS: 'anthropic-messages,openai-chat' }), { log: () => {} }).ready).ai.endpoints.map((e) => e.format), ['openai-chat', 'anthropic-messages'])
  assert.deepEqual((await buildWorker(env({ FORMATS: 'all' }), { log: () => {} }).ready).ai.endpoints.map((e) => e.format), ALL)
  // A model limited to a disabled format: the same sentence as the Node package. / 与 Node 版同一句话。
  const limited = JSON.stringify([{ id: 'model-a', prices: price('1', '2') }, { id: 'embed-x', formats: ['openai-embeddings'], prices: price('0.02', '0') }])
  assert.throws(() => buildWorker(env({ FORMATS: 'openai-chat', MODELS_JSON: limited }), { log: () => {} }), /models\[1\] \(embed-x\) lists openai-embeddings in "formats", which FORMATS does not enable \(enabled: openai-chat\)/)
})

test('FIXED E14-6: tapeapi-doctor passes against a sidecar that declares openai-chat only, probing that endpoint', async () => {
  const stack = await startStack({ env: { FORMATS: 'openai-chat', MODELS_FILE: CHAT_ONLY } })
  try {
    const rep = await diagnose(stack.sidecar.url, { offline: true })
    assert.equal(rep.exitCode, 0, formatReport(rep, { lang: 'en' }))
    const endpoints = rep.checks.find((c) => c.id === 'endpoints')
    assert.equal(endpoints.status, 'pass'); assert.match(endpoints.detail, /^openai-chat http:\/\/127\.0\.0\.1:\d+\/v1$/)
    assert.equal(rep.checks.find((c) => c.id === 'receipt').status, 'pass', formatReport(rep, { lang: 'en' }))
  } finally { await stack.close() }
})

// FIXED E14-7 / FIXED F-1: a metered path of a format FORMATS leaves out used to pass through to new-api with no receipt
// and no signal (and new-api serves /v1/messages natively). It is now refused like a loose path: HTTP 400 bad_path with
// the sidecar-error header, naming the format and FORMATS, never forwarded. Unmetered paths still pass through.
// FORMATS 未启用的格式的计量路径曾无回执、无信号地透传给 new-api；现在与宽松路径一样拒绝：400 bad_path，带旁路错误头，点名该格式与
// FORMATS，绝不转发。非计量路径照旧透传。
test('FIXED E14-7 / F-1: a metered path of a format FORMATS leaves out is refused (HTTP 400 naming FORMATS), never forwarded; other paths still pass through', async () => {
  const seen = []
  const upstream = async (url) => { seen.push(String(url)); return new Response('{"object":"list","data":[]}', { status: 200, headers: { 'content-type': 'application/json' } }) }
  const sc = createSidecar(complete({ FORMATS: 'openai-chat', UPSTREAM_BASE_URL: 'http://new-api.invalid/v1' }), { fetch: upstream, log: () => {} })
  assert.ok(sc.proxy, sc.state.problem)
  const post = (path, headers = {}) => sc.handleRequest(new Request(`https://api.example.com${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${DEMO_KEY}`, ...headers }, body: '{"model":"gpt-5-mini","input":"hi"}' }), { clientIp: '127.0.0.1' })
  const cases = [
    ['/v1/messages', 'anthropic-messages'], ['/v1/responses', 'openai-responses'], ['/v1/embeddings', 'openai-embeddings'],
    // written loosely too / 宽松写法同样拒绝
    ['/v1//messages', 'anthropic-messages'], ['/v1/messages/', 'anthropic-messages'], ['/v1/%72esponses', 'openai-responses'],
  ]
  for (const [path, name] of cases) {
    for (const headers of [{}, { 'x-api-key': DEMO_KEY, 'anthropic-version': '2023-06-01' }]) {
      const r = await post(path, headers)
      assert.equal(r.status, 400, path)
      assert.equal(r.headers.get(ai.SIDECAR_ERROR_HEADER), '1', path)
      assert.equal(r.headers.get(ai.RECEIPT_HEADER), null, path)
      const { error } = await r.json()
      assert.equal(error.code, 'bad_path', path)
      assert.ok(error.message.startsWith(`POST ${path} is a ${name} path, a format this sidecar does not serve (it serves openai-chat): refused, not forwarded, no receipt; FORMATS does not enable it; if your upstream really serves it, add it to FORMATS (comma-separated among openai-chat, openai-responses, anthropic-messages, openai-embeddings, or all)`), error.message)
    }
  }
  assert.deepEqual(seen, [], 'nothing reached new-api')
  // Unmetered paths pass through as before (models, count_tokens), and so does the enabled format. / 非计量路径照旧透传。
  assert.equal((await sc.handleRequest(new Request('https://api.example.com/v1/models'), { clientIp: '127.0.0.1' })).status, 200)
  assert.equal((await post('/v1/messages/count_tokens')).status, 200)
  assert.equal(seen.length, 2)
  // Over HTTP too, with the manifest still declaring openai-chat only. / 经 HTTP 同样如此，清单仍只声明 openai-chat。
  const stack = await startStack({ env: { FORMATS: 'openai-chat', MODELS_FILE: CHAT_ONLY } })
  try {
    const a = await fetch(`${stack.sidecar.url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': DEMO_KEY, 'anthropic-version': '2023-06-01' }, body: '{}' })
    assert.equal(a.status, 400); assert.match((await a.json()).error.message, /anthropic-messages path.*FORMATS does not enable it/)
    assert.ok(!stack.manifest.ai.endpoints.some((e) => e.format !== 'openai-chat'))
  } finally { await stack.close() }
  // FORMATS=all refuses nothing. / FORMATS=all 不拒绝任何格式。
  const all = createSidecar(complete({ FORMATS: 'all', MODELS_FILE: EXAMPLE_MODELS, UPSTREAM_BASE_URL: 'http://new-api.invalid/v1' }), { fetch: upstream, log: () => {} })
  assert.notEqual((await all.handleRequest(new Request('https://api.example.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), { clientIp: '127.0.0.1' })).status, 400)
})

test('FIXED F-1: the Worker sidecar refuses a format FORMATS leaves out the same way; createAIProxy keeps passing it through unless refuseOtherFormats is set', async () => {
  const seen = []
  const upstream = async (url) => { seen.push(String(url)); return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }) }
  const id = throwawayIdentity()
  const w = buildWorker({ ...id, PUBLIC_URL: 'https://ai.example.com', UPSTREAM_BASE_URL: 'https://up.example/v1', MODELS_JSON: readFileSync(CHAT_ONLY, 'utf8'), FORMATS: 'openai-chat' }, { fetch: upstream, log: () => {} })
  const r = await w.handleRequest(new Request('https://ai.example.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), { clientIp: '1.1.1.1' })
  assert.equal(r.status, 400); assert.equal(r.headers.get(ai.SIDECAR_ERROR_HEADER), '1')
  assert.match((await r.json()).error.message, /anthropic-messages path, a format this sidecar does not serve \(it serves openai-chat\).*FORMATS does not enable it/)
  assert.deepEqual(seen, [])
  // The package default is unchanged (experimental option, off by default). / 包的默认行为不变（实验性选项，默认关闭）。
  const s = readConfig(complete({ FORMATS: 'openai-chat' }))
  const base = { formats: s.config.formats, upstream: { baseUrl: 'https://up.example/v1' }, manifestBase: s.config.manifestBase, signerKey: s.config.signerKey, models: s.config.models, fetch: upstream, log: () => {} }
  const { createAIProxy } = await import('@tapeapi/server/ai-proxy')
  const plain = createAIProxy(base)
  assert.equal((await plain.handleRequest(new Request('https://api.example.com/v1/messages', { method: 'POST', body: '{}' }), { clientIp: '1.1.1.1' })).status, 200)
  assert.equal(seen.length, 1)
  const bare = createAIProxy({ ...base, refuseOtherFormats: true })
  const b = await bare.handleRequest(new Request('https://api.example.com/v1/embeddings', { method: 'POST', body: '{}' }), { clientIp: '1.1.1.1' })
  assert.equal(b.status, 400); assert.equal((await b.json()).error.message, 'POST /v1/embeddings is a openai-embeddings path, a format this sidecar does not serve (it serves openai-chat): refused, not forwarded, no receipt')
  for (const bad of ['yes', 1, { hint: 2 }, []]) assert.throws(() => createAIProxy({ ...base, refuseOtherFormats: bad }), /refuseOtherFormats must be true, false or \{ hint\?: string \}/, JSON.stringify(bad))
})

test('FIXED F-1: the verifying side knows every built-in format: createVerifyingFetch and tapeapi-verify never pass a call to an undeclared format silently', async () => {
  const stack = await startStack({ env: { FORMATS: 'openai-chat', MODELS_FILE: CHAT_ONLY } })
  try {
    const svc = { manifest: stack.manifest, container: stack.manifest.container, verified: { dev: true } }
    const root = stack.sidecar.url
    const calls = []
    const counting = (u, i) => { calls.push(String(u)); return fetch(u, i) }
    const body = JSON.stringify({ model: 'gpt-5-mini', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] })
    // Strict (the default): refused before anything is sent, naming the format. / strict（默认）：发出前拒绝，点名格式。
    const strict = ai.createVerifyingFetch({ service: svc, fetch: counting, onReport: () => assert.fail('no report in strict mode') })
    for (const [path, name] of [['/v1/messages', 'anthropic-messages'], ['/v1/responses', 'openai-responses'], ['/v1/embeddings', 'openai-embeddings'], ['/v1//messages', 'anthropic-messages']]) {
      await assert.rejects(strict(`${root}${path}`, { method: 'POST', headers: { authorization: `Bearer ${DEMO_KEY}` }, body }), (e) => {
        assert.equal(e.code, 'INVALID_ARGUMENT', path)
        assert.match(e.message, new RegExp(`is a metered ${name} call, but the service's manifest declares no ${name} endpoint \\(it declares openai-chat\\)`))
        assert.deepEqual(e.data, { format: name, declared: ['openai-chat'] })
        return true
      })
    }
    assert.deepEqual(calls, [], 'nothing was sent')
    // Unmetered paths and other hosts are left alone. / 非计量路径与别的主机不受影响。
    assert.equal((await strict(`${root}/v1/models`, { headers: { authorization: `Bearer ${DEMO_KEY}` } })).status, 200)
    assert.equal(calls.length, 1)
    // Not strict: sent, the sidecar refuses it, and onReport says it was not verified. / 非 strict：发出，旁路拒绝，onReport 说明未核验。
    const reports = []
    const lax = ai.createVerifyingFetch({ service: svc, fetch: counting, strict: false, onReport: (r) => reports.push(r) })
    const r = await lax(`${root}/v1/messages`, { method: 'POST', headers: { authorization: `Bearer ${DEMO_KEY}` }, body })
    assert.equal(r.status, 400); await r.arrayBuffer()
    assert.equal(reports.length, 1); assert.equal(reports[0].ok, false); assert.equal(reports[0].mismatch, true)
    assert.match(reports[0].problems[0], /^not verified: format not declared: /)

    // tapeapi-verify: route() names the undeclared format; --strict answers 400 without forwarding, otherwise it logs FAIL.
    // tapeapi-verify：route() 点名未声明的格式；--strict 回 400 不转发，否则记 FAIL。
    const { routesOf, route } = await import('../../sdk/bin/tapeapi-verify.js')
    const routes = routesOf(stack.manifest)
    assert.equal(route(routes, 'POST', '/v1/messages', new Headers()).undeclared.name, 'anthropic-messages')
    assert.equal(route(routes, 'POST', '/v1//responses', new Headers()).undeclared.name, 'openai-responses')
    assert.equal(route(routes, 'GET', '/v1/models', new Headers()).undeclared, undefined)
    assert.equal(route(routes, 'POST', '/v1/chat/completions', new Headers()).metered, true)
    const v = await startVerify(root, ['--strict'])
    const loose = await startVerify(root)
    try {
      const before = stack.sidecar.proxy.stats().requests
      const a = await fetch(`${v.url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${DEMO_KEY}` }, body })
      assert.equal(a.status, 400)
      const j = await a.json()
      assert.equal(j.type, 'error'); assert.match(j.error.message, /declares no anthropic-messages endpoint/)
      assert.equal(stack.sidecar.proxy.stats().requests, before, 'nothing reached the sidecar')
      const b = await fetch(`${loose.url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${DEMO_KEY}` }, body })
      assert.equal(b.status, 400); await b.arrayBuffer()
      await waitFor(() => /FAIL POST \/v1\/messages is a metered anthropic-messages call.*passed on, not verified/.test(loose.out()))
    } finally { await v.close(); await loose.close() }
  } finally { await stack.close() }
})

// tapeapi-verify as a child process, in its --dev URL mode. / 以 --dev 地址模式启动 tapeapi-verify 子进程。
function startVerify(url, extra = []) {
  const bin = fileURLToPath(new URL('../../sdk/bin/tapeapi-verify.js', import.meta.url))
  const child = spawn(process.execPath, [bin, '--dev', url, '--port', '0', ...extra], { stdio: ['ignore', 'ignore', 'pipe'] })
  let text = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (d) => { text += d })
  return new Promise((ok, no) => {
    const t = setTimeout(() => no(new Error(`tapeapi-verify did not start:\n${text}`)), 15_000)
    const on = () => { const m = /listening on (http:\/\/\S+)/.exec(text); if (m) { clearTimeout(t); child.stderr.off('data', on); ok({ url: m[1], out: () => text, close: () => new Promise((r) => { if (child.exitCode !== null) return r(); child.once('exit', r); child.kill('SIGTERM') }) }) } }
    child.stderr.on('data', on)
    child.once('exit', (c) => { clearTimeout(t); no(new Error(`tapeapi-verify exited (${c}):\n${text}`)) })
  })
}
async function waitFor(cond, what = 'the condition') {
  for (let i = 0; i < 500; i++) { if (cond()) return; await new Promise((r) => setTimeout(r, 10)) }
  assert.fail(`timed out waiting for ${what}`)
}

test('FIXED E14-8: the LiteLLM package is unchanged: FORMATS stays optional there (unset keeps its four adapters), and narrows when set', () => {
  const id = { ...throwawayIdentity(), PUBLIC_URL: 'https://api.example.com', MODELS_FILE: EXAMPLE_MODELS }
  const s = readLiteLLMConfig(id)
  assert.equal(s.ok, true, s.problem)
  assert.deepEqual(s.config.formats.map((f) => f.name), ALL)
  const narrowed = readLiteLLMConfig({ ...id, MODELS_FILE: CHAT_ONLY, FORMATS: 'openai-responses,openai-chat' })
  assert.deepEqual(narrowed.config.formats.map((f) => f.name), ['openai-chat', 'openai-responses'])
  // The LiteLLM adapters are kept (not swapped for the plain ones): its Responses stream also ends at [DONE].
  // 保留 LiteLLM 的适配器（不换成普通的）：其 Responses 流也以 [DONE] 结束。
  assert.ok(narrowed.config.formats[1].stream.final.data.includes('[DONE]'))
  assert.ok(!ai.FORMATS.find((f) => f.name === 'openai-responses').stream.final.data?.includes('[DONE]'))
})

test('FIXED F-1: the LiteLLM package refuses a format its FORMATS leaves out (it shares the new-api package\'s buildProxy)', async () => {
  const seen = []
  const sc = createLiteLLMSidecar({ ...throwawayIdentity(), PUBLIC_URL: 'https://api.example.com', MODELS_FILE: CHAT_ONLY, FORMATS: 'openai-chat', UPSTREAM_BASE_URL: 'http://litellm.invalid/v1' }, { fetch: async (u) => { seen.push(String(u)); return new Response('{}') }, log: () => {} })
  const r = await sc.handleRequest(new Request('https://api.example.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), { clientIp: '127.0.0.1' })
  assert.equal(r.status, 400); assert.match((await r.json()).error.message, /anthropic-messages path.*FORMATS does not enable it/)
  assert.deepEqual(seen, [])
})

test('FIXED E14-9: the one-command package documents FORMATS: env.example leaves it to the operator, compose passes it, both README languages explain it', () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
  assert.match(read('env.example'), /^FORMATS=$/m)
  assert.match(read('env.example'), /FORMATS=openai-chat/)
  assert.match(read('docker-compose.yml'), /^ {6}FORMATS: \$\{FORMATS:-\}$/m)
  const readme = read('README.md')
  const [zh, en] = readme.split('\n## English\n')
  assert.match(zh, /FORMATS=openai-chat/); assert.match(zh, /未设时按 `all`/)
  assert.match(en, /FORMATS=openai-chat/); assert.match(en, /unset, it runs as `all`/)
  const toml = read('../ai-proxy/wrangler.toml')
  assert.match(toml, /^# FORMATS = "openai-chat"$/m)
  assert.match(read('../ai-proxy/README.md'), /FORMATS/)
})
