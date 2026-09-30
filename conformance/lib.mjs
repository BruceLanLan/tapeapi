// Shared machinery of the black-box conformance suites (provider: run.mjs, relay: relay.mjs): result recording,
// the HTTP client, TAPI-21 envelope verification, the rate-limit answer checks, and reporting.
// 黑盒一致性套件（提供者 run.mjs、中继 relay.mjs）共用的部分：结果记录、HTTP 客户端、TAPI-21 信封验证、限流回答检查与输出。
//
// Imports are deliberately narrow (sig.js / canon.js / abi.js), not sdk/src/index.js, so the suites keep loading
// while other SDK modules are being edited. / 导入刻意收窄，SDK 其他模块在修改时套件仍能加载。
import { recoverResponseSigner } from '../sdk/src/sig.js'
import { safeParseJSON } from '../sdk/src/canon.js'
import { eqAddr } from '../sdk/src/abi.js'

export const PROVIDER_CODES = ['PAYMENT_REQUIRED', 'BAD_VOUCHER', 'METHOD_NOT_FOUND', 'BAD_REQUEST', 'INTERNAL', 'TOOLS_CHANGED']
export const CODE_STATUS = { PAYMENT_REQUIRED: [402], BAD_VOUCHER: [402], METHOD_NOT_FOUND: [404], BAD_REQUEST: [400, 413], INTERNAL: [500], TOOLS_CHANGED: [409] }
export const ENVELOPE_LIMIT = 1024 * 1024       // TAPI-21 §3.2
export const MANIFEST_LIMIT = 65536             // TAPI-20 §3.2

export const now = () => Math.floor(Date.now() / 1000)
export const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
export const isDecimalString = (v) => typeof v === 'string' && /^(0|[1-9]\d*)$/.test(v)

// ---------------------------------------------------------------------------------------------------------
// createHarness: one suite run's recorder, HTTP client and envelope verifier.
// createHarness：一次套件运行的记录器、HTTP 客户端与信封验证器。
//   { origin, live, timeoutMs, maxSkewS, fetch }
// ---------------------------------------------------------------------------------------------------------
export function createHarness({ live, timeoutMs = 30_000, maxSkewS = 300, fetch: fetchImpl = globalThis.fetch } = {}) {
  const results = []
  const sizeOffenders = []
  let ratePhase = false
  let clockSkew = 0   // provider ts − our clock, from the latest envelope / 提供者时钟与本机之差
  let trusted = null  // { signer, container }

  const rec = (id, level, status, message = '', { context = '', spec = '' } = {}) => {
    results.push({ id, level, status, message, context, spec })
  }
  const pass = (id, level, spec, context, message = '') => rec(id, level, 'pass', message, { spec, context })
  const fail = (id, level, spec, context, message) => rec(id, level, 'fail', message, { spec, context })
  const skip = (id, level, spec, context, message) => rec(id, level, 'skip', message, { spec, context })
  const check = (cond, id, level, spec, context, failMsg, passMsg = '') => (cond ? pass(id, level, spec, context, passMsg) : fail(id, level, spec, context, failMsg))
  const R = { rec, pass, fail, skip, check }

  // ---- HTTP ----
  async function http(url, { method = 'GET', body, headers = {}, timeoutMs: perCall } = {}) {
    const r = { url, method, status: 0, headers: new Headers(), text: '', size: 0, json: undefined, parseError: null, transportError: null }
    try {
      const res = await fetchImpl(url, { method, body, headers, signal: AbortSignal.timeout(perCall ?? timeoutMs), redirect: 'manual' })
      r.status = res.status
      r.headers = res.headers
      const buf = new Uint8Array(await res.arrayBuffer())
      r.size = buf.length
      r.text = new TextDecoder().decode(buf)
      if (r.size > ENVELOPE_LIMIT) sizeOffenders.push(`${method} ${url} -> ${r.size} bytes`)
      if (r.text.length) {
        try { r.json = safeParseJSON(r.text) } catch (e) { r.parseError = e.message }
      }
    } catch (e) {
      r.transportError = e?.cause?.code || e?.name === 'TimeoutError' ? `${e?.cause?.code || e.name}: ${e.cause?.message || e.message}` : (e?.message || String(e))
    }
    return r
  }
  const post = (method, body, { timeoutMs: perCall } = {}) => http(`${live}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body), timeoutMs: perCall,
  })
  const describe = (r) => r.transportError ? `transport error (${r.transportError})` : `HTTP ${r.status}${r.parseError ? ` unparseable body: ${r.parseError}` : ''} ${r.text.slice(0, 200)}`
  // A 429 outside the rate-limit phase makes the check inconclusive rather than failed.
  // 限流阶段之外遇到 429：该项不可判定，而不是失败。
  const limited = (r, id, level, spec, context) => {
    if (!ratePhase && r.status === 429) { skip(id, level, spec, context, 'provider answered 429 (rate limited); rerun later or raise its budget'); return true }
    return false
  }

  // ---- envelope verification (TAPI-21 §3.2 / §3.3) ----
  function recover(env, reqId, method, params, overrides = {}) {
    const e = { ...env, ...overrides }
    try {
      return recoverResponseSigner({
        container: trusted.container, id: reqId, method, params: params ?? {}, ok: e.ok,
        body: e.ok ? e.result : e.error, ts: e.ts,
      }, e.sig)
    } catch (err) { return `(verification threw: ${err.message})` }
  }
  const verifies = (env, reqId, method, params, overrides) => {
    const got = recover(env, reqId, method, params, overrides)
    return { ok: typeof got === 'string' && eqAddr(got, trusted.signer), got }
  }

  // Runs the envelope battery on one response. Returns the parsed envelope if it verified, else null.
  // `R` lets a caller route the records elsewhere (the relay suite aggregates its bulk calls).
  // 对一个响应跑整套信封检查；验签通过则返回信封，否则 null。`R` 可把记录导向别处（中继套件用它汇总批量调用）。
  function checkEnvelope(r, { reqId, method, params, context, R: out = R }) {
    const { pass, fail, check } = out
    const S = 'TAPI-21 §3.2'
    if (r.transportError || !isPlainObject(r.json) || typeof r.json.sig !== 'string') {
      fail('tapi21.envelope.parse', 'MUST', 'TAPI-21 §3.2/§3.4', context, `no signed JSON envelope: ${describe(r)}`)
      return null
    }
    pass('tapi21.envelope.parse', 'MUST', 'TAPI-21 §3.2/§3.4', context)
    const env = r.json
    if (Number.isInteger(env.ts)) clockSkew = env.ts - now()
    check(env.id === reqId, 'tapi21.envelope.id-echo', 'MUST', S, context, `id ${JSON.stringify(env.id)} != request id ${JSON.stringify(reqId)}`)
    check(typeof env.ok === 'boolean', 'tapi21.envelope.ok-boolean', 'MUST', S, context, `ok is ${JSON.stringify(env.ok)}`)
    check(typeof env.container === 'string' && eqAddr(env.container, trusted.container), 'tapi21.envelope.container', 'MUST', S, context, `container ${env.container} != manifest.container ${trusted.container}`)
    const skew = Number.isInteger(env.ts) ? Math.abs(now() - env.ts) : null
    check(skew !== null && skew <= maxSkewS, 'tapi21.envelope.ts-window', 'MUST', S, context, skew === null ? `ts ${JSON.stringify(env.ts)} is not an integer` : `|now - ts| = ${skew}s > ${maxSkewS}s`)
    let shapeOk = true, shapeMsg = ''
    if (env.ok === true) { if (!Object.prototype.hasOwnProperty.call(env, 'result')) { shapeOk = false; shapeMsg = 'ok:true without result' } }
    else if (env.ok === false) {
      const er = env.error
      if (!isPlainObject(er) || typeof er.code !== 'string') { shapeOk = false; shapeMsg = 'ok:false without error {code}' }
      else if (er.data !== undefined && !isPlainObject(er.data)) { shapeOk = false; shapeMsg = 'error.data present but not an object' }
    }
    check(shapeOk, 'tapi21.envelope.body-shape', 'MUST', S, context, shapeMsg)
    if (env.ok === false && isPlainObject(env.error)) {
      const code = env.error.code
      check(PROVIDER_CODES.includes(code), 'tapi21.envelope.error-code', 'MUST', S, context, `error.code ${JSON.stringify(code)} is not one of ${PROVIDER_CODES.join(', ')}`)
      if (code === 'INTERNAL') {
        const leak = /https?:\/\/|wss?:\/\/|\b0x[0-9a-fA-F]{64}\b|\blocalhost\b|\b\d{1,3}(\.\d{1,3}){3}\b/.exec(String(env.error.message ?? '') + JSON.stringify(env.error.data ?? {}))
        check(!leak, 'tapi21.internal.no-leak', 'MUST', S, context, `INTERNAL error reveals upstream detail: ${leak?.[0]}`)
      }
      const allowed = [200, ...(CODE_STATUS[code] || [])]
      check(allowed.includes(r.status), 'tapi21.envelope.http-status', 'SHOULD', S, context, `HTTP ${r.status} carrying ${code}; allowed ${allowed.join('/')}`)
    } else if (env.ok === true) {
      check(r.status === 200, 'tapi21.envelope.http-status', 'SHOULD', S, context, `ok:true envelope carried with HTTP ${r.status}`)
    }
    check(/^application\/json\b/i.test(r.headers.get('content-type') || ''), 'tapi21.envelope.content-type', 'SHOULD', 'TAPI-21 §3.2', context, `content-type ${r.headers.get('content-type')}`)
    const v = verifies(env, reqId, method, params)
    if (!v.ok) { fail('tapi21.envelope.sig-recovers', 'MUST', 'TAPI-21 §3.3', context, `signature over the v2 digest of OUR request recovers to ${v.got}, expected manifest.signer ${trusted.signer}`); return null }
    pass('tapi21.envelope.sig-recovers', 'MUST', 'TAPI-21 §3.3', context)
    return env
  }

  // TAPI-21 §3.4: every 429 is unsigned, carries Retry-After, and says RATE_LIMITED with data.retryAfterS.
  // TAPI-21 §3.4：每个 429 都不签名、带 Retry-After，并给出 RATE_LIMITED 与 data.retryAfterS。
  function checkRateLimited(limitedRs, ctx) {
    const signed = limitedRs.filter(r => isPlainObject(r.json) && r.json.sig !== undefined)
    check(!signed.length, 'tapi21.ratelimit.unsigned', 'MUST', 'TAPI-21 §3.4', ctx, `${signed.length}/${limitedRs.length} 429 responses carry a sig`)
    const badRA = limitedRs.filter(r => !/^\d+$/.test(r.headers.get('retry-after') || '') && Number.isNaN(Date.parse(r.headers.get('retry-after') || '')))
    check(!badRA.length, 'tapi21.ratelimit.retry-after', 'MUST', 'TAPI-21 §3.4 / RFC 9110 §10.2.3', ctx, `${badRA.length}/${limitedRs.length} 429 responses lack a valid Retry-After header`)
    const badCode = limitedRs.filter(r => !(isPlainObject(r.json) && r.json.ok === false && r.json.error?.code === 'RATE_LIMITED'))
    check(!badCode.length, 'tapi21.ratelimit.code', 'MUST', 'TAPI-21 §3.4', ctx, `${badCode.length}/${limitedRs.length} 429 bodies are not { ok:false, error:{ code:"RATE_LIMITED" } }: ${badCode[0] ? describe(badCode[0]) : ''}`)
    const badData = limitedRs.filter(r => !(Number.isInteger(r.json?.error?.data?.retryAfterS) && r.json.error.data.retryAfterS >= 0))
    check(!badData.length, 'tapi21.ratelimit.retryAfterS', 'MUST', 'TAPI-21 §3.4', ctx, `${badData.length}/${limitedRs.length} 429 bodies lack error.data.retryAfterS`)
    const noCors = limitedRs.filter(r => !r.headers.get('access-control-allow-origin'))
    check(!noCors.length, 'tapi21.ratelimit.cors', 'SHOULD', 'reference convention', ctx, `${noCors.length}/${limitedRs.length} 429 responses lack Access-Control-Allow-Origin (a browser client cannot read Retry-After)`)
  }

  // Every response over the TAPI-21 cap seen during the run. / 本次运行中所有超过 TAPI-21 上限的响应。
  const checkSizeCap = () => check(!sizeOffenders.length, 'tapi21.response.size-cap', 'MUST', 'TAPI-21 §3.2', 'all', `responses over 1 MiB: ${sizeOffenders.join('; ')}`)

  return {
    results, R, rec, pass, fail, skip, check,
    http, post, describe, limited, recover, verifies, checkEnvelope, checkRateLimited, checkSizeCap,
    setTrusted: (t) => { trusted = t },
    get trusted() { return trusted },
    setRatePhase: (on) => { ratePhase = !!on },
    get clockSkew() { return clockSkew },
  }
}

// Deterministic change to any JSON value. / 对任意 JSON 值做确定性修改。
export function mutate(v) {
  if (v === null) return 0
  if (typeof v === 'string') return v + 'x'
  if (typeof v === 'number') return v + 1
  if (typeof v === 'boolean') return !v
  if (Array.isArray(v)) return v.length ? [mutate(v[0]), ...v.slice(1)] : [0]
  const keys = Object.keys(v)
  if (!keys.length) return { conformanceTamper: 1 }
  return { ...v, [keys[0]]: mutate(v[keys[0]]) }
}

export function summarize(results, strict = false) {
  const count = (level, status) => results.filter(r => r.level === level && r.status === status).length
  const s = {
    must: { pass: count('MUST', 'pass'), fail: count('MUST', 'fail'), skip: count('MUST', 'skip') },
    should: { pass: count('SHOULD', 'pass'), fail: count('SHOULD', 'fail'), skip: count('SHOULD', 'skip') },
  }
  s.conformant = s.must.fail === 0 && (!strict || s.should.fail === 0)
  return s
}

export function failed(results, id) { return results.filter(r => r.id === id && r.status === 'fail') }

// ---- reporting / 输出 ----
export function formatText(results, summary, { verbose = true } = {}) {
  const lines = []
  const tag = (r) => r.status === 'pass' ? 'PASS' : r.status === 'fail' ? 'FAIL' : 'SKIP'
  for (const r of results) {
    if (!verbose && r.status === 'pass') continue
    lines.push(`${tag(r)}  ${r.level.padEnd(6)} ${r.id}${r.context ? ` [${r.context}]` : ''}${r.message && r.status !== 'pass' ? `\n        ${r.message}` : ''}`)
  }
  lines.push('')
  lines.push(`MUST:   ${summary.must.pass} pass, ${summary.must.fail} fail, ${summary.must.skip} skip`)
  lines.push(`SHOULD: ${summary.should.pass} pass, ${summary.should.fail} fail, ${summary.should.skip} skip`)
  lines.push(summary.conformant ? 'RESULT: CONFORMANT (all MUST checks passed)' : 'RESULT: NOT CONFORMANT')
  return lines.join('\n')
}

const xml = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
// JUnit: MUST failures (and SHOULD failures under --strict) are <failure>; other SHOULD failures and
// not-applicable checks are <skipped>, so a CI job's colour matches the exit code.
// JUnit：MUST 失败（--strict 下含 SHOULD）记为 <failure>；其它 SHOULD 失败与不适用项记为 <skipped>，使 CI 颜色与退出码一致。
export function formatJUnit(results, summary, { strict = false, name = 'tapeapi-conformance' } = {}) {
  const hardFail = (r) => r.status === 'fail' && (r.level === 'MUST' || strict)
  const cases = results.map((r) => {
    const cn = `${r.level} ${r.id}${r.context ? ` [${r.context}]` : ''}`
    const attrs = `classname="${xml(`tapeapi.${r.id.split('.')[0]}`)}" name="${xml(cn)}"`
    if (hardFail(r)) return `    <testcase ${attrs}><failure type="${r.level}" message="${xml(r.message)}">${xml(`${r.spec}: ${r.message}`)}</failure></testcase>`
    if (r.status === 'fail') return `    <testcase ${attrs}><skipped message="${xml(`SHOULD not met: ${r.message}`)}"/></testcase>`
    if (r.status === 'skip') return `    <testcase ${attrs}><skipped message="${xml(`not applicable: ${r.message}`)}"/></testcase>`
    return `    <testcase ${attrs}/>`
  })
  const failures = results.filter(hardFail).length
  const skipped = results.filter(r => r.status !== 'pass' && !hardFail(r)).length
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="${xml(name)}" tests="${results.length}" failures="${failures}">\n  <testsuite name="${xml(name)}" tests="${results.length}" failures="${failures}" skipped="${skipped}" timestamp="${new Date().toISOString()}">\n${cases.join('\n')}\n  </testsuite>\n</testsuites>\n`
}

// ---- CLI ----
export function parseArgs(argv) {
  const o = {}
  const flags = new Set(['strict', 'quiet', 'help'])
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`)
    const [k, inline] = a.slice(2).split(/=(.*)/s)
    const key = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    if (flags.has(k)) { o[key] = true; continue }
    const v = inline !== undefined ? inline : argv[++i]
    if (v === undefined) throw new Error(`--${k} needs a value`)
    o[key] = v
  }
  return o
}
