// The spot-check probe (A9): the tokenizer engine on synthetic vocabularies (and on the real pinned files when they are
// cached), the fixed probe set, runs against the signing sidecar in front of the fake upstream (token counts reported
// the way one tokenizer family would, or in words), receipt verification recorded as it is, no API key anywhere in the
// output, the report, and the rule that the tool records raw data and never a verdict. No network: in-process fetch, and
// a loopback server for the CLI.
// 抽检探针：分词引擎（合成词表；缓存了真实文件时也测真实文件）、固定探测集、在签名旁路 + 模拟上游上运行（按某个分词器族或按单词
// 上报 token 数）、如实记录回执核验结果、输出中绝无 API 密钥、报告，以及"只记录原始数据、从不下结论"。不联网。
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAIProxy } from '@tapeapi/server/ai-proxy'
import { createTapeAPI } from '@tapeapi/sdk'
import { createFakeUpstream } from '../ai-proxy/fake-upstream.mjs'
import { runProbes, loadProbes, bodyOf, parseArgs, readAnswer } from './probe.mjs'
import { renderReport, parseRecords, LEGEND } from './report.mjs'
import { fromTiktoken, fromTokenizerJson, hfRegex, FAMILIES, NOT_OFFLINE, readCached, computeExpected, defaultCacheDir } from './tokenizers.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const KEY = 'sk-spot-test-7f3c9a1e5b2d4c6f8a0b'
const SIGNER_KEY = '0x' + '5a'.repeat(32)
const PROBES = loadProbes()
const MODELS = JSON.parse(readFileSync(new URL('../ai-proxy/models.json', import.meta.url), 'utf8'))
const MANIFEST = JSON.parse(readFileSync(new URL('../ai-proxy/manifest.json', import.meta.url), 'utf8'))
const TOKEN_PROBES = PROBES.probes.filter((p) => p.kind === 'tokens')
// Words a report or a record must never use: the tool states numbers, it does not judge. / 报告与记录绝不使用的词。
const JUDGEMENT = /\b(verdict|genuine|fake|suspicious|substitut\w*|fraud\w*|cheat\w*|likely|probably|pass(es|ed)?|guilty|honest|dishonest|score)\b/i
const te = new TextEncoder()

// ---------------------------------------------------------------------------------------------------------------
// The fake upstream, told how to count prompt tokens / 被告知如何计 prompt token 的模拟上游
// ---------------------------------------------------------------------------------------------------------------
const TEXT_TO_PROBE = new Map(TOKEN_PROBES.map((p) => [p.tokenText, p.id]))
const userText = (path, body) => (path.endsWith('/responses') ? body.input : body.messages?.[0]?.content)
/**
 * An upstream fetch: the fake API, whose non-stream answers to token probes report prompt tokens as `family` counts the
 * probe text plus `overhead` (null: the fake's own word count). `edit(json)` may change any answer.
 * 上游 fetch：模拟接口；对 token 探测的非流式回答，按 family 的计数加 overhead 上报 prompt token（null：保持模拟接口的按词计数）。
 */
function upstream({ family = null, overhead = 0, edit } = {}) {
  const fake = createFakeUpstream({ keys: [KEY] })
  return async (url, init) => {
    const bytes = init.body == null ? null : new Uint8Array(init.body)
    const res = await fake.fetch(url, { ...init, body: bytes })
    if (!(res.headers.get('content-type') || '').includes('application/json') || !bytes) return res
    const path = new URL(url).pathname
    const body = JSON.parse(new TextDecoder().decode(bytes))
    const j = await res.json()
    const id = TEXT_TO_PROBE.get(userText(path, body))
    if (family && id) {
      const n = PROBES.tokenizers.expected[family][id] + overhead
      if (path.endsWith('/chat/completions')) j.usage = { ...j.usage, prompt_tokens: n, total_tokens: n + j.usage.completion_tokens }
      else if (path.endsWith('/responses')) j.usage = { ...j.usage, input_tokens: n, input_tokens_details: { cached_tokens: 0 }, total_tokens: n + j.usage.output_tokens }
      else if (path.endsWith('/messages')) j.usage = { ...j.usage, input_tokens: n, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } }
    }
    if (edit) edit(j, { path, body, id })
    const headers = new Headers(res.headers); headers.delete('content-length')
    return new Response(JSON.stringify(j), { status: res.status, headers })
  }
}

/** A sidecar in front of an upstream fetch, a dev-resolved service and an in-process fetch to it. / 旁路、dev 解析的服务与进程内 fetch。 */
async function setup(upstreamFetch, { base = 'http://127.0.0.1:8798' } = {}) {
  const manifestBase = { ...MANIFEST, endpoints: { live: [`${base}/tapeapi/v1`], async: false } }
  const proxy = createAIProxy({ upstream: { baseUrl: 'http://upstream.invalid/v1' }, fetch: upstreamFetch, manifestBase, signerKey: SIGNER_KEY, models: MODELS, allowHttp: true, log: () => {} })
  const manifest = await proxy.ready
  const svc = await createTapeAPI({ dev: true }).resolve({ dev: manifest })
  const fetch = (url, init) => proxy.handleRequest(new Request(url, init), { clientIp: '127.0.0.1' })
  return { proxy, manifest, svc, fetch }
}

const keysDeep = (v, out = new Set()) => { if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out)); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); keysDeep(x, out) } return out }
const spread = (xs) => Math.max(...xs) - Math.min(...xs)

// ---------------------------------------------------------------------------------------------------------------
// The tokenizer engine / 分词引擎
// ---------------------------------------------------------------------------------------------------------------
test('tokenizers: the tiktoken engine on a synthetic vocabulary (whole piece first, then lowest rank, leftmost on a tie)', () => {
  const lines = []
  for (let b = 0; b < 256; b++) lines.push(`${Buffer.from([b]).toString('base64')} ${b}`)
  for (const [s, r] of [['ab', 256], ['cd', 257], ['abcd', 258], ['bc', 259]]) lines.push(`${Buffer.from(s).toString('base64')} ${r}`)
  const t = fromTiktoken(lines.join('\n'), { pattern: '\\S+|\\s+', name: 'synthetic' })
  assert.equal(t.count('abcd'), 1)                  // the whole piece is a token / 整段就是一个 token
  assert.deepEqual(t.encode('abcd'), [258])
  assert.equal(t.count('abx'), 2)                   // ab + x
  assert.deepEqual(t.encode('cdab'), [257, 256])    // ab (256) merges before cd (257); cdab is no token
  assert.deepEqual(t.encode('abc'), [256, 99])      // ab (256) beats bc (259)
  assert.equal(t.count('abcd abx'), 4)              // abcd | " " | ab x
  assert.equal(t.count('é'), 2)                     // two UTF-8 bytes, no merge / 两个 UTF-8 字节
  assert.equal(t.hasToken('abcd'), true)
  assert.equal(t.hasToken('abx'), false)
})

test('tokenizers: the tokenizer.json engine on a synthetic byte-level BPE (merge ranks, ignore_merges, NFC)', () => {
  const json = (ignore) => ({
    normalizer: { type: 'NFC' },
    pre_tokenizer: { type: 'Sequence', pretokenizers: [{ type: 'Split', pattern: { Regex: '\\s?\\p{L}+|\\s+' }, behavior: 'Isolated', invert: false }, { type: 'ByteLevel', add_prefix_space: false, trim_offsets: false, use_regex: false }] },
    added_tokens: [{ id: 99, content: '<|end|>' }],
    model: { type: 'BPE', dropout: null, byte_fallback: false, ignore_merges: ignore, vocab: { a: 0, b: 1, c: 2, 'Ġ': 3, ab: 4, abc: 5, 'Ġa': 6, 'Ġab': 7, 'Ã': 8, '©': 9, 'Ã©': 10 }, merges: ['a b', 'ab c', ['Ġ', 'a'], 'Ã ©'] },
  })
  const t = fromTokenizerJson(json(false), { name: 'synthetic' })
  assert.deepEqual(t.encode('abc'), [5])            // a b -> ab -> abc
  assert.deepEqual(t.encode(' ab'), [3, 4])         // ab (rank 0) before Ġa (rank 2); "Ġ ab" is no merge
  assert.equal(t.count('abc ab'), 3)
  assert.equal(t.count('\u00e9'), 1)                // é = C3 A9 -> "Ã©"
  assert.equal(t.count('e\u0301'), 1)               // NFC first: e + combining acute -> é
  const u = fromTokenizerJson(json(true), { name: 'synthetic' })
  assert.deepEqual(u.encode(' ab'), [7])            // ignore_merges: the whole piece is in the vocabulary
  assert.throws(() => t.count('x <|end|>'), /special token/)
  assert.equal(t.hasToken(' ab'), true)              // a vocabulary entry, whether or not merges reach it
  assert.equal(t.hasToken('abx'), false)
  assert.equal(t.hasToken(Uint8Array.from([0xc3, 0xa9])), true)
})

test('tokenizers: unsupported components are refused, never approximated', () => {
  const base = { pre_tokenizer: { type: 'ByteLevel', add_prefix_space: false, use_regex: false }, model: { type: 'BPE', vocab: {}, merges: [] } }
  assert.throws(() => fromTokenizerJson({ ...base, normalizer: { type: 'Lowercase' } }), /normalizer Lowercase/)
  assert.throws(() => fromTokenizerJson({ ...base, pre_tokenizer: { type: 'Metaspace' } }), /pre-tokenizer Metaspace/)
  assert.throws(() => fromTokenizerJson({ ...base, pre_tokenizer: { type: 'Split', pattern: { Regex: 'x' }, behavior: 'Removed' } }), /Isolated/)
  assert.throws(() => fromTokenizerJson({ ...base, model: { type: 'Unigram' } }), /only BPE/)
  assert.throws(() => fromTokenizerJson({ ...base, model: { type: 'BPE', byte_fallback: true, vocab: {}, merges: [] } }), /byte_fallback/)
  assert.throws(() => fromTokenizerJson({ ...base, pre_tokenizer: { type: 'ByteLevel', use_regex: true } }), /use_regex/)
  // Regexes: (?i:...) of literals is spelled out; possessive quantifiers, inline flags, && and scripts are refused.
  assert.ok(hfRegex("(?i:'s|'ll)").test("'LL"))
  assert.ok(hfRegex("(?i:'s|'ll)").test("'ſ"))
  assert.throws(() => hfRegex('\\p{L}++'), /unsupported/)
  assert.throws(() => hfRegex('(?x)a'), /unsupported/)
  assert.throws(() => hfRegex('[\\p{L}&&[^a]]'), /unsupported/)
  assert.throws(() => hfRegex('\\p{Han}+'), /unsupported/)
  // Punctuation such as *+ inside a character class is literal, not a quantifier (DeepSeek-V3's pattern).
  assert.ok(hfRegex("[!\"#$%&'()*+,\\-./:;<=>?@\\[\\\\\\]^_`{|}~][A-Za-z]+").test('*abc'))
})

test('tokenizers: every family is pinned to an immutable URL and a sha256; the not-offline ones are named', () => {
  for (const [k, f] of Object.entries(FAMILIES)) {
    assert.match(f.sha256, /^[0-9a-f]{64}$/, k)
    assert.ok(Number.isInteger(f.bytes) && f.bytes > 0, k)
    assert.ok(f.url.startsWith('https://openaipublic.blob.core.windows.net/encodings/') || /^https:\/\/huggingface\.co\/[^/]+\/[^/]+\/resolve\/[0-9a-f]{40}\//.test(f.url), `${k}: ${f.url} is not pinned`)
    assert.ok(['tiktoken', 'hf'].includes(f.kind))
    if (f.kind === 'tiktoken') assert.doesNotThrow(() => new RegExp(f.pattern, f.flags), k)
  }
  assert.ok(NOT_OFFLINE.claude && NOT_OFFLINE.gemini)
})

test('tokenizers: the real pinned files, when cached, reproduce probes.json exactly (skipped when not cached)', (t) => {
  const cacheDir = defaultCacheDir()
  const cached = Object.keys(FAMILIES).filter((f) => { try { return !!readCached(f, { cacheDir }) } catch { return false } })
  if (!cached.length) return t.skip(`no tokenizer files in ${cacheDir} (node examples/spot-check/tokenizers.mjs download)`)
  const { counts } = computeExpected(PROBES, { cacheDir, families: cached })
  for (const f of cached) assert.deepEqual(counts[f], PROBES.tokenizers.expected[f], f)
})

// ---------------------------------------------------------------------------------------------------------------
// The probe set / 探测集
// ---------------------------------------------------------------------------------------------------------------
test('probes.json: versioned, unique ids, bodies per format carry the model placeholder and the token texts exactly', () => {
  assert.match(PROBES.version, /^\d{4}-\d{2}-\d{2}\.\d+$/)
  const ids = PROBES.probes.map((p) => p.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const p of PROBES.probes) {
    assert.ok(p.purpose && p.kind, p.id)
    assert.ok(Array.isArray(p.records) && p.records.includes('receipt') && p.records.includes('receiptVerification'), p.id)
    assert.ok(p.bodies['openai-chat'] && p.bodies['openai-responses'], p.id)
    for (const [fmt, b] of Object.entries(p.bodies)) assert.equal(b.model, '{{model}}', `${p.id} ${fmt}`)
    if (p.kind === 'tokens') {
      assert.equal(p.bodies['openai-chat'].messages[0].content, p.tokenText)
      assert.equal(p.bodies['openai-responses'].input, p.tokenText)
      assert.equal(p.bodies['anthropic-messages'].messages[0].content, p.tokenText)
      for (const fam of Object.keys(FAMILIES)) assert.ok(Number.isInteger(PROBES.tokenizers.expected[fam][p.id]), `${fam} ${p.id}`)
    }
  }
  assert.equal(PROBES.probes.find((p) => p.id === 'logprobs').bodies['anthropic-messages'], undefined)
  for (const [fam, f] of Object.entries(FAMILIES)) assert.equal(PROBES.tokenizers.pins[fam].sha256, f.sha256, fam)
  // The token texts tell the published families apart: every family's vector of differences to the baseline is unique.
  // token 文本能区分各族：每个族相对基线的差值向量互不相同。
  const sig = Object.keys(FAMILIES).map((fam) => TOKEN_PROBES.filter((p) => p.baseline).map((p) => PROBES.tokenizers.expected[fam][p.id] - PROBES.tokenizers.expected[fam][p.baseline]).join(','))
  assert.equal(new Set(sig).size, sig.length)
  // bodyOf: the model filled in, max_tokens renamed or dropped for openai-chat on request.
  const p = PROBES.probes.find((x) => x.id === 'known-arith')
  assert.equal(JSON.parse(bodyOf(p, 'openai-chat', 'm-1')).model, 'm-1')
  assert.equal(JSON.parse(bodyOf(p, 'openai-chat', 'm-1', { chatMaxField: 'max_completion_tokens' })).max_completion_tokens, 64)
  assert.equal('max_tokens' in JSON.parse(bodyOf(p, 'openai-chat', 'm-1', { chatMaxField: 'omit' })), false)
  assert.equal(JSON.parse(bodyOf(p, 'anthropic-messages', 'm-1', { chatMaxField: 'omit' })).max_tokens, 64)
})

// ---------------------------------------------------------------------------------------------------------------
// Runs against the sidecar / 在旁路上运行
// ---------------------------------------------------------------------------------------------------------------
for (const [format, family, overhead] of [['openai-chat', 'qwen2', 9], ['openai-responses', 'o200k', 4], ['anthropic-messages', 'deepseek-v3', 6]]) {
  test(`runProbes (${format}): counts reported as ${family} would give them are recorded next to every family's count, receipts verified`, async () => {
    const { svc, fetch } = await setup(upstream({ family, overhead }))
    const recs = await runProbes({ svc, target: 'dev', model: 'demo-chat', format, apiKey: KEY, runs: 2, fetch, tokenizerCache: join(tmpdir(), 'tapeapi-spot-check-no-cache') })
    const perRun = PROBES.probes.filter((p) => p.bodies[format]).length
    assert.equal(recs.length, perRun * 2)
    for (const r of recs) {
      assert.equal(r.receiptVerification.ok, true, `${r.probeId}: ${r.receiptVerification.problems.join('; ')}`)
      assert.equal(r.service.dev, true)
      assert.equal(r.format, format)
      assert.equal(r.receipt.params.requestSha256, r.request.sha256)          // the receipt binds the exact request recorded
      assert.deepEqual(r.receipt.result.usage, r.usage)                         // and the usage measured
      assert.equal(r.measurements.promptTokens, r.receipt.result.usage.prompt_tokens)
    }
    const tok = recs.filter((r) => r.probeKind === 'tokens')
    assert.equal(tok.length, TOKEN_PROBES.length * 2)
    for (const r of tok) {
      assert.equal(r.measurements.reportedMinusLocal[family], overhead, r.probeId)
      assert.equal(r.measurements.localTokens[family], PROBES.tokenizers.expected[family][r.probeId])
      if (r.probeId !== 'tok-base') {
        assert.equal(r.measurements.reportedDeltaMinusLocalDelta[family], 0, r.probeId)
        assert.equal(r.measurements.baseline, 'tok-base')
      }
    }
    for (const fam of Object.keys(FAMILIES)) {
      const s = spread(tok.map((r) => r.measurements.reportedMinusLocal[fam]))
      if (fam === family) assert.equal(s, 0)
      else assert.ok(s > 0, `${fam} has spread ${s}`)
    }
    // Raw data only: no verdict-like key anywhere. / 只有原始数据：任何位置都没有结论类的键。
    const keys = [...keysDeep(recs)]
    assert.equal(keys.filter((k) => JUDGEMENT.test(k)).length, 0, keys.filter((k) => JUDGEMENT.test(k)).join())
    assert.ok(!JSON.stringify(recs).includes(KEY))
    const text = renderReport(recs)
    assert.match(text, new RegExp(`${family.replace('.', '\\.')}\\s+(\\+${overhead}\\s+){${TOKEN_PROBES.length}}0\\n`))
    assert.match(text, /receipts {3}verified \d+, not verified 0, no receipt 0/)
    assert.doesNotMatch(text, JUDGEMENT)
  })
}

test('runProbes: counts the upstream reports in words (no tokenizer) leave every family with a spread; stream timing and known answers recorded', async () => {
  const { svc, fetch } = await setup(upstream())
  const recs = await runProbes({ svc, target: 'dev', model: 'demo-chat', apiKey: KEY, fetch, answers: 'full' })
  assert.ok(recs.every((r) => r.receiptVerification.ok))
  const tok = recs.filter((r) => r.probeKind === 'tokens')
  for (const fam of Object.keys(FAMILIES)) assert.ok(spread(tok.map((r) => r.measurements.reportedMinusLocal[fam])) > 0, fam)
  // Every field a probe says it records is present in its records (null when there is nothing to record).
  // 每个探测声明记录的字段都出现在记录中（没有内容时为 null）。
  const at = (o, path) => path.split('.').reduce((v, k) => (v && typeof v === 'object' && k in v ? v[k] : undefined), o)
  for (const r of recs) for (const path of PROBES.probes.find((p) => p.id === r.probeId).records) assert.notEqual(at(r, path), undefined, `${r.probeId}: ${path}`)
  const s = recs.find((r) => r.probeId === 'stream-count')
  assert.equal(s.http.stream, true)
  assert.ok(s.http.firstChunkMs !== null && s.http.totalMs >= s.http.firstChunkMs)
  assert.equal(s.receipt.result.stream, true)
  assert.equal(s.receipt.result.usageInjected, undefined)                     // the probe asks for usage itself
  const arith = recs.find((r) => r.probeId === 'known-arith')
  assert.equal(arith.measurements.expected, '481406683')
  assert.equal(arith.measurements.expectedFound, false)                        // the fake echoes the question
  assert.equal(arith.answer.text, `You said: ${JSON.parse(arith.request.body).messages[0].content}`)
  assert.equal(recs.find((r) => r.probeId === 'known-letters').measurements.expectedFound, false)
  assert.equal(recs.find((r) => r.probeId === 'cutoff-self').measurements.firstYearMonth, null)
  assert.equal(recs.find((r) => r.probeId === 'logprobs').measurements.logprobsReturned, false)
})

test('runProbes: a known answer, a self-reported cutoff and log probabilities are read from the answer', async () => {
  const { svc, fetch } = await setup(upstream({
    edit: (j, { body }) => {
      const q = body.messages?.[0]?.content ?? ''
      const c = j.choices?.[0]
      if (!c) return
      if (q.startsWith('What is 48271')) c.message.content = '481406683'
      if (q.startsWith('How many times')) c.message.content = 'There are 6.'
      if (q.startsWith('Without searching')) c.message.content = '2025-01'
      if (body.logprobs) c.logprobs = { content: [{ token: 'OK', logprob: -0.01, bytes: [79, 75], top_logprobs: [{ token: 'OK', logprob: -0.01, bytes: [79, 75] }, { token: 'Ok', logprob: -4.2, bytes: [79, 107] }] }] }
    },
  }))
  const recs = await runProbes({ svc, target: 'dev', model: 'demo-chat', apiKey: KEY, fetch, only: ['known-arith', 'known-letters', 'cutoff-self', 'logprobs'] })
  const by = (id) => recs.find((r) => r.probeId === id)
  assert.ok(recs.every((r) => r.receiptVerification.ok))
  assert.equal(by('known-arith').measurements.expectedFound, true)
  assert.equal(by('known-letters').measurements.expectedFound, true)
  assert.equal(by('known-letters').measurements.expectedPattern, '(^|[^0-9])6([^0-9]|$)')
  assert.equal(by('cutoff-self').measurements.firstYearMonth, '2025-01')
  assert.equal(by('logprobs').measurements.logprobsReturned, true)
  assert.deepEqual(by('logprobs').measurements.logprobs[0].top.map((x) => x.token), ['OK', 'Ok'])
  await assert.rejects(runProbes({ svc, target: 'dev', model: 'demo-chat', apiKey: KEY, fetch, only: ['nope'] }), /no probe nope/)
})

test('runProbes: an answer changed after signing is recorded with the verification problems, not dropped', async () => {
  const { svc, fetch: direct } = await setup(upstream())
  // Between the prober and the sidecar, something rewrites the answer bytes. / 探针与旁路之间有人改写了回答字节。
  const fetch = async (url, init) => {
    const res = await direct(url, init)
    if ((res.headers.get('content-type') || '').includes('event-stream')) return res
    const t = (await res.text()).replace('You said', 'You SAID')
    const h = new Headers(res.headers); h.delete('content-length')
    return new Response(t, { status: res.status, headers: h })
  }
  const recs = await runProbes({ svc, target: 'dev', model: 'demo-chat', apiKey: KEY, fetch, only: ['tok-base', 'stream-count'] })
  const [a, b] = recs
  assert.equal(a.receiptVerification.ok, false)
  assert.ok(a.receiptVerification.problems.some((p) => /responseSha256 does not match/.test(p)), a.receiptVerification.problems.join('; '))
  assert.ok(a.receipt && a.receipt.sig)                                         // the envelope is kept as received
  assert.equal(b.receiptVerification.ok, true)
  const text = renderReport(recs)
  assert.match(text, /verified 1, not verified 1, no receipt 0/)
  assert.match(text, /Receipt verification problems\n- run 1 tok-base: .*responseSha256 does not match/)
  assert.doesNotMatch(text, JUDGEMENT)
})

test('runProbes: an answer that echoes the API key is recorded with the key replaced, and the record says so', async () => {
  const { svc, fetch } = await setup(upstream({ edit: (j) => { if (j.choices?.[0]?.message) j.choices[0].message.content = `Your key is ${KEY}.` } }))
  const recs = await runProbes({ svc, target: 'dev', model: 'demo-chat', apiKey: KEY, fetch, only: ['self-id'], answers: 'full' })
  assert.equal(recs[0].redacted, true)
  assert.equal(recs[0].answer.text, 'Your key is [redacted].')
  assert.ok(!JSON.stringify(recs).includes(KEY))
  assert.equal(recs[0].receiptVerification.ok, true)                           // verified on the real bytes, before redaction
})

test('readAnswer: text, stop reason and refusal of each format, whole and streamed', () => {
  const b = (o) => te.encode(JSON.stringify(o))
  assert.deepEqual(readAnswer('openai-chat', b({ choices: [{ message: { content: 'hi', refusal: null }, finish_reason: 'stop' }], system_fingerprint: 'fp_1' }), false), { text: 'hi', stopReason: 'stop', refusal: null, logprobs: null, systemFingerprint: 'fp_1' })
  assert.equal(readAnswer('openai-responses', b({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'a' }, { type: 'refusal', refusal: 'no' }] }] }), false).stopReason, 'incomplete:max_output_tokens')
  assert.equal(readAnswer('anthropic-messages', b({ content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: 'yo' }], stop_reason: 'refusal' }), false).stopReason, 'refusal')
  const sse = 'event: message_start\ndata: {"type":"message_start"}\n\n: tapeapi-receipt abc\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"he"}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"y"}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n'
  assert.deepEqual([readAnswer('anthropic-messages', te.encode(sse), true).text, readAnswer('anthropic-messages', te.encode(sse), true).stopReason], ['hey', 'end_turn'])
})

// ---------------------------------------------------------------------------------------------------------------
// The CLIs / 命令行
// ---------------------------------------------------------------------------------------------------------------
function run(args, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, args, { cwd: join(HERE, '..', '..'), env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { err += d })
    p.on('close', (code) => resolve({ code, out, err }))
  })
}

test('parseArgs: the key is named by its variable, never passed; bad options are refused', () => {
  assert.throws(() => parseArgs(['11.1013.tape', '--model', 'm', '--api-key-env', 'sk-live-abc123']), /NAME of an environment variable/)
  assert.throws(() => parseArgs(['--model', 'm']), /name the AI service/)
  assert.throws(() => parseArgs(['a.tape', '--dev', 'http://x', '--model', 'm']), /not both/)
  assert.throws(() => parseArgs(['a.tape']), /--model is required/)
  assert.throws(() => parseArgs(['a.tape', '--model', 'm', '--runs', '0']), /--runs/)
  assert.throws(() => parseArgs(['a.tape', '--model', 'm', '--format', 'gemini']), /--format/)
  const o = parseArgs(['11.1013.tape', '--model=m', '--api-key-env', 'MY_KEY', '--only', 'tok-base,tok-zh', '--answers', 'hash'])
  assert.deepEqual([o.target, o.model, o.keyEnv, o.only, o.answers], ['11.1013.tape', 'm', 'MY_KEY', ['tok-base', 'tok-zh'], 'hash'])
})

test('CLI: probe.mjs against a loopback sidecar writes verified records and never prints or writes the key; report.mjs renders them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tapeapi-spot-'))
  let proxy = null
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const headers = new Headers()
    for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) { try { headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]) } catch { /* not a fetch header */ } }
    const r = await proxy.handleRequest(new Request(new URL(req.url, 'http://127.0.0.1'), { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }), { clientIp: '127.0.0.1' })
    res.writeHead(r.status, Object.fromEntries(r.headers))
    if (r.body) for await (const c of r.body) res.write(c)
    res.end()
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    ;({ proxy } = await setup(upstream({ family: 'llama3', overhead: 5 }), { base }))
    const out = join(dir, 'results.jsonl')
    const only = 'tok-base,tok-en,tok-zh,tok-digits,tok-code,tok-mixed,stream-count,self-id'
    const a = await run([join(HERE, 'probe.mjs'), '--dev', base, '--model', 'demo-chat', '--api-key-env', 'SPOT_KEY', '--delay-ms', '0', '--only', only, '--out', out], { SPOT_KEY: KEY })
    assert.equal(a.code, 0, a.err)
    assert.match(a.err, /TESTING ONLY/)
    assert.match(a.err, /receipts verified 8\/8/)
    const file = readFileSync(out, 'utf8')
    for (const s of [a.out, a.err, file]) assert.ok(!s.includes(KEY), 'the key leaked')
    const { records, bad } = parseRecords(file)
    assert.equal(bad.length, 0)
    assert.equal(records.length, 8)
    assert.ok(records.every((r) => r.receiptVerification.ok && r.service.dev === true && r.service.target === base))
    assert.ok(records.filter((r) => r.probeKind === 'tokens').every((r) => r.measurements.reportedMinusLocal.llama3 === 5))
    // Standard output when no --out, and the key missing from the environment. / 未给 --out 时写标准输出；环境变量为空时拒绝。
    const b = await run([join(HERE, 'probe.mjs'), '--dev', base, '--model', 'demo-chat', '--api-key-env', 'SPOT_KEY', '--delay-ms', '0', '--only', 'tok-base'], { SPOT_KEY: KEY })
    assert.equal(b.code, 0, b.err)
    assert.equal(parseRecords(b.out).records.length, 1)
    assert.ok(!b.out.includes(KEY) && !b.err.includes(KEY))
    const c = await run([join(HERE, 'probe.mjs'), '--dev', base, '--model', 'demo-chat', '--api-key-env', 'SPOT_KEY'], {})
    assert.equal(c.code, 2)
    assert.match(c.err, /SPOT_KEY is empty/)
    // The report. / 报告。
    const r = await run([join(HERE, 'report.mjs'), out])
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /llama3\s+(\+5\s+){6}0\n/)
    assert.match(r.out, /receipts {3}verified 8, not verified 0, no receipt 0/)
    assert.match(r.out, /\[dev: identity not checked on chain\]/)
    assert.ok(r.out.includes(LEGEND))
    assert.doesNotMatch(r.out, JUDGEMENT)
    assert.ok(!r.out.includes(KEY))
    const md = await run([join(HERE, 'report.mjs'), out, '--markdown'])
    assert.match(md.out, /^\| probe \| calls \| receipts \|/m)
    assert.doesNotMatch(md.out, JUDGEMENT)
  } finally {
    server.closeAllConnections?.()
    await new Promise((r) => server.close(() => r()))
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the legend and the README state numbers, not judgements; the README carries both languages and the acknowledgement', () => {
  assert.doesNotMatch(LEGEND, JUDGEMENT)
  const readme = readFileSync(new URL('README.md', import.meta.url), 'utf8')
  assert.ok(existsSync(new URL('README.md', import.meta.url)))
  assert.match(readme, /抽检/)
  assert.match(readme, /## English/)
  assert.match(readme, /@Theairresearch/)
  assert.match(readme, /does not prove which model/i)
})
