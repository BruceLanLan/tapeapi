#!/usr/bin/env node
// TapeAPI provider conformance suite (black-box). / TapeAPI 提供者一致性测试套件（黑盒）。
//
// Tests ANY provider by URL, knowing nothing about its implementation. Only the crypto primitives
// (canonical JSON, digests, secp256k1) are imported from the reference SDK; nothing from the reference
// provider runtime is used. Every check has a stable id, a level (MUST / SHOULD) and a spec citation.
// 只按 URL 测试任意提供者，不了解其实现。仅从参考 SDK 导入密码学原语，不使用参考提供者运行时的任何东西。
//
//   node conformance/run.mjs --url http://127.0.0.1:8787 [--manifest trusted.json] [--params params.json]
//        [--paid-method name --consumer-key 0x.. [--session-key 0x..] [--chain-id 56]]
//        [--check-rate-limit N] [--body-limit BYTES] [--max-skew 300] [--timeout-ms 30000]
//        [--junit out.xml] [--json out.json] [--strict] [--quiet]
//
// Imports are deliberately narrow (sig.js / canon.js / manifest.js / abi.js), not sdk/src/index.js, so the
// suite keeps loading while other SDK modules are being edited.
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { recoverAddress, voucherDigest, signDigest, privateKeyToAddress } from '../sdk/src/sig.js'
import { canonicalJSON, safeParseJSON } from '../sdk/src/canon.js'
import { validateManifest, parseUnits, METHOD_NAME_RE } from '../sdk/src/manifest.js'
import { eqAddr, isAddress } from '../sdk/src/abi.js'
import { createHarness, mutate, summarize, formatText, formatJUnit, parseArgs, now, isPlainObject, isDecimalString, ENVELOPE_LIMIT, MANIFEST_LIMIT } from './lib.mjs'

// Shared with the relay suite; re-exported so existing importers keep working. / 与中继套件共用；再导出以兼容现有导入方。
export { PROVIDER_CODES, summarize, failed, formatText, formatJUnit, parseArgs } from './lib.mjs'
const UNKNOWN_METHOD = 'noSuchMethod_conformance'

// Params that break any canonicaliser that is not JCS: integer-like keys (JS object order), non-ASCII keys,
// escapes, fractions, nesting. A provider hashing the request with JSON.stringify fails here and nowhere else.
// 能击穿任何非 JCS 规范化器的参数：整数样式的键（JS 对象序）、非 ASCII 键、转义、小数、嵌套。
export const CANON_PARAMS = { 10: 1, 2: 2, 1: 3, b: [3, 1, { z: true, a: null }], 'é': 'ü "\\', A: 0.1, a: -1.5, e: 1e-7, big: 9007199254740991 }

// ---------------------------------------------------------------------------------------------------------
// runSuite: returns { results, summary }. Never throws for provider misbehaviour; throws only on bad config.
// runSuite：返回 { results, summary }。提供者出错不会抛异常；只有配置错误才抛。
// ---------------------------------------------------------------------------------------------------------
export async function runSuite(opts = {}) {
  const origin = String(opts.url || '').replace(/\/+$/, '')
  if (!/^https?:\/\//.test(origin)) throw new Error('--url must be an http(s) URL, e.g. http://127.0.0.1:8787')
  const live = String(opts.live || `${origin}/tapeapi/v1`).replace(/\/+$/, '')
  const maxSkew = Number(opts.maxSkewS ?? 300)
  const timeoutMs = Number(opts.timeoutMs ?? 30_000)
  const chainId = Number(opts.chainId ?? 56)
  const userParams = opts.params || {}
  const H = createHarness({ live, timeoutMs, maxSkewS: maxSkew, fetch: opts.fetch || globalThis.fetch })
  const { results, rec, pass, fail, skip, check, http, post, describe, limited, verifies, checkEnvelope } = H

  // ======================================================================================================
  // 1. Discovery: manifest + health / 发现：清单与健康检查
  // ======================================================================================================
  const mr = await http(`${origin}/.well-known/tapeapi.json`)
  let manifest = null
  if (mr.status === 200 && isPlainObject(mr.json)) {
    pass('tap20.manifest.fetch', 'MUST', 'TAP-20 §3.2', 'discovery')
    manifest = mr.json
  } else fail('tap20.manifest.fetch', 'MUST', 'TAP-20 §3.2', 'discovery', `GET /.well-known/tapeapi.json: ${describe(mr)}`)
  if (manifest) {
    check(mr.size <= MANIFEST_LIMIT, 'tap20.manifest.size', 'MUST', 'TAP-20 §3.2', 'discovery', `${mr.size} bytes > ${MANIFEST_LIMIT}`)
    check(/^application\/json\b/i.test(mr.headers.get('content-type') || ''), 'tap20.manifest.content-type', 'SHOULD', 'TAP-20 §3.2', 'discovery', `content-type ${mr.headers.get('content-type')}`)
    try {
      validateManifest(manifest, { requireDelegation: true, allowHttp: true })
      pass('tap20.manifest.schema', 'MUST', 'TAP-20 §3.3', 'discovery')
    } catch (e) { fail('tap20.manifest.schema', 'MUST', 'TAP-20 §3.3', 'discovery', e.message) }
  }
  // A trusted manifest (resolved on-chain by the operator) overrides the served one as the source of truth.
  // 受信清单（运营方从链上解析所得）优先于端点自报的清单。
  let ref = manifest
  if (opts.manifest) {
    ref = opts.manifest
    if (manifest) {
      let same = false
      try { same = canonicalJSON(manifest) === canonicalJSON(opts.manifest) } catch { same = false }
      check(same, 'tap20.manifest.matches-trusted', 'SHOULD', 'TAP-20 §3.6', 'discovery', 'served /.well-known/tapeapi.json differs from the trusted (on-chain) manifest')
    }
  }
  if (!ref || !isAddress(ref.signer) || !isAddress(ref.container) || !Array.isArray(ref.methods)) {
    fail('suite.prerequisites', 'MUST', '', 'discovery', 'no usable manifest (signer/container/methods); remaining checks cannot run')
    return finish()
  }
  H.setTrusted({ signer: ref.signer, container: ref.container })
  const trusted = H.trusted
  const methods = ref.methods.filter(m => m && typeof m.name === 'string' && METHOD_NAME_RE.test(m.name))
  const priceOf = (m) => { try { return parseUnits(m.priceBEM == null ? '0' : String(m.priceBEM)) } catch { return null } }
  const free = methods.filter(m => priceOf(m) === 0n)
  const paid = methods.filter(m => (priceOf(m) ?? 0n) > 0n)

  const hr = await http(`${live}/health`)
  let health = null
  if (hr.status === 200 && isPlainObject(hr.json) && hr.json.ok === true) { pass('tap21.health.fetch', 'SHOULD', 'reference convention', 'discovery'); health = hr.json }
  else fail('tap21.health.fetch', 'SHOULD', 'reference convention', 'discovery', `GET /tapeapi/v1/health: ${describe(hr)}`)
  if (health) {
    if (health.signer !== undefined) check(isAddress(health.signer) && eqAddr(health.signer, trusted.signer), 'tap21.health.signer', 'SHOULD', 'reference convention', 'discovery', `health.signer ${health.signer} != manifest.signer ${trusted.signer}`)
    if (health.minVoucherLifeS !== undefined) check(Number.isInteger(health.minVoucherLifeS) && health.minVoucherLifeS >= 0, 'tap22.health.minVoucherLifeS', 'SHOULD', 'TAP-22 §3.2(2)', 'discovery', `minVoucherLifeS ${JSON.stringify(health.minVoucherLifeS)} is not a non-negative integer`)
  }
  const probeMethod = (free[0] || methods[0])?.name || 'x'

  // ======================================================================================================
  // 2. HTTP surface (reference conventions; no spec MUST yet) / HTTP 外观（参考实现惯例）
  // ======================================================================================================
  {
    const r = await http(`${live}/${probeMethod}`, { method: 'OPTIONS', headers: { origin: 'https://conformance.invalid', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } })
    const acao = r.headers.get('access-control-allow-origin'), acam = r.headers.get('access-control-allow-methods') || ''
    check(!r.transportError && (r.status === 204 || r.status === 200) && !!acao && /POST/i.test(acam), 'http.options-cors', 'SHOULD', 'reference convention', 'http',
      `OPTIONS: ${describe(r)} allow-origin=${acao} allow-methods=${acam}`)
    if (!r.transportError && r.status === 200) rec('http.options-204', 'SHOULD', 'fail', 'OPTIONS answered 200, expected 204', { context: 'http', spec: 'reference convention' })
  }
  {
    const r = await http(`${live}/${probeMethod}`)
    if (!limited(r, 'http.get-method-405', 'SHOULD', 'reference convention', 'http')) check(r.status === 405, 'http.get-method-405', 'SHOULD', 'reference convention', 'http', `GET on a method: ${describe(r)}`)
  }
  {
    const r = await http(`${origin}/conformance/no/such/route`)
    check(r.status === 404, 'http.unknown-route-404', 'SHOULD', 'reference convention', 'http', `GET unknown route: ${describe(r)}`)
  }

  // ======================================================================================================
  // 3. Free methods: full envelope battery / 免费方法：完整信封检查
  // ======================================================================================================
  let sample = null // { env, reqId, method, params }
  if (!free.length) skip('tap21.free.ok', 'SHOULD', 'TAP-21 §3.2', 'free', 'manifest lists no free methods')
  for (const m of free) {
    const params = isPlainObject(userParams[m.name]) ? userParams[m.name] : {}
    const reqId = `conf-${randomUUID()}`
    const r = await post(m.name, { id: reqId, method: m.name, params })
    const ctx = `free:${m.name}`
    if (limited(r, 'tap21.envelope.parse', 'MUST', 'TAP-21 §3.2', ctx)) continue
    const env = checkEnvelope(r, { reqId, method: m.name, params, context: ctx })
    if (env) {
      check(env.ok === true, 'tap21.free.ok', 'SHOULD', 'TAP-21 §3.2', ctx, `free method answered ok:false ${env.error?.code}: ${env.error?.message} (supply params with --params if it needs them)`)
      if (!sample || (env.ok && !sample.env.ok)) sample = { env, reqId, method: m.name, params }
    }
    if (env && isPlainObject(r.json) && r.headers.get('access-control-allow-origin') === null) fail('http.cors-on-response', 'SHOULD', 'reference convention', ctx, 'POST response carries no Access-Control-Allow-Origin')
    else if (env) pass('http.cors-on-response', 'SHOULD', 'reference convention', ctx)
  }

  // ======================================================================================================
  // 4. Unknown method → signed METHOD_NOT_FOUND / 未知方法
  // ======================================================================================================
  {
    const reqId = `conf-${randomUUID()}`
    const r = await post(UNKNOWN_METHOD, { id: reqId, method: UNKNOWN_METHOD, params: {} })
    const ctx = 'unknown-method'
    if (!limited(r, 'tap21.method-not-found', 'MUST', 'TAP-21 §3.2', ctx)) {
      const env = checkEnvelope(r, { reqId, method: UNKNOWN_METHOD, params: {}, context: ctx })
      check(env && env.ok === false && env.error?.code === 'METHOD_NOT_FOUND', 'tap21.method-not-found', 'MUST', 'TAP-21 §3.2', ctx,
        env ? `expected signed METHOD_NOT_FOUND, got ok=${env.ok} code=${env.error?.code}` : 'no verifiable envelope for an unknown method')
      if (!sample && env) sample = { env, reqId, method: UNKNOWN_METHOD, params: {} }
    }
  }

  // ======================================================================================================
  // 5. Tamper checks: the provider's signature must bind ok, body, request, id and ts
  //    篡改检查：签名必须绑定 ok、body、请求、id 与 ts
  // ======================================================================================================
  if (!sample) {
    for (const id of ['tap21.tamper.ok-flip', 'tap21.tamper.body', 'tap21.tamper.request', 'tap21.tamper.id', 'tap21.tamper.ts']) skip(id, 'MUST', 'TAP-21 §3.3', 'tamper', 'no verified envelope to tamper with')
  } else {
    const { env, reqId, method, params } = sample
    const body = env.ok ? env.result : env.error
    const flipped = { ok: !env.ok, [env.ok ? 'error' : 'result']: body }
    check(!verifies(env, reqId, method, params, flipped).ok, 'tap21.tamper.ok-flip', 'MUST', 'TAP-21 §3.3', 'tamper', 'flipping ok still verifies: ok is not covered by the signature')
    const mutated = mutate(body)
    check(!verifies(env, reqId, method, params, env.ok ? { result: mutated } : { error: mutated }).ok, 'tap21.tamper.body', 'MUST', 'TAP-21 §3.3', 'tamper', 'changing the result/error still verifies')
    check(!verifies(env, reqId, method, { ...params, conformanceTamper: 1 }).ok, 'tap21.tamper.request', 'MUST', 'TAP-21 §3.3', 'tamper', 'a different request {method, params} still verifies')
    check(!verifies(env, reqId + 'x', method, params).ok, 'tap21.tamper.id', 'MUST', 'TAP-21 §3.3', 'tamper', 'a different id still verifies')
    check(!verifies(env, reqId, method, params, { ts: env.ts + 1 }).ok, 'tap21.tamper.ts', 'MUST', 'TAP-21 §3.3', 'tamper', 'a different ts still verifies')
  }

  // ======================================================================================================
  // 6. Canonicalisation interop: the provider must hash OUR request with JCS
  //    规范化互操作：提供者必须用 JCS 哈希我们的请求
  // ======================================================================================================
  {
    const method = (free[0] || methods[0])?.name
    const reqId = `conf-${randomUUID()}`
    const r = await post(method, { id: reqId, method, params: CANON_PARAMS })
    const ctx = 'canon'
    if (!limited(r, 'tap21.canon.request-hash', 'MUST', 'TAP-21 §3.3', ctx)) {
      if (r.transportError || !isPlainObject(r.json) || typeof r.json.sig !== 'string') fail('tap21.canon.request-hash', 'MUST', 'TAP-21 §3.3', ctx, `no signed envelope: ${describe(r)}`)
      else {
        const v = verifies(r.json, reqId, method, CANON_PARAMS)
        check(v.ok, 'tap21.canon.request-hash', 'MUST', 'TAP-21 §3.3', ctx, `envelope for params ${canonicalJSON(CANON_PARAMS)} recovers to ${v.got}: the provider does not canonicalise {method, params} with JCS (RFC 8785) + TAPI restrictions`)
      }
    }
  }

  // ======================================================================================================
  // 7. Malformed requests / 畸形请求
  // ======================================================================================================
  const rejectCheck = async (id, level, spec, text, { codes = ['BAD_REQUEST'], statuses = [400], context }) => {
    const r = await post(probeMethod, text)
    if (limited(r, id, level, spec, context)) return r
    const code = r.json?.error?.code
    check(!r.transportError && statuses.includes(r.status) && isPlainObject(r.json) && r.json.ok === false && codes.includes(code), id, level, spec, context,
      `expected HTTP ${statuses.join('/')} ok:false ${codes.join('|')}, got ${describe(r)}`)
    return r
  }
  {
    const r = await rejectCheck('tap21.request.malformed-json', 'MUST', 'TAP-21 §3.1/§3.2', '{not json', { context: 'malformed' })
    // No id can be echoed for an unparseable body, so the signature is checked against what the envelope claims.
    // 无法解析的请求体没有 id 可回显，因此按信封自述的 id 验签。
    if (isPlainObject(r.json) && typeof r.json.sig === 'string') {
      const v = verifies(r.json, String(r.json.id ?? ''), probeMethod, {})
      check(v.ok, 'tap21.request.malformed-signed', 'SHOULD', 'TAP-21 §3.2', 'malformed', `BAD_REQUEST envelope carries a sig that does not verify under (id=${JSON.stringify(r.json.id)}, method=${probeMethod}, params={}): ${v.got}`)
    }
  }
  await rejectCheck('tap21.request.proto-key', 'MUST', 'TAP-21 §3.1', '{"id":"conf-proto","params":{"__proto__":{"polluted":true}}}', { context: 'proto:__proto__' })
  await rejectCheck('tap21.request.proto-key', 'MUST', 'TAP-21 §3.1', '{"id":"conf-ctor","constructor":1,"params":{}}', { context: 'proto:constructor' })
  await rejectCheck('tap21.request.proto-key', 'MUST', 'TAP-21 §3.1', '{"id":"conf-prot","params":{"a":[{"prototype":1}]}}', { context: 'proto:prototype' })
  for (const [ctx, text] of [['dup:top', '{"id":"conf-dup","id":"conf-dup2","params":{}}'], ['dup:nested', '{"id":"conf-dup3","params":{"a":1,"a":2}}']]) {
    const r = await rejectCheck('tap21.request.duplicate-key', 'MUST', 'TAP-21 §3.3(1)', text, { codes: ['BAD_REQUEST', 'CANON_INVALID'], statuses: [400], context: ctx })
    if (r.json?.error?.code) check(r.json.error.code === 'BAD_REQUEST', 'tap21.request.duplicate-key.code', 'SHOULD', 'TAP-21 §3.2 (error code list)', ctx, `rejected with ${r.json.error.code}; only the five TAP-21 codes may appear on the wire`)
  }
  await rejectCheck('tap21.request.missing-id', 'SHOULD', 'TAP-21 §3.1', JSON.stringify({ params: {} }), { context: 'missing-id' })
  await rejectCheck('tap21.request.params-not-object', 'SHOULD', 'TAP-21 §3.1', JSON.stringify({ id: 'conf-arr', params: [1] }), { context: 'params-array' })
  {
    const limit = Number(opts.bodyLimit ?? ENVELOPE_LIMIT)
    const pad = 'x'.repeat(Math.max(0, limit + 1 - 40))
    const r = await post(probeMethod, JSON.stringify({ id: 'conf-big', params: { pad } }))
    const ctx = `oversize:${limit + 1}B`
    if (!limited(r, 'tap21.request.oversize-413', 'SHOULD', 'TAP-21 §3.2', ctx)) {
      if (r.transportError) fail('tap21.request.oversize-413', 'SHOULD', 'TAP-21 §3.2', ctx, `connection dropped instead of an HTTP answer (${r.transportError})`)
      else check(r.status === 413, 'tap21.request.oversize-413', 'SHOULD', 'TAP-21 §3.2', ctx, `expected 413, got ${describe(r)}`)
      if (!r.transportError) check(!(isPlainObject(r.json) && r.json.ok === true), 'tap21.request.oversize-not-served', opts.bodyLimit ? 'MUST' : 'SHOULD', 'provider body limit', ctx, `a ${limit + 1}-byte request was served ok:true`)
    }
  }

  // ======================================================================================================
  // 8. TAP-22 without keys: a priced method with no voucher / 无密钥的 TAP-22：收费方法不带凭证
  // ======================================================================================================
  if (!paid.length) skip('tap22.payment-required', 'MUST', 'TAP-22 §3.2', 'paid', 'manifest lists no priced methods')
  else {
    const m = paid[0]
    const params = isPlainObject(userParams[m.name]) ? userParams[m.name] : {}
    const reqId = `conf-${randomUUID()}`
    const r = await post(m.name, { id: reqId, method: m.name, params })
    const ctx = `no-voucher:${m.name}`
    if (!limited(r, 'tap22.payment-required', 'MUST', 'TAP-22 §3.2', ctx)) {
      const env = checkEnvelope(r, { reqId, method: m.name, params, context: ctx })
      check(env && env.ok === false && env.error?.code === 'PAYMENT_REQUIRED', 'tap22.payment-required', 'MUST', 'TAP-22 §3.2', ctx, env ? `expected PAYMENT_REQUIRED, got ok=${env.ok} code=${env.error?.code}` : 'no verifiable envelope')
      // data.price is BEM base units (10^-8), a decimal integer string. "0.0001" (BEM units) fails loudly: a client
      // that reads it as base units would refuse or deadlock (traceability D6).
      // data.price 是 BEM 基本单位（10^-8）的十进制整数串；"0.0001"（BEM 单位）会明确失败。
      if (env?.error?.code === 'PAYMENT_REQUIRED') {
        const dp = env.error.data?.price
        check(isDecimalString(dp), 'tap22.payment-required.data.price', 'MUST', 'TAP-22 §3.2', ctx, `data.price must be a decimal string of base units, got ${JSON.stringify(dp)}`)
        if (isDecimalString(dp)) check(BigInt(dp) === priceOf(m), 'tap22.payment-required.price-matches-manifest', 'SHOULD', 'TAP-22 §3.2', ctx, `data.price ${dp} != manifest price ${priceOf(m)} base units`)
      }
    }
  }

  // ======================================================================================================
  // 9. TAP-22 with keys: stale vouchers and short-lived vouchers (never a voucher that could be served)
  //    带密钥的 TAP-22：过期累计与寿命过短的凭证（绝不发送可能被服务的凭证）
  // ======================================================================================================
  if (opts.paidMethod) await paidChecks()
  else for (const id of ['tap22.bad-voucher.data.lastCumulative', 'tap22.bad-voucher.data.onChainClaimed', 'tap22.bad-voucher.data.price', 'tap22.bad-voucher.minVoucherLifeS']) skip(id, 'MUST', 'TAP-22 §3.2', 'paid', 'no --paid-method/--consumer-key given')

  async function paidChecks() {
    const m = methods.find(x => x.name === opts.paidMethod)
    if (!m) throw new Error(`--paid-method ${opts.paidMethod} is not in the manifest`)
    const price = priceOf(m)
    if (!price) throw new Error(`--paid-method ${opts.paidMethod} is free`)
    const escrow = ref.payment?.escrow
    if (!isAddress(escrow)) throw new Error('manifest.payment.escrow is missing; cannot sign vouchers')
    if (!opts.consumerKey) throw new Error('--consumer-key is required with --paid-method')
    const consumer = privateKeyToAddress(opts.consumerKey)
    const signKey = opts.sessionKey || opts.consumerKey
    const params = isPlainObject(userParams[m.name]) ? userParams[m.name] : {}
    const minLife = Number.isInteger(health?.minVoucherLifeS) ? health.minVoucherLifeS : null
    const mkVoucher = (cumulative, expires) => {
      const v = { consumer, provider: trusted.container, cumulative: String(cumulative), expires }
      return { ...v, sig: signDigest(voucherDigest(chainId, escrow, v), signKey), signer: privateKeyToAddress(signKey) }
    }
    const call = async (voucher, ctx) => {
      const reqId = `conf-${randomUUID()}`
      const r = await post(m.name, { id: reqId, method: m.name, params, voucher })
      if (limited(r, 'tap22.bad-voucher', 'MUST', 'TAP-22 §3.2', ctx)) return null
      return checkEnvelope(r, { reqId, method: m.name, params, context: ctx })
    }
    const longLife = now() + Math.max(minLife ?? 0, 300) + 3600
    const staleChecks = (env, ctx) => {
      const isBV = env && env.ok === false && env.error?.code === 'BAD_VOUCHER'
      const data = isBV && isPlainObject(env.error.data) ? env.error.data : {}
      const why = isBV ? `BAD_VOUCHER "${env.error.message}" data=${JSON.stringify(env.error.data ?? null)}` : `expected BAD_VOUCHER, got ok=${env?.ok} code=${env?.error?.code} "${env?.error?.message}"`
      check(isBV, 'tap22.bad-voucher', 'MUST', 'TAP-22 §3.2', ctx, why)
      check(isBV && isDecimalString(data.lastCumulative), 'tap22.bad-voucher.data.lastCumulative', 'MUST', 'TAP-21 §3.2 / TAP-22 §3.2', ctx, `data.lastCumulative missing or not a decimal string: ${why}`)
      check(isBV && isDecimalString(data.onChainClaimed), 'tap22.bad-voucher.data.onChainClaimed', 'MUST', 'TAP-22 §3.2', ctx, `data.onChainClaimed missing or not a decimal string: ${why}`)
      check(isBV && isDecimalString(data.price), 'tap22.bad-voucher.data.price', 'MUST', 'TAP-22 §3.2', ctx, `data.price missing or not a decimal string: ${why}`)
      if (isDecimalString(data.price)) check(BigInt(data.price) === price, 'tap22.bad-voucher.price-matches-manifest', 'SHOULD', 'TAP-20 §3.6 / TAP-22 §3.3', ctx, `data.price ${data.price} != manifest price ${price} (the consumer will re-read the manifest)`)
      if (isDecimalString(data.lastCumulative) && isDecimalString(data.onChainClaimed)) check(BigInt(data.lastCumulative) >= BigInt(data.onChainClaimed), 'tap22.bad-voucher.last-ge-claimed', 'MUST', 'TAP-21 §3.2 (lastCumulative = max(stored, claimedOf))', ctx, `lastCumulative ${data.lastCumulative} < onChainClaimed ${data.onChainClaimed}`)
      if (isPlainObject(data.voucher)) check(isDecimalString(data.voucher.cumulative) && typeof data.voucher.sig === 'string' && data.voucher.cumulative === data.lastCumulative, 'tap22.bad-voucher.data.voucher', 'MUST', 'TAP-22 §3.2', ctx, `data.voucher malformed or not for lastCumulative: ${JSON.stringify(data.voucher)}`)
      return isBV ? data : null
    }
    // (a) cumulative 0 is at or below claimedOf for every channel: stale by construction, never servable.
    // (a) cumulative 0 对任何通道都 ≤ claimedOf：必然过期，绝不可能被服务。
    const e0 = await call(mkVoucher(0, longLife), `stale:cumulative=0:${m.name}`)
    const d0 = e0 ? staleChecks(e0, `stale:cumulative=0:${m.name}`) : null
    // (b) lastCumulative + price − 1: one unit short of the next valid voucher. The figure comes from the
    //     provider, so it is signed over ONLY when proven (TAP-22 §3.2): zero, or backed by an attached voucher
    //     that recovers to our own consumer / session key. Signing an unproven figure is exactly the drain the
    //     spec warns about: a hostile provider names a huge lastCumulative and settles the voucher we sign.
    // (b) lastCumulative + price − 1：差一个单位。该数字来自提供者，只有被证明时才签（为 0，或附带的凭证能恢复出
    //     我们自己的消费者/会话密钥）。对未经证明的数字签名，正是规范警告的掏空攻击。
    if (d0 && isDecimalString(d0.lastCumulative)) {
      const last = BigInt(d0.lastCumulative)
      const ctx = `stale:last+price-1:${m.name}`
      let proven = last === 0n
      if (!proven && isPlainObject(d0.voucher) && d0.voucher.cumulative === d0.lastCumulative && Number.isInteger(d0.voucher.expires)) {
        try {
          const who = recoverAddress(voucherDigest(chainId, escrow, { consumer, provider: trusted.container, cumulative: d0.lastCumulative, expires: d0.voucher.expires }), d0.voucher.sig)
          proven = eqAddr(who, consumer) || eqAddr(who, privateKeyToAddress(signKey))
        } catch { proven = false }
      }
      const below = last + price - 1n
      if (!proven) skip('tap22.bad-voucher.below-last-plus-price', 'MUST', 'TAP-22 §3.2', ctx, `lastCumulative ${d0.lastCumulative} is not proven by an attached voucher signed by our key; refusing to sign a voucher above 0`)
      else if (below > 0n) {
        const e1 = await call(mkVoucher(below, longLife), `stale:last+price-1=${below}:${m.name}`)
        if (e1) staleChecks(e1, `stale:last+price-1=${below}:${m.name}`)
      }
    }
    // (c) minimum voucher life, when the provider advertises one. Cumulative 0 keeps it unservable even if
    //     the provider ignores the floor. / 提供者公布了最短寿命时检查；cumulative 0 保证即便无视下限也不会被服务。
    if (minLife === null || minLife < 10) skip('tap22.bad-voucher.minVoucherLifeS', 'MUST', 'TAP-22 §3.2(2)', 'min-life', `provider does not advertise a minVoucherLifeS >= 10 in /health (got ${JSON.stringify(health?.minVoucherLifeS)})`)
    else {
      // Dated on the PROVIDER's clock (from its last envelope ts), so clock skew cannot turn this into "expired".
      // 以提供者的时钟（取自其最近信封的 ts）计时，避免时钟偏差把它变成"已过期"。
      const ctx = `min-life:expires=now+${Math.floor(minLife / 2)}:${m.name}`
      const env = await call(mkVoucher(0, now() + H.clockSkew + Math.floor(minLife / 2)), ctx)
      const d = env?.ok === false && env.error?.code === 'BAD_VOUCHER' && isPlainObject(env.error.data) ? env.error.data : null
      // TAP-22 §3.2: EVERY BAD_VOUCHER and PAYMENT_REQUIRED carries data.price, stale or not (settled 2026-09-22).
      // TAP-22 §3.2：每个 BAD_VOUCHER 与 PAYMENT_REQUIRED 都带 data.price，无论是否过期累计（2026-09-22 厘清）。
      if (d) check(isDecimalString(d.price), 'tap22.bad-voucher.data.price.non-stale', 'MUST', 'TAP-22 §3.2', ctx, `min-life BAD_VOUCHER carries no data.price: data=${JSON.stringify(d)}`)
      if (d && d.minVoucherLifeS === undefined && isDecimalString(d.lastCumulative)) skip('tap22.bad-voucher.minVoucherLifeS', 'MUST', 'TAP-22 §3.2(2)', ctx, 'inconclusive: provider checked the cumulative before the voucher life')
      else check(d && d.minVoucherLifeS === minLife, 'tap22.bad-voucher.minVoucherLifeS', 'MUST', 'TAP-22 §3.2(2)', ctx,
        `a voucher expiring in ${Math.floor(minLife / 2)}s (< advertised ${minLife}s) must be BAD_VOUCHER with data.minVoucherLifeS=${minLife}; got ok=${env?.ok} code=${env?.error?.code} data=${JSON.stringify(env?.error?.data ?? null)}`)
    }
  }

  // ======================================================================================================
  // 10. Rate limiting (last: it may exhaust the budget) / 限流（最后执行：可能耗尽预算）
  // ======================================================================================================
  if (opts.checkRateLimit) {
    H.setRatePhase(true)
    const n = Number(opts.checkRateLimit) + 5
    const method = (free[0] || { name: UNKNOWN_METHOD }).name
    const rs = await Promise.all(Array.from({ length: n }, (_, i) => post(method, { id: `conf-rl-${i}`, method, params: {} })))
    const limitedRs = rs.filter(r => r.status === 429)
    const ctx = `burst:${n}`
    if (!limitedRs.length) {
      for (const id of ['tap21.ratelimit.unsigned', 'tap21.ratelimit.retry-after', 'tap21.ratelimit.code']) skip(id, 'MUST', 'TAP-21 §3.4', ctx, `no 429 within ${n} rapid calls (rate limiting is MAY)`)
    } else {
      H.checkRateLimited(limitedRs, ctx)
    }
    H.setRatePhase(false)
  }

  return finish()

  function finish() {
    H.checkSizeCap()
    return { results, summary: summarize(results, opts.strict) }
  }
}

const USAGE = `usage: node conformance/run.mjs --url http://host:port [options]
  --manifest path.json        trusted manifest (resolved on-chain); default: the served /.well-known/tapeapi.json
  --params path.json          { "<method>": { ...params } } used when calling methods (default {})
  --live URL                  live base (default <url>/tapeapi/v1)
  --paid-method name          enable TAP-22 checks against this priced method
  --consumer-key 0x..         consumer private key (address is derived; it is never sent)
  --session-key 0x..          sign vouchers with this authorised session key instead of the consumer key
  --chain-id 56               EIP-712 chain id for vouchers
  --check-rate-limit N        send N+5 rapid free calls and check any 429 (run against a quiet instance)
  --body-limit BYTES          provider's request body limit (default: send 1 MiB + 1)
  --max-skew S                ts window (default 300)       --timeout-ms MS  per request (default 30000)
  --junit out.xml             write JUnit XML               --json out.json  write raw results
  --strict                    SHOULD failures also fail the run     --quiet  print only non-passing checks`

async function main() {
  let a
  try { a = parseArgs(process.argv.slice(2)) } catch (e) { console.error(e.message + '\n' + USAGE); process.exit(2) }
  if (a.help || !a.url) { console.error(USAGE); process.exit(a.help ? 0 : 2) }
  const readJson = (p) => safeParseJSON(readFileSync(p, 'utf8'))
  let out
  try {
    out = await runSuite({
      url: a.url, live: a.live, manifest: a.manifest ? readJson(a.manifest) : undefined, params: a.params ? readJson(a.params) : undefined,
      paidMethod: a.paidMethod, consumerKey: a.consumerKey, sessionKey: a.sessionKey, chainId: a.chainId ? Number(a.chainId) : undefined,
      checkRateLimit: a.checkRateLimit ? Number(a.checkRateLimit) : 0, bodyLimit: a.bodyLimit ? Number(a.bodyLimit) : undefined,
      maxSkewS: a.maxSkew ? Number(a.maxSkew) : undefined, timeoutMs: a.timeoutMs ? Number(a.timeoutMs) : undefined, strict: !!a.strict,
    })
  } catch (e) { console.error(`configuration error: ${e.message}`); process.exit(2) }
  console.log(formatText(out.results, out.summary, { verbose: !a.quiet }))
  if (a.junit) writeFileSync(a.junit, formatJUnit(out.results, out.summary, { strict: !!a.strict }))
  if (a.json) writeFileSync(a.json, JSON.stringify(out, null, 2))
  process.exit(out.summary.conformant ? 0 : 1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
