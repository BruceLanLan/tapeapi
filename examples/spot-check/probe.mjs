#!/usr/bin/env node
// TapeAPI spot-check probe (plan item A9): send a fixed, versioned set of probe requests (probes.json) to an AI service
// that signs TapeAPI usage receipts, verify every receipt against the exact bytes sent and received, and write one JSON
// line per call: what was asked, what was answered, the signed receipt, the verification result and raw measurements
// (reported token counts next to locally computed counts per tokenizer family, timings, known-answer checks).
// It records RAW DATA ONLY. There is no verdict field and no score: a signed receipt makes each number attributable to
// the service that signed it; what the numbers mean is for readers (and the provider, who can answer) to discuss.
// TapeAPI 抽检探针（计划 A9）：向签发 TapeAPI 用量回执的 AI 服务发送固定、带版本的探测请求（probes.json），按确切的收发字节
// 核验每一张回执，每次调用写一行 JSON：问了什么、答了什么、签名回执、核验结果与原始测量值（上报的 token 数与各分词器族的本地
// 计数并列、时间、已知答案）。**只记录原始数据**：没有结论字段，也没有评分。签名回执让每个数字都能归属到签名的服务；数字意味着
// 什么，由读者（以及可以回应的服务方）讨论。
//
//   node examples/spot-check/probe.mjs <service name> --model <id> [--format openai-chat|openai-responses|anthropic-messages]
//        [--api-key-env NAME] [--runs N] [--out results.jsonl] [--only id,id] [--answers truncate:300|full|hash]
//   node examples/spot-check/probe.mjs --dev http://127.0.0.1:8798 --model demo-chat --api-key-env DEMO_KEY
//
// The API key is read from the environment variable you name; it is sent only to the service's own endpoint, and it is
// never printed or written (any echo of it in an answer is replaced by [redacted]).
// API 密钥从你指定的环境变量读取，只发送到服务自己的端点，从不打印或写入（回答中若回显密钥，替换为 [redacted]）。
import { readFileSync, appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createTapeAPI, rpcUrlsFor, operatorOf, ai } from '@tapeapi/sdk'
import { FAMILIES, loadTokenizer, defaultCacheDir } from './tokenizers.mjs'

export const TOOL = Object.freeze({ name: 'tapeapi-spot-check', version: '0.1.0' })
export const RECORD_SCHEMA = 'tapeapi-spot-check-record/1'
export const PROBES_PATH = fileURLToPath(new URL('probes.json', import.meta.url))
export const loadProbes = (path = PROBES_PATH) => JSON.parse(readFileSync(path, 'utf8'))

// Per format: where the request goes (relative to the endpoint's baseUrl), the API path from the service root (what the
// receipt's params.path names), and how the key is sent. / 每种格式：请求去往哪里、回执里的 API 路径、密钥如何发送。
export const FORMAT_WIRING = Object.freeze({
  'openai-chat': { rel: '/chat/completions', path: '/v1/chat/completions', auth: (k) => ({ authorization: `Bearer ${k}` }) },
  'openai-responses': { rel: '/responses', path: '/v1/responses', auth: (k) => ({ authorization: `Bearer ${k}` }) },
  'anthropic-messages': { rel: '/v1/messages', path: '/v1/messages', auth: (k) => ({ 'x-api-key': k, 'anthropic-version': '2023-06-01' }) },
})
const DEFAULT_KEY_ENV = { 'openai-chat': 'OPENAI_API_KEY', 'openai-responses': 'OPENAI_API_KEY', 'anthropic-messages': 'ANTHROPIC_API_KEY' }
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const jsonOf = (bytes) => { try { return JSON.parse(new TextDecoder().decode(bytes)) } catch { return undefined } }
const round = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null)

/** The body of one probe for one format, as the exact string that is sent. / 某个探测在某种格式下的请求体（发送的确切字符串）。 */
export function bodyOf(probe, format, model, { chatMaxField = 'max_tokens' } = {}) {
  const tpl = probe.bodies?.[format]
  if (!tpl) return null
  const fill = (v) => (typeof v === 'string' ? v.split('{{model}}').join(model) : Array.isArray(v) ? v.map(fill) : isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)])) : v)
  const body = fill(tpl)
  if (format === 'openai-chat' && chatMaxField !== 'max_tokens' && 'max_tokens' in body) {
    const n = body.max_tokens
    delete body.max_tokens
    if (chatMaxField === 'max_completion_tokens') body.max_completion_tokens = n
  }
  return JSON.stringify(body)
}

// ---------------------------------------------------------------------------------------------------------------
// Reading an answer: text, stop reason, log probabilities (format-specific, informative only)
// 读取回答：文本、停止原因、对数概率（与格式有关，仅供记录）
// ---------------------------------------------------------------------------------------------------------------
function sseEvents(bytes) {
  const out = []
  let data = null, event = ''
  for (const line of new TextDecoder().decode(bytes).split(/\r\n|\r|\n/)) {
    if (line === '') { if (data !== null) out.push({ event, data: data.join('\n') }); data = null; event = ''; continue }
    if (line.startsWith(':')) continue
    const k = line.indexOf(':'), f = k < 0 ? line : line.slice(0, k), v = k < 0 ? '' : line.slice(k + 1).replace(/^ /, '')
    if (f === 'data') (data ??= []).push(v)
    else if (f === 'event') event = v
  }
  return out.map((e) => ({ event: e.event, json: e.data === '[DONE]' ? null : jsonOf(new TextEncoder().encode(e.data)) })).filter((e) => e.json !== undefined)
}
const pickLogprobs = (items) => (Array.isArray(items) ? items.slice(0, 3).map((t) => ({ token: t.token, logprob: t.logprob, ...(Array.isArray(t.bytes) ? { bytes: t.bytes } : {}), top: Array.isArray(t.top_logprobs) ? t.top_logprobs.map((x) => ({ token: x.token, logprob: x.logprob, ...(Array.isArray(x.bytes) ? { bytes: x.bytes } : {}) })) : [] })) : null)

/** { text, stopReason, refusal, logprobs, systemFingerprint } from an answer's bytes. / 从回答字节读出文本等。 */
export function readAnswer(format, bytes, stream) {
  const out = { text: '', stopReason: null, refusal: null, logprobs: null, systemFingerprint: null }
  if (!stream) {
    const j = jsonOf(bytes)
    if (!isObj(j)) return out
    if (format === 'openai-chat') {
      const c = Array.isArray(j.choices) ? j.choices[0] : null
      out.text = typeof c?.message?.content === 'string' ? c.message.content : ''
      out.stopReason = c?.finish_reason ?? null
      out.refusal = c?.message?.refusal ?? null
      out.logprobs = pickLogprobs(c?.logprobs?.content)
      out.systemFingerprint = j.system_fingerprint ?? null
    } else if (format === 'openai-responses') {
      const parts = (Array.isArray(j.output) ? j.output : []).filter((o) => o?.type === 'message').flatMap((o) => (Array.isArray(o.content) ? o.content : []))
      out.text = parts.filter((p) => p?.type === 'output_text').map((p) => p.text).join('')
      out.refusal = parts.find((p) => p?.type === 'refusal')?.refusal ?? null
      out.stopReason = j.status === 'incomplete' ? `incomplete:${j.incomplete_details?.reason ?? ''}` : j.status ?? null
      out.logprobs = pickLogprobs(parts.find((p) => Array.isArray(p?.logprobs) && p.logprobs.length)?.logprobs)
    } else if (format === 'anthropic-messages') {
      out.text = (Array.isArray(j.content) ? j.content : []).filter((b) => b?.type === 'text').map((b) => b.text).join('')
      out.stopReason = j.stop_reason ?? null
    }
    return out
  }
  const lp = []
  for (const { event, json: j } of sseEvents(bytes)) {
    if (!isObj(j)) continue
    const type = typeof j.type === 'string' ? j.type : event
    if (format === 'openai-chat') {
      const c = Array.isArray(j.choices) ? j.choices[0] : null
      if (typeof c?.delta?.content === 'string') out.text += c.delta.content
      if (typeof c?.delta?.refusal === 'string') out.refusal = (out.refusal ?? '') + c.delta.refusal
      if (c?.finish_reason) out.stopReason = c.finish_reason
      if (Array.isArray(c?.logprobs?.content)) lp.push(...c.logprobs.content)
      if (j.system_fingerprint) out.systemFingerprint = j.system_fingerprint
    } else if (format === 'openai-responses') {
      if (type === 'response.output_text.delta' && typeof j.delta === 'string') { out.text += j.delta; if (Array.isArray(j.logprobs)) lp.push(...j.logprobs) }
      if ((type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed') && isObj(j.response)) out.stopReason = j.response.status === 'incomplete' ? `incomplete:${j.response.incomplete_details?.reason ?? ''}` : j.response.status ?? type
    } else if (format === 'anthropic-messages') {
      if (type === 'content_block_delta' && j.delta?.type === 'text_delta') out.text += j.delta.text
      if (type === 'message_delta' && j.delta?.stop_reason) out.stopReason = j.delta.stop_reason
      if (type === 'error') out.stopReason = `error:${j.error?.type ?? ''}`
    }
  }
  if (lp.length) out.logprobs = pickLogprobs(lp)
  return out
}

// ---------------------------------------------------------------------------------------------------------------
// Measurements (raw numbers, no judgement) / 测量值（原始数字，不作判断）
// ---------------------------------------------------------------------------------------------------------------
/**
 * The token measurements of one record: for each family whose expected counts probes.json ships, the local count of
 * the probe's text and `reported − local`; and, when the baseline probe was measured in the same run and format, the
 * reported difference to the baseline next to each family's local difference.
 * 单条记录的 token 测量：每个族的本地计数与"上报 − 本地"；同一轮、同一格式测过基线时，再给出相对基线的上报差与各族本地差。
 */
export function tokenMeasurements(probe, probes, promptTokens, basePromptTokens) {
  const exp = probes.tokenizers?.expected ?? {}
  const local = {}, reportedMinusLocal = {}
  for (const [fam, byId] of Object.entries(exp)) {
    if (!Number.isInteger(byId[probe.id])) continue
    local[fam] = byId[probe.id]
    if (Number.isInteger(promptTokens)) reportedMinusLocal[fam] = promptTokens - byId[probe.id]
  }
  const m = { localTokens: local, reportedMinusLocal }
  if (probe.baseline && Number.isInteger(promptTokens) && Number.isInteger(basePromptTokens)) {
    const localDelta = {}, reportedDeltaMinusLocalDelta = {}
    const reportedDelta = promptTokens - basePromptTokens
    for (const [fam, byId] of Object.entries(exp)) {
      if (!Number.isInteger(byId[probe.id]) || !Number.isInteger(byId[probe.baseline])) continue
      localDelta[fam] = byId[probe.id] - byId[probe.baseline]
      reportedDeltaMinusLocalDelta[fam] = reportedDelta - localDelta[fam]
    }
    Object.assign(m, { baseline: probe.baseline, reportedDelta, localDelta, reportedDeltaMinusLocalDelta })
  }
  return m
}

/** For each returned log-probability token, which cached vocabularies contain it (null when no file is cached). */
function vocabularyMembership(logprobs, cacheDir) {
  if (!Array.isArray(logprobs) || !logprobs.length) return null
  const out = {}
  for (const fam of Object.keys(FAMILIES)) {
    let t = null
    try { t = loadTokenizer(fam, { cacheDir }) } catch { t = null }
    if (!t) continue
    out[fam] = logprobs.map((x) => (Array.isArray(x.bytes) ? t.hasToken(Uint8Array.from(x.bytes)) : typeof x.token === 'string' ? t.hasToken(x.token) : null))
  }
  return Object.keys(out).length ? out : null
}

function answerField(text, mode) {
  const sha = ai.sha256Hex(text)
  const base = { sha256: sha, chars: [...text].length }
  if (mode === 'hash') return base
  if (mode === 'full') return { ...base, text }
  const n = Number(String(mode).split(':')[1] ?? 300)
  const cps = [...text]
  return { ...base, text: cps.slice(0, n).join(''), truncated: cps.length > n }
}

// Replace every occurrence of the key in a JSON-able value. / 把值中出现的密钥全部替换。
function redact(value, key) {
  if (!key) return { value, redacted: false }
  let redacted = false
  const walk = (v) => {
    if (typeof v === 'string') { if (v.includes(key)) { redacted = true; return v.split(key).join('[redacted]') } return v }
    if (Array.isArray(v)) return v.map(walk)
    if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    return v
  }
  return { value: walk(value), redacted }
}

// ---------------------------------------------------------------------------------------------------------------
// One call / 一次调用
// ---------------------------------------------------------------------------------------------------------------
async function callOnce({ svc, endpoint, format, probe, body, apiKey, fetchImpl, timeoutMs, maxSkewS }) {
  const w = FORMAT_WIRING[format]
  const adapter = ai.FORMATS.find((f) => f.name === format)
  const url = endpoint.baseUrl.replace(/\/+$/, '') + w.rel
  const requestBytes = new TextEncoder().encode(body)
  const headers = { 'content-type': 'application/json', ...w.auth(apiKey) }
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  const t0 = performance.now()
  let res, bytes, firstChunkMs = null, headersMs = null, error = null
  try {
    res = await fetchImpl(url, { method: 'POST', headers, body: requestBytes, signal: ac.signal })
    headersMs = performance.now() - t0
    const chunks = []
    if (res.body) {
      const reader = res.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (firstChunkMs === null) firstChunkMs = performance.now() - t0
        chunks.push(value)
      }
    }
    bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
    let o = 0
    for (const c of chunks) { bytes.set(c, o); o += c.length }
  } catch (e) {
    error = ac.signal.aborted ? `timeout after ${timeoutMs} ms` : String(e?.message ?? e).slice(0, 300)
  } finally { clearTimeout(timer) }
  const totalMs = performance.now() - t0
  const out = { url, path: w.path, requestBytes, error, timing: { headersMs: round(headersMs), firstChunkMs: round(firstChunkMs), totalMs: round(totalMs) } }
  if (error) return out
  const type = (res.headers.get('content-type') || '').toLowerCase()
  const stream = !!adapter.stream && type.includes('text/event-stream') && ![101, 204, 205, 304].includes(res.status)
  // The receipt: the header of a whole answer, the last `: tapeapi-receipt` comment of a stream (an earlier one only if the
  // last does not verify, as the SDK does). / 回执：整体回答取响应头，流取最后一个回执注释（最后一个核验不过才看更早的）。
  let candidates = []
  if (stream) candidates = ai.scanSse(bytes).receipts.slice().reverse()
  else if (res.headers.get(ai.RECEIPT_HEADER)) candidates = [res.headers.get(ai.RECEIPT_HEADER)]
  let verification = null, envelope = null
  for (const c of candidates) {
    let env
    try { env = ai.decodeReceiptHeader(c) } catch (e) { verification ??= { ok: false, problems: [e.message], warnings: [], unchecked: [] }; continue }
    const r = ai.verifyUsageReceipt({ envelope: env, manifest: svc.manifest, requestBytes, responseBytes: bytes, stream, path: w.path, status: res.status, maxSkewS })
    if (!verification || r.ok || !envelope) { verification = { ok: r.ok, problems: r.problems, warnings: r.warnings, unchecked: r.unchecked }; envelope = env }
    if (r.ok) break
  }
  if (!verification) verification = { ok: false, problems: [res.headers.get(ai.SIDECAR_ERROR_HEADER) === '1' ? `the sidecar answered HTTP ${res.status} itself: no upstream answer, no receipt` : 'no receipt'], warnings: [], unchecked: ['request', 'response'] }
  // The client's own reading of what the service reported. / 客户端自己读到的服务上报内容。
  const read = stream ? ai.scanSse(bytes, { format: adapter }) : (adapter.response(jsonOf(bytes)) ?? {})
  return { ...out, status: res.status, stream, bytes, envelope, verification, reportedModel: read.model ?? null, reportedId: read.id ?? null, usage: ai.usageOf(read.usage), sidecarError: res.headers.get(ai.SIDECAR_ERROR_HEADER) === '1' || undefined }
}

// ---------------------------------------------------------------------------------------------------------------
// The run / 一次抽检
// ---------------------------------------------------------------------------------------------------------------
/**
 * Run the probe set against a resolved service and return the records (and hand each to `onRecord` as it is made).
 * 对已解析的服务运行探测集，返回记录（每生成一条就交给 onRecord）。
 * @param {object} o
 * @param {object} o.svc        from api.resolve() / 来自 api.resolve()
 * @param {string} o.target     what the user named (a TapeOut name, an address, or the dev URL) / 用户给出的目标
 * @param {string} o.model
 * @param {string} [o.format]   default: openai-chat when the service has it, else its first endpoint's format
 * @param {string} o.apiKey
 * @param {number} [o.runs=1]
 * @param {string[]} [o.only]   probe ids / 只跑这些探测
 * @param {string} [o.answers='truncate:300']  'full' | 'hash' | 'truncate:N'
 * @param {string} [o.chatMaxField='max_tokens']  'max_tokens' | 'max_completion_tokens' | 'omit' (openai-chat only)
 * @param {object} [o.probes]   the probe set (default probes.json) / 探测集
 * @param {Function} [o.fetch]
 * @param {number} [o.delayMs=0]  pause between requests / 请求间隔
 * @param {number} [o.timeoutMs=120000]
 * @param {number} [o.maxSkewS=300]
 * @param {string} [o.tokenizerCache]  where tokenizer files may be cached (for the log-probability vocabulary check)
 * @param {(rec: object) => void} [o.onRecord]
 * @param {(msg: string) => void} [o.log]
 */
export async function runProbes({ svc, target, model, format, apiKey, runs = 1, only, answers = 'truncate:300', chatMaxField = 'max_tokens', probes = loadProbes(), fetch: fetchImpl = globalThis.fetch, delayMs = 0, timeoutMs = 120_000, maxSkewS = 300, tokenizerCache = defaultCacheDir(), onRecord, log = () => {} } = {}) {
  if (typeof model !== 'string' || !model) throw new Error('a model id is required')
  if (typeof apiKey !== 'string' || !apiKey) throw new Error('an API key is required')
  if (!/^(full|hash|truncate:\d{1,6})$/.test(answers)) throw new Error('answers must be full, hash or truncate:N')
  if (!['max_tokens', 'max_completion_tokens', 'omit'].includes(chatMaxField)) throw new Error('chatMaxField must be max_tokens, max_completion_tokens or omit')
  const endpoints = svc.manifest?.[ai.MANIFEST_FIELD]?.endpoints
  if (!Array.isArray(endpoints) || !endpoints.length) throw new Error(`the service publishes no ${ai.MANIFEST_FIELD} endpoints`)
  const fmt = format ?? (endpoints.some((e) => e.format === 'openai-chat') ? 'openai-chat' : endpoints[0].format)
  if (!FORMAT_WIRING[fmt]) throw new Error(`format ${fmt} is not one the probe speaks (${Object.keys(FORMAT_WIRING).join(', ')})`)
  const endpoint = endpoints.find((e) => e.format === fmt)
  if (!endpoint) throw new Error(`the service publishes no ${fmt} endpoint (it has ${endpoints.map((e) => e.format).join(', ')})`)
  const list = probes.probes.filter((p) => !only || only.includes(p.id))
  if (only) for (const id of only) if (!probes.probes.some((p) => p.id === id)) throw new Error(`no probe ${id} in the probe set`)
  const service = {
    target: String(target), name: svc.manifest.name ?? null, container: svc.container ?? svc.manifest.container ?? null, signer: svc.manifest.signer ?? null,
    dev: svc.verified?.dev === true, delegationVerified: svc.verified?.delegation === true, holder: svc.verified?.holder ?? null,
    ...(svc.chainId !== undefined ? { chainId: svc.chainId } : {}),
  }
  const records = []
  for (let run = 1; run <= runs; run++) {
    const basePrompt = {}
    for (const probe of list) {
      const body = bodyOf(probe, fmt, model, { chatMaxField })
      if (body === null) { log(`run ${run} ${probe.id}: not defined for ${fmt}, skipped`); continue }
      const ts = new Date().toISOString()
      const r = await callOnce({ svc, endpoint, format: fmt, probe, body, apiKey, fetchImpl, timeoutMs, maxSkewS })
      const rec = {
        schema: RECORD_SCHEMA, tool: TOOL, probesVersion: probes.version, probeId: probe.id, probeKind: probe.kind, run, ts,
        service, format: fmt, endpoint: { baseUrl: endpoint.baseUrl, path: r.path }, requestedModel: model,
        request: { body, sha256: ai.sha256Hex(r.requestBytes), ...(fmt === 'openai-chat' && chatMaxField !== 'max_tokens' ? { chatMaxField } : {}) },
      }
      if (r.error) {
        Object.assign(rec, { error: r.error, http: { status: null, stream: null, ...r.timing }, receipt: null, receiptVerification: null })
      } else {
        const a = readAnswer(fmt, r.bytes, r.stream)
        const prompt = r.usage?.prompt_tokens, completion = r.usage?.completion_tokens
        if (Number.isInteger(prompt)) basePrompt[probe.id] = prompt
        const measurements = { promptTokens: prompt ?? null, completionTokens: completion ?? null }
        if (probe.kind === 'tokens') Object.assign(measurements, tokenMeasurements(probe, probes, prompt, probe.baseline ? basePrompt[probe.baseline] : undefined))
        if (probe.expect?.contains !== undefined) Object.assign(measurements, { expected: probe.expect.contains, expectedFound: a.text.includes(probe.expect.contains) })
        else if (probe.expect?.pattern !== undefined) Object.assign(measurements, { expectedPattern: probe.expect.pattern, expectedFound: new RegExp(probe.expect.pattern, 'u').test(a.text) })
        if (probe.extract === 'year-month') measurements.firstYearMonth = /\b(19|20)\d{2}-(0[1-9]|1[0-2])\b/.exec(a.text)?.[0] ?? null
        if (probe.kind === 'logprobs') Object.assign(measurements, { logprobsReturned: Array.isArray(a.logprobs) && a.logprobs.length > 0, logprobs: a.logprobs, vocabularyMembership: vocabularyMembership(a.logprobs, tokenizerCache) })
        if (r.stream && Number.isInteger(completion) && r.timing.firstChunkMs !== null && r.timing.totalMs > r.timing.firstChunkMs) measurements.outputTokensPerSecond = round(completion / ((r.timing.totalMs - r.timing.firstChunkMs) / 1000))
        Object.assign(rec, {
          http: { status: r.status, stream: r.stream, ...r.timing, ...(r.sidecarError ? { sidecarError: true } : {}) },
          receipt: r.envelope, receiptVerification: r.verification,
          reportedModel: r.reportedModel, reportedId: r.reportedId, usage: r.usage,
          answer: { ...answerField(a.text, answers), stopReason: a.stopReason, refusal: a.refusal, ...(a.systemFingerprint ? { systemFingerprint: a.systemFingerprint } : {}) },
          measurements,
        })
      }
      const { value, redacted } = redact(rec, apiKey)
      if (redacted) value.redacted = true
      records.push(value)
      if (onRecord) onRecord(value)
      log(`run ${run} ${probe.id.padEnd(14)} HTTP ${value.http.status ?? '-'}  receipt ${value.receiptVerification ? (value.receiptVerification.ok ? 'verified' : 'NOT verified') : '-'}  prompt_tokens ${value.measurements?.promptTokens ?? '-'}  ${value.http.totalMs} ms${value.error ? `  error: ${value.error}` : ''}`)
      if (delayMs) await new Promise((res) => setTimeout(res, delayMs))
    }
  }
  return records
}

// ---------------------------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------------------------
const USAGE = `${TOOL.name} ${TOOL.version}: send the fixed TapeAPI probe set to an AI service and record raw, receipt-verified data.

Usage: node examples/spot-check/probe.mjs <service> --model <id> [options]
       node examples/spot-check/probe.mjs --dev <url> --model <id> [options]

  <service>              the AI service: a TapeOut name (11.1013.tape) or a container address, resolved on chain
  --dev <url>            TESTING ONLY: read the manifest from a local sidecar; the identity is NOT checked on chain
  --model <id>           the model to ask for (required)
  --format <f>           openai-chat | openai-responses | anthropic-messages (default: openai-chat if offered)
  --api-key-env <NAME>   the environment variable holding your key (default OPENAI_API_KEY; ANTHROPIC_API_KEY when
                         the format used is anthropic-messages); the key is never printed or written
  --runs <n>             repeat the whole set n times (default 1, at most 50)
  --out <file>           append the JSON lines to this file (default: standard output)
  --only <id,id>         run only these probes (ids from probes.json)
  --answers <mode>       truncate:N (default truncate:300) | full | hash   how much answer text to keep (sha256 always)
  --chat-max-field <f>   max_tokens (default) | max_completion_tokens | omit   (openai-chat bodies; some models need
                         max_completion_tokens)
  --delay-ms <n>         pause between requests (default 500)
  --timeout-ms <n>       per request (default 120000)
  --max-skew <s>         a receipt's time must be within this many seconds of now (default 300)
  --rpc <url,url,...>    BNB Chain nodes; each chain read needs 2 independent operators to agree
  --tokenizer-cache <d>  cached tokenizer files (see tokenizers.mjs) for the log-probability vocabulary check
  --probes <file>        another probe set (default probes.json next to this file)

Every call costs what the service charges: ${'`'}--runs 1${'`'} is about a dozen short requests. Probe only services you are
allowed to use. The output is raw data, not a judgement; a signed receipt makes each number attributable to the
service, and it does not prove which model ran.
`

export function parseArgs(argv) {
  const o = { target: null, dev: null, model: null, format: null, keyEnv: null, runs: 1, out: null, only: null, answers: 'truncate:300', chatMaxField: 'max_tokens', delayMs: 500, timeoutMs: 120_000, maxSkew: 300, rpc: null, tokenizerCache: null, probes: null }
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i], v
    const eq = a.startsWith('--') ? a.indexOf('=') : -1
    if (eq > 0) { v = a.slice(eq + 1); a = a.slice(0, eq) }
    const value = () => { if (v !== undefined) return v; if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i] }
    const int = (min, max) => { const n = Number(value()); if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${a} must be an integer from ${min} to ${max}`); return n }
    switch (a) {
      case '--help': case '-h': o.help = true; break
      case '--dev': o.dev = value(); break
      case '--model': o.model = value(); break
      case '--format': o.format = value(); if (!FORMAT_WIRING[o.format]) throw new Error(`--format must be one of ${Object.keys(FORMAT_WIRING).join(', ')}`); break
      case '--api-key-env': o.keyEnv = value(); if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(o.keyEnv)) throw new Error('--api-key-env takes the NAME of an environment variable, not the key'); break
      case '--runs': o.runs = int(1, 50); break
      case '--out': o.out = value(); break
      case '--only': o.only = value().split(',').map((s) => s.trim()).filter(Boolean); break
      case '--answers': o.answers = value(); if (!/^(full|hash|truncate:\d{1,6})$/.test(o.answers)) throw new Error('--answers must be full, hash or truncate:N'); break
      case '--chat-max-field': o.chatMaxField = value(); if (!['max_tokens', 'max_completion_tokens', 'omit'].includes(o.chatMaxField)) throw new Error('--chat-max-field must be max_tokens, max_completion_tokens or omit'); break
      case '--delay-ms': o.delayMs = int(0, 600_000); break
      case '--timeout-ms': o.timeoutMs = int(1000, 3_600_000); break
      case '--max-skew': o.maxSkew = int(1, 86_400); break
      case '--rpc': o.rpc = value().split(',').map((s) => s.trim()).filter(Boolean); break
      case '--tokenizer-cache': o.tokenizerCache = value(); break
      case '--probes': o.probes = value(); break
      default:
        if (a.startsWith('-')) throw new Error(`unknown option ${a}`)
        if (o.target) throw new Error('name one service')
        o.target = a
    }
  }
  if (o.help) return o
  if (o.target && o.dev) throw new Error('name a service or --dev, not both')
  if (!o.target && !o.dev) throw new Error('name the AI service (or --dev <url> for a local test sidecar)')
  if (!o.model) throw new Error('--model is required')
  return o
}

async function main() {
  let o
  try { o = parseArgs(process.argv.slice(2)) } catch (e) { process.stderr.write(`spot-check: ${e.message}\n\n${USAGE}`); return 2 }
  if (o.help) { process.stdout.write(USAGE); return 0 }
  const log = (s) => process.stderr.write(`[spot-check] ${s}\n`)
  // With --api-key-env the key is known before anything is fetched; otherwise the default depends on the format.
  // 给了 --api-key-env 就先检查密钥；否则默认变量取决于格式。
  const noKey = (name) => { process.stderr.write(`spot-check: the environment variable ${name} is empty; put your API key there (or name another with --api-key-env)\n`); return 2 }
  if (o.keyEnv && !process.env[o.keyEnv]) return noKey(o.keyEnv)
  if (o.dev) log('--dev: TESTING ONLY. The service identity is NOT checked on chain; records carry service.dev = true.')
  const rpcUrls = o.rpc ?? (o.target ? rpcUrlsFor(56) : null)
  if (rpcUrls && new Set(rpcUrls.map(operatorOf)).size < 2) { process.stderr.write('spot-check: --rpc needs nodes of at least 2 independent operators\n'); return 2 }
  const api = createTapeAPI({ ...(rpcUrls ? { rpcUrls, quorum: 2 } : {}), ...(o.dev ? { dev: true } : {}) })
  let svc
  try {
    svc = await api.resolve(o.dev ? { dev: o.dev } : o.target)
    if (svc.aiProblems) throw new Error(`its ${ai.MANIFEST_FIELD} field is invalid: ${svc.aiProblems.join('; ')}`)
    if (!svc.verified || (svc.verified.delegation !== true && svc.verified.dev !== true)) throw new Error('the service delegation did not verify')
  } catch (e) { process.stderr.write(`spot-check: cannot use ${o.dev ?? o.target}: ${e.message}\n`); return 1 }
  const eps = svc.manifest[ai.MANIFEST_FIELD]?.endpoints ?? []
  const format = o.format ?? (eps.some((e) => e.format === 'openai-chat') ? 'openai-chat' : eps[0]?.format)
  const keyEnv = o.keyEnv ?? DEFAULT_KEY_ENV[format] ?? 'OPENAI_API_KEY'
  const apiKey = process.env[keyEnv]
  if (!apiKey) return noKey(keyEnv)
  const probes = o.probes ? loadProbes(o.probes) : loadProbes()
  log(`service ${svc.manifest.name ?? '?'}  container ${svc.container ?? svc.manifest.container}  signer ${svc.manifest.signer}${svc.verified.dev ? '  (DEV)' : `  holder ${svc.verified.holder}`}`)
  log(`probe set ${probes.version}, model ${o.model}, ${o.runs} run(s); each call is billed by the service`)
  const write = o.out ? (rec) => appendFileSync(o.out, JSON.stringify(rec) + '\n', { mode: 0o600 }) : (rec) => process.stdout.write(JSON.stringify(rec) + '\n')
  try {
    const recs = await runProbes({ svc, target: o.dev ?? o.target, model: o.model, format, apiKey, runs: o.runs, only: o.only ?? undefined, answers: o.answers, chatMaxField: o.chatMaxField, probes, delayMs: o.delayMs, timeoutMs: o.timeoutMs, maxSkewS: o.maxSkew, ...(o.tokenizerCache ? { tokenizerCache: o.tokenizerCache } : {}), onRecord: write, log })
    const verified = recs.filter((r) => r.receiptVerification?.ok).length
    log(`${recs.length} record(s)${o.out ? ` appended to ${o.out}` : ''}; receipts verified ${verified}/${recs.length}. Summarise with: node examples/spot-check/report.mjs ${o.out ?? '<file>'}`)
    return 0
  } catch (e) { process.stderr.write(`spot-check: ${String(e.message).split(apiKey).join('[redacted]')}\n`); return 1 }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().then((c) => process.exit(c))
