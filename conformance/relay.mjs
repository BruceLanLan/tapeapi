#!/usr/bin/env node
// TapeAPI RELAY conformance suite (black-box, TAPI-26 §3.5). / TapeAPI 中继一致性测试套件（黑盒，TAPI-26 §3.5）。
//
// A relay is itself a TapeAPI service: relaySend / relayHandshake / relayRecv are TAPI-21 calls answered with signed
// envelopes. This suite tests ANY relay by URL. Every answer goes through the provider suite's envelope checks
// (conformance/lib.mjs), and every relay check has a stable id, a level (MUST / SHOULD) and a spec citation.
// 中继本身就是 TapeAPI 服务：relaySend / relayHandshake / relayRecv 都是以签名信封作答的 TAPI-21 调用。本套件按 URL
// 测试任意中继；每个回答都经过提供者套件的信封检查，每一项中继检查都有稳定 id、级别（MUST / SHOULD）与规范出处。
//
//   node conformance/relay.mjs --url http://127.0.0.1:8788 [--manifest trusted.json]
//        [--max-frame-b64 N] [--handshake-b64 N] [--room-frames N] [--full-wait-ms 60000] [--poll-timeout-ms 90000]
//        [--check-rate-limit N] [--slack-ms 2000] [--max-skew 300] [--timeout-ms 30000] [--junit out.xml] [--json out.json] [--strict] [--quiet]
//
// What it leaves behind: a few hundred small frames and ~60 frames of 16 KiB in random rooms, which the relay
// expires like any other room. On a priced relay it posts nothing that costs money (relaySend checks are skipped).
// 它会留下：随机房间里几百个小帧与约 60 个 16 KiB 的帧，中继会像对待其他房间一样让它们过期。
// 对收费中继，它不发送任何要花钱的东西（relaySend 相关检查跳过）。
import { writeFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { randomUUID, randomBytes } from 'node:crypto'
import { canonicalJSON, safeParseJSON } from '../sdk/src/canon.js'
import { parseUnits } from '../sdk/src/manifest.js'
import { isAddress } from '../sdk/src/abi.js'
import { createHarness, summarize, formatText, formatJUnit, parseArgs, isPlainObject, ENVELOPE_LIMIT } from './lib.mjs'

export { summarize, failed, formatText, formatJUnit } from './lib.mjs'

const S = 'TAPI-26 §3.5'
const EPOCH_RE = /^[0-9a-f]{1,32}$/
const MAX_WIRE = 16_448            // largest wire message (TAPI-26 §3.2: a sealed invite) / 最大线路消息
// Reference-relay figures, used when the operator does not state its own (and then only at SHOULD level).
// 参考中继的数值；运营方未声明自己的数值时使用（此时只按 SHOULD 判定）。
const REF = { maxFrameB64: 22_000, handshakeB64: 2_048, roomFrames: 256 }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const hex = (n) => randomBytes(n).toString('hex')
const b64 = (bytes) => Buffer.from(bytes).toString('base64')
// A wire message: type byte, then `n` further bytes (random unless given). / 线路消息：类型字节加 n 个字节。
const wire = (type, n = 48, body) => b64(Buffer.concat([Buffer.of(type), body ?? randomBytes(n)]))
const handshakeWire = (t, extra = {}) => b64(Buffer.concat([Buffer.of(0x01), Buffer.from(JSON.stringify(
  t === 'accept' ? { t, cid: hex(16), e: hex(32), confirm: hex(32), ...extra } : { t, cid: hex(16), confirm: hex(32), ...extra }), 'utf8')]))
const typeOf = (frame) => { try { return Buffer.from(frame, 'base64')[0] } catch { return -1 } }
const retryAfterMs = (r) => {
  const h = r.headers.get('retry-after') || ''
  if (/^\d+$/.test(h)) return Number(h) * 1000
  const d = Date.parse(h)
  return Number.isNaN(d) ? null : Math.max(0, d - Date.now())
}

// ---------------------------------------------------------------------------------------------------------
// runRelaySuite: returns { results, summary }. Never throws for relay misbehaviour; throws only on bad config.
// runRelaySuite：返回 { results, summary }。中继出错不会抛异常；只有配置错误才抛。
// ---------------------------------------------------------------------------------------------------------
export async function runRelaySuite(opts = {}) {
  const origin = String(opts.url || '').replace(/\/+$/, '')
  if (!/^https?:\/\//.test(origin)) throw new Error('--url must be an http(s) URL, e.g. http://127.0.0.1:8788')
  const live = String(opts.live || `${origin}/tapeapi/v1`).replace(/\/+$/, '')
  const num = (v, d) => { if (v === undefined || v === null) return d; const n = Number(v); if (!Number.isInteger(n) || n <= 0) throw new Error(`expected a positive integer, got ${v}`); return n }
  // An operator-stated cap turns its check into a MUST; the reference default is only a SHOULD (the spec states the
  // reference figures as examples). / 运营方声明的上限使对应检查成为 MUST；参考默认值只按 SHOULD。
  const maxFrameB64 = num(opts.maxFrameB64, REF.maxFrameB64)
  // How late a long-poll answer may be before it counts as not honouring waitMs / waking late (default 2 s: a relay
  // across the internet). The self-test on a loaded machine raises it. / 长轮询回答可以迟多久（默认 2 秒）；负载高的机器上自测时调大。
  const slackMs = num(opts.slackMs, 2000)
  const handshakeB64 = num(opts.handshakeB64, REF.handshakeB64)
  const roomFrames = num(opts.roomFrames, REF.roomFrames)
  const fullWaitMs = num(opts.fullWaitMs, 60_000)
  const pollTimeoutMs = num(opts.pollTimeoutMs, 90_000)
  const maxRetryWaitMs = num(opts.maxRetryWaitS, 120) * 1000
  const H = createHarness({ live, timeoutMs: Number(opts.timeoutMs ?? 30_000), maxSkewS: Number(opts.maxSkewS ?? 300), fetch: opts.fetch || globalThis.fetch })
  const { results, pass, fail, skip, check, http, post, describe, checkEnvelope, verifies } = H
  const seen429 = []

  // ---- bulk calls: envelope checks aggregated into one record per id / 批量调用：信封检查按 id 汇总为一条 ----
  const agg = new Map()
  const bump = (id, level, spec, failure) => {
    const a = agg.get(id) || { level, spec, n: 0, fails: 0, first: '' }
    a.n++; if (failure) { a.fails++; a.first ||= failure }
    agg.set(id, a)
  }
  const bulkR = {
    pass: (id, level, spec) => bump(id, level, spec, null),
    fail: (id, level, spec, context, msg) => bump(id, level, spec, `[${context}] ${msg}`),
    check: (cond, id, level, spec, context, failMsg) => bump(id, level, spec, cond ? null : `[${context}] ${failMsg}`),
    skip: () => {}, rec: () => {},
  }

  // ---- one relay call. 429s are waited out (Retry-After) and kept for the TAPI-21 §3.4 checks. ----
  // ---- 一次中继调用。429 按 Retry-After 等待后重试，并留作 TAPI-21 §3.4 检查。----
  async function call(method, params, { ctx, bulk = false, timeoutMs } = {}) {
    for (let attempt = 0; ; attempt++) {
      const reqId = `relay-${randomUUID()}`
      const t0 = Date.now()
      const r = await post(method, { id: reqId, method, params }, { timeoutMs })
      const ms = Date.now() - t0
      if (r.status === 429) {
        seen429.push(r)
        const wait = retryAfterMs(r)
        if (attempt < 10 && wait !== null && wait <= maxRetryWaitMs) { await sleep(wait + 50); continue }
        return { r, env: null, ms, limited: true, reqId }
      }
      const env = checkEnvelope(r, { reqId, method, params, context: ctx, R: bulk ? bulkR : undefined })
      return { r, env, ms, reqId, params, method }
    }
  }
  // Records `id` as skipped (rate limited) or failed (no verified envelope) when the call gave nothing to judge.
  // 调用没有可判定的结果时：限流记为跳过，无有效信封记为失败。
  const usable = (res, id, level, ctx) => {
    if (res.limited) { skip(id, level, S, ctx, 'relay kept answering 429 beyond the retry budget'); return false }
    if (!res.env) { fail(id, level, S, ctx, `no verified envelope: ${describe(res.r)}`); return false }
    return true
  }
  const okResult = (res) => res.env?.ok === true && isPlainObject(res.env.result) ? res.env.result : null
  const errCode = (res) => (res.env?.ok === false ? res.env.error?.code : undefined)
  const outcome = (res) => res.limited ? 'HTTP 429' : res.env ? (res.env.ok ? `ok ${JSON.stringify(res.env.result).slice(0, 160)}` : `${res.env.error?.code}: ${res.env.error?.message}`) : describe(res.r)

  // Shape of a post answer { i, epoch } and a recv answer { frames: [{ i, frame }], next, epoch }. / 结果形状。
  const postShapeOk = (res) => { const x = okResult(res); return !!x && Number.isInteger(x.i) && x.i >= 0 && typeof x.epoch === 'string' }
  const recvShapeErr = (res) => {
    const x = okResult(res)
    if (!x) return `expected ok:true { frames, next, epoch }, got ${outcome(res)}`
    if (!Array.isArray(x.frames) || !x.frames.every((f) => isPlainObject(f) && Number.isInteger(f.i) && typeof f.frame === 'string')) return `frames is not [{ i, frame }]: ${JSON.stringify(x.frames).slice(0, 160)}`
    if (!Number.isInteger(x.next)) return `next ${JSON.stringify(x.next)} is not an integer`
    if (!(x.epoch === null || typeof x.epoch === 'string')) return `epoch ${JSON.stringify(x.epoch)} is neither a string nor null`
    return ''
  }
  const recv = async (room, after, { waitMs = 0, epoch, ctx, bulk, timeoutMs } = {}) => {
    const res = await call('relayRecv', { room, after, waitMs, ...(epoch !== undefined ? { epoch } : {}) }, { ctx, bulk, timeoutMs })
    // Judged on ok:true answers; a refusal is the business of the check that expected an answer.
    // 只判定 ok:true 的回答；拒绝由期待回答的那项检查负责。
    if (!res.limited && res.env?.ok === true) {
      const err = recvShapeErr(res)
      ;(bulk ? bulkR : H).check(!err, 'tapi26.relay.recv.result-shape', 'MUST', `${S} (table)`, ctx, err)
    }
    return res
  }
  // Follows `next` until nothing more comes back; every page is checked for size and progress.
  // 顺着 `next` 读到没有新内容；每一页都检查大小与推进。
  async function drain(room, epoch, ctx, { lastPosted } = {}) {
    const got = []; let after = -1; const pages = []
    for (let k = 0; k < 400; k++) {
      const res = await recv(room, after, { epoch, ctx: `${ctx}:page${k}`, bulk: true })
      pages.push(res)
      const x = okResult(res)
      if (!x || !Array.isArray(x.frames)) break
      got.push(...x.frames)
      if (!x.frames.length) break
      if (!Number.isInteger(x.next) || x.next <= after) break
      after = x.next
      if (lastPosted !== undefined && after >= lastPosted) break
    }
    return { got, pages }
  }

  // ======================================================================================================
  // 1. Discovery / 发现
  // ======================================================================================================
  const mr = await http(`${origin}/.well-known/tapeapi.json`)
  let manifest = null
  if (mr.status === 200 && isPlainObject(mr.json)) { pass('tapi20.manifest.fetch', 'MUST', 'TAPI-20 §3.2', 'discovery'); manifest = mr.json }
  else fail('tapi20.manifest.fetch', 'MUST', 'TAPI-20 §3.2', 'discovery', `GET /.well-known/tapeapi.json: ${describe(mr)}`)
  let ref = manifest
  if (opts.manifest) {
    ref = opts.manifest
    if (manifest) {
      let same = false
      try { same = canonicalJSON(manifest) === canonicalJSON(opts.manifest) } catch { same = false }
      check(same, 'tapi20.manifest.matches-trusted', 'SHOULD', 'TAPI-20 §3.6', 'discovery', 'served /.well-known/tapeapi.json differs from the trusted (on-chain) manifest')
    }
  }
  if (!ref || !isAddress(ref.signer) || !isAddress(ref.container) || !Array.isArray(ref.methods)) {
    fail('suite.prerequisites', 'MUST', '', 'discovery', 'no usable manifest (signer/container/methods); remaining checks cannot run')
    return finish()
  }
  H.setTrusted({ signer: ref.signer, container: ref.container })
  const byName = new Map(ref.methods.filter((m) => isPlainObject(m) && typeof m.name === 'string').map((m) => [m.name, m]))
  const priceOf = (name) => { try { return parseUnits(String(byName.get(name)?.priceBEM ?? '0')) } catch { return null } }

  // ======================================================================================================
  // 2. Manifest: three methods, handshake and recv free / 清单：三个方法，握手与接收免费
  // ======================================================================================================
  const missing = ['relaySend', 'relayHandshake', 'relayRecv'].filter((n) => !byName.has(n))
  check(!missing.length, 'tapi26.relay.manifest.methods', 'MUST', `${S} (table)`, 'manifest', `manifest does not list ${missing.join(', ')}`)
  if (byName.has('relayHandshake')) check(priceOf('relayHandshake') === 0n, 'tapi26.relay.manifest.handshake-free', 'MUST', `${S} (table: relayHandshake MUST be 0)`, 'manifest', `relayHandshake priceBEM ${JSON.stringify(byName.get('relayHandshake').priceBEM)}`)
  if (byName.has('relayRecv')) check(priceOf('relayRecv') === 0n, 'tapi26.relay.manifest.recv-free', 'MUST', `${S} (table)`, 'manifest', `relayRecv priceBEM ${JSON.stringify(byName.get('relayRecv').priceBEM)}`)
  if (!byName.has('relayRecv') || (!byName.has('relaySend') && !byName.has('relayHandshake'))) {
    fail('suite.prerequisites', 'MUST', '', 'manifest', 'relayRecv and a posting method are needed for the remaining checks')
    return finish()
  }
  const sendPrice = priceOf('relaySend')
  const canSend = byName.has('relaySend') && sendPrice === 0n
  const canHandshake = byName.has('relayHandshake') && priceOf('relayHandshake') === 0n
  const pricedWhy = !byName.has('relaySend') ? 'the manifest lists no relaySend'
    : `relaySend costs ${byName.get('relaySend').priceBEM} BEM per frame; this suite does not pay (run it against a free instance of the same relay)`
  const skipPriced = (id, level, ctx) => skip(id, level, S, ctx, pricedWhy)
  // Posts one message to `room`: a 0x02 frame on a free relay, else a free handshake message (few per room).
  // 向 `room` 投递一条：免费中继用 0x02 帧，否则用免费的握手消息（每个房间只能几条）。
  let hsFlip = 0
  const postAny = async (room, ctx, { bulk } = {}) => {
    const frame = canSend ? wire(0x02, 40) : handshakeWire(hsFlip++ % 2 ? 'ready' : 'accept')
    const res = await call(canSend ? 'relaySend' : 'relayHandshake', { room, frame }, { ctx, bulk })
    return { res, frame }
  }
  const postVia = canSend ? 'relaySend' : 'relayHandshake'

  // ======================================================================================================
  // 3. A room that does not exist / 不存在的房间
  // ======================================================================================================
  {
    const U = hex(32), ctx = 'unknown-room'
    const a = await recv(U, -1, { ctx })
    if (usable(a, 'tapi26.relay.recv.unknown-room', 'MUST', ctx)) {
      const x = okResult(a)
      check(x && Array.isArray(x.frames) && x.frames.length === 0 && x.epoch === null, 'tapi26.relay.recv.unknown-room', 'MUST', `${S} (Epoch: null from relayRecv for a room that does not exist)`, ctx,
        `expected { frames: [], epoch: null }, got ${outcome(a)}`)
      check(x && x.next === -1, 'tapi26.relay.recv.next', 'MUST', `${S} (next: after unchanged when nothing was returned)`, `${ctx}:after=-1`, `next ${JSON.stringify(x?.next)} != -1`)
    }
    const b = await recv(U, 5, { ctx: `${ctx}:again` })
    if (usable(b, 'tapi26.relay.recv.no-create', 'MUST', ctx)) {
      const x = okResult(b)
      check(x && x.epoch === null && Array.isArray(x.frames) && !x.frames.length, 'tapi26.relay.recv.no-create', 'MUST', `${S} (Rooms: only a post creates a room)`, ctx, `a second relayRecv on the same unposted room got ${outcome(b)}: relayRecv created or pinned it`)
      check(x && x.next === 5, 'tapi26.relay.recv.next', 'MUST', `${S} (next: after unchanged when nothing was returned)`, `${ctx}:after=5`, `next ${JSON.stringify(x?.next)} != 5`)
    }
  }

  // ======================================================================================================
  // 4. Posting, indices, epoch, after / 投递、序号、纪元、after
  // ======================================================================================================
  const P = hex(32)
  let pEpoch, pIdx = []
  {
    const ctx = `post:${postVia}`
    const posts = []
    for (let k = 0; k < 4; k++) posts.push(await postAny(P, `${ctx}#${k}`))
    const ok = posts.every(({ res }) => !res.limited && res.env)
    if (!ok) for (const { res } of posts) usable(res, 'tapi26.relay.post.result-shape', 'MUST', ctx)
    else {
      const bad = posts.find(({ res }) => !postShapeOk(res))
      check(!bad, 'tapi26.relay.post.result-shape', 'MUST', `${S} (table: { i, epoch })`, ctx, `expected ok:true { i: integer >= 0, epoch: string }, got ${bad && outcome(bad.res)}`)
      if (!bad) {
        const res = posts.map(({ res }) => okResult(res))
        pIdx = res.map((x) => x.i); pEpoch = res[0].epoch
        check(EPOCH_RE.test(pEpoch), 'tapi26.relay.epoch.format', 'MUST', `${S} (Epoch: MUST match ^[0-9a-f]{1,32}$)`, ctx, `epoch ${JSON.stringify(pEpoch)}`)
        check(res.every((x) => x.epoch === pEpoch), 'tapi26.relay.epoch.every-method', 'MUST', `${S} (Epoch: returned from every method)`, `${ctx}:same-room`, `one room answered several epochs: ${res.map((x) => x.epoch).join(', ')}`)
        check(pIdx.every((i, k) => k === 0 || i > pIdx[k - 1]), 'tapi26.relay.index.increasing', 'MUST', `${S} (i strictly increasing within the room)`, ctx, `indices ${pIdx.join(', ')}`)
        check(pEpoch.length >= 16, 'tapi26.relay.epoch.length', 'SHOULD', `${S} (Epoch: RECOMMENDED 8 bytes)`, ctx, `epoch ${pEpoch} is ${pEpoch.length / 2} bytes`)
      }
    }
    if (pEpoch !== undefined) {
      const sent = posts.map(({ frame }, k) => ({ i: pIdx[k], frame }))
      const same = (got, want) => got.length === want.length && got.every((f, k) => f.i === want[k].i && f.frame === want[k].frame)
      const show = (fs) => fs.map((f) => `${f.i}:${f.frame.slice(0, 12)}`).join(' ')
      // after = -1, no epoch: everything, in posting order, byte-identical / 全部帧，按投递顺序，逐字节一致
      const all = await recv(P, -1, { ctx: 'recv:after=-1' })
      if (usable(all, 'tapi26.relay.recv.order', 'MUST', 'recv:after=-1')) {
        const x = okResult(all)
        const frames = Array.isArray(x?.frames) ? x.frames : []
        const idx = frames.map((f) => f.i)
        check(idx.every((i, k) => k === 0 || i > idx[k - 1]) && JSON.stringify(idx) === JSON.stringify(pIdx), 'tapi26.relay.recv.order', 'MUST', `${S} (relayRecv returns stored frames with i > after, in posting order)`, 'recv:after=-1', `posted ${pIdx.join(',')}, got ${idx.join(',')}`)
        check(same(frames, sent), 'tapi26.relay.recv.content', 'MUST', `${S} (frame is returned as posted)`, 'recv:after=-1', `posted ${show(sent)} / got ${show(frames)}`)
        check(x?.epoch === pEpoch, 'tapi26.relay.epoch.every-method', 'MUST', `${S} (Epoch: returned from every method)`, 'relayRecv', `relayRecv epoch ${JSON.stringify(x?.epoch)} != post epoch ${pEpoch}`)
        check(x?.next === pIdx[3], 'tapi26.relay.recv.next', 'MUST', `${S} (next: the last returned i)`, 'recv:after=-1', `next ${JSON.stringify(x?.next)} != last i ${pIdx[3]}`)
      }
      // after = i1 with the right epoch: only the frames after it / 正确纪元下 after = i1：只返回其后的帧
      const mid = await recv(P, pIdx[1], { epoch: pEpoch, ctx: `recv:after=${pIdx[1]}` })
      if (usable(mid, 'tapi26.relay.recv.after', 'MUST', 'recv:after=i1')) {
        const x = okResult(mid)
        check(same(Array.isArray(x?.frames) ? x.frames : [], sent.slice(2)), 'tapi26.relay.recv.after', 'MUST', `${S} (relayRecv returns the frames with i > after)`, `recv:after=${pIdx[1]}`, `expected ${show(sent.slice(2))}, got ${outcome(mid)}`)
        check(x?.next === pIdx[3], 'tapi26.relay.recv.next', 'MUST', `${S} (next: the last returned i)`, `recv:after=${pIdx[1]}`, `next ${JSON.stringify(x?.next)} != ${pIdx[3]}`)
      }
      // after = last: nothing, next unchanged / after = 最后一个：空，next 不变
      const tail = await recv(P, pIdx[3], { epoch: pEpoch, ctx: 'recv:after=last' })
      if (usable(tail, 'tapi26.relay.recv.after', 'MUST', 'recv:after=last')) {
        const x = okResult(tail)
        check(Array.isArray(x?.frames) && !x.frames.length, 'tapi26.relay.recv.after', 'MUST', `${S} (relayRecv returns the frames with i > after)`, 'recv:after=last', `expected no frames, got ${outcome(tail)}`)
        check(x?.next === pIdx[3], 'tapi26.relay.recv.next', 'MUST', `${S} (next: after unchanged when nothing was returned)`, 'recv:after=last', `next ${JSON.stringify(x?.next)} != ${pIdx[3]}`)
      }
      // A cursor from another epoch: answered as if after were -1 / 另一个纪元的游标：按 after = -1 作答
      const wrong = pEpoch === '0' ? '1' : '0'
      const stale = await recv(P, pIdx[3], { epoch: wrong, ctx: `recv:stale-epoch=${wrong}` })
      if (usable(stale, 'tapi26.relay.epoch.mismatch-resets', 'MUST', 'stale-epoch')) {
        const x = okResult(stale)
        check(same(Array.isArray(x?.frames) ? x.frames : [], sent) && x?.epoch === pEpoch, 'tapi26.relay.epoch.mismatch-resets', 'MUST', `${S} (Epoch: when the relay's epoch differs it MUST answer as if after were -1)`, `recv:after=${pIdx[3]},epoch=${wrong}`,
          `expected all ${sent.length} frames and epoch ${pEpoch}, got ${outcome(stale)}`)
      }
      // The signature binds the answer to the room and cursor asked about: it cannot be replayed for another.
      // 签名把回答绑定到所问的房间与游标：不能挪用到别处。
      if (okResult(all)) {
        const other = { ...all.params, room: hex(32) }, moved = { ...all.params, after: pIdx[0] }
        check(!verifies(all.env, all.reqId, 'relayRecv', other).ok && !verifies(all.env, all.reqId, 'relayRecv', moved).ok, 'tapi26.relay.envelope.bound', 'MUST', `${S} (a relay's claim to have delivered or not delivered a frame is signed) / TAPI-21 §3.3`, 'relayRecv',
          'the relayRecv envelope also verifies for another room or cursor')
      }
      const p0 = posts[0].res
      if (p0.env) check(!verifies(p0.env, p0.reqId, postVia, { room: P, frame: wire(0x02, 40) }).ok, 'tapi26.relay.envelope.bound', 'MUST', 'TAPI-21 §3.3', postVia, `the ${postVia} envelope also verifies for another frame`)
    }
    // A second room gets its own random epoch / 第二个房间有自己的随机纪元
    const Q = hex(32)
    const q = (await postAny(Q, 'post:second-room')).res
    const qe = okResult(q)?.epoch
    if (pEpoch === undefined || typeof qe !== 'string') skip('tapi26.relay.epoch.random', 'MUST', S, 'two-rooms', `no epochs to compare (${outcome(q)})`)
    else if (Math.min(pEpoch.length, qe.length) < 8) skip('tapi26.relay.epoch.random', 'MUST', S, 'two-rooms', `epochs shorter than 4 bytes (${pEpoch}, ${qe}) can collide by chance`)
    else check(pEpoch !== qe, 'tapi26.relay.epoch.random', 'MUST', `${S} (Epoch: a random epoch per room)`, 'two-rooms', `two new rooms got the same epoch ${qe}`)
  }

  // ======================================================================================================
  // 5. Caller errors / 调用方错误
  // ======================================================================================================
  {
    const bad = async (ctx, method, params) => {
      const res = await call(method, params, { ctx })
      if (res.limited) return skip('tapi26.relay.request.bad-params', 'SHOULD', S, ctx, 'rate limited')
      check(errCode(res) === 'BAD_REQUEST', 'tapi26.relay.request.bad-params', 'SHOULD', `${S} / TAPI-21 §3.2 (caller errors are BAD_REQUEST)`, ctx, `expected BAD_REQUEST, got ${outcome(res)}`)
    }
    await bad('recv:room-not-hex', 'relayRecv', { room: 'zz'.repeat(32), after: -1, waitMs: 0 })
    await bad('recv:after=-2', 'relayRecv', { room: hex(32), after: -2, waitMs: 0 })
    await bad('recv:waitMs=-1', 'relayRecv', { room: hex(32), after: -1, waitMs: -1 })
    await bad('recv:epoch-not-hex', 'relayRecv', { room: hex(32), after: -1, waitMs: 0, epoch: 'XYZ' })
    if (canSend) await bad('send:frame-not-base64', 'relaySend', { room: hex(32), frame: '***not base64***' })
  }

  // ======================================================================================================
  // 6. Frame size and answer size / 帧大小与回答大小
  // ======================================================================================================
  let maxWireOk = false
  if (!canSend) for (const [id, lv] of [['tapi26.relay.send.max-wire', 'SHOULD'], ['tapi26.relay.send.oversize', opts.maxFrameB64 ? 'MUST' : 'SHOULD'], ['tapi26.relay.recv.fits-cap', 'MUST']]) skipPriced(id, lv, 'size')
  else {
    const R0 = hex(32), big = wire(0x02, MAX_WIRE - 1)
    const a = await call('relaySend', { room: R0, frame: big }, { ctx: `send:${MAX_WIRE}B` })
    if (!a.limited) {
      maxWireOk = postShapeOk(a)
      check(maxWireOk, 'tapi26.relay.send.max-wire', 'SHOULD', `${S} (the frame cap holds the largest wire message, ${MAX_WIRE} bytes)`, `send:${MAX_WIRE}B=${big.length}b64`, `a ${MAX_WIRE}-byte wire message was refused: ${outcome(a)}`)
    }
    const overBytes = Math.floor(maxFrameB64 / 4) * 3 + 3
    const over = wire(0x02, overBytes - 1)
    const level = opts.maxFrameB64 ? 'MUST' : 'SHOULD'
    const o = await call('relaySend', { room: R0, frame: over }, { ctx: `send:${over.length}b64` })
    if (!o.limited) {
      check(o.env && o.env.ok === false, 'tapi26.relay.send.oversize', level, `${S} (a relay caps the size of a frame)`, `send:${over.length}b64>cap ${maxFrameB64}`,
        `a ${over.length}-character frame was not refused (${outcome(o)})${opts.maxFrameB64 ? '' : '; pass --max-frame-b64 if your cap is larger than the reference 22,000'}`)
      if (o.env?.ok === false) check(errCode(o) === 'BAD_REQUEST', 'tapi26.relay.send.oversize.code', 'SHOULD', `${S} / TAPI-21 §3.2 (a caller error)`, `send:${over.length}b64`, `refused with ${errCode(o)}, expected BAD_REQUEST`)
    }
    // A backlog above 1 MiB is handed over in pages that each fit, in order, never skipping.
    // 超过 1 MiB 的积压分页交付：每页都放得下，按顺序，不跳帧。
    if (!maxWireOk) skip('tapi26.relay.recv.fits-cap', 'MUST', S, 'backlog', `the relay refused a ${MAX_WIRE}-byte frame, so no backlog above 1 MiB can be built`)
    else {
      const R1 = hex(32), k = Math.ceil((ENVELOPE_LIMIT * 1.25) / big.length)
      const posted = []
      let epoch
      for (let j = 0; j < k; j++) {
        const f = wire(0x02, MAX_WIRE - 1)
        const res = await call('relaySend', { room: R1, frame: f }, { ctx: `backlog#${j}`, bulk: true })
        const x = okResult(res)
        if (!x) break
        epoch ??= x.epoch
        posted.push({ i: x.i, frame: f })
      }
      const ctx = `backlog:${posted.length}x${big.length}b64`
      if (posted.length < k) fail('tapi26.relay.recv.fits-cap', 'MUST', S, ctx, `could not build the backlog: only ${posted.length}/${k} frames accepted`)
      else {
        const { got, pages } = await drain(R1, epoch, 'backlog', { lastPosted: posted[posted.length - 1].i })
        const tooBig = pages.filter((p) => p.r.size > ENVELOPE_LIMIT || (p.env && p.env.ok !== true) || !p.env)
        check(!tooBig.length, 'tapi26.relay.recv.fits-cap', 'MUST', `${S} (an answer MUST fit the TAPI-21 response cap, 1 MiB)`, ctx,
          `${tooBig.length}/${pages.length} pages over 1 MiB or not ok:true; first: ${tooBig[0] ? `${tooBig[0].r.size} bytes, ${outcome(tooBig[0])}` : ''}`, `${pages.length} pages, largest ${Math.max(...pages.map((p) => p.r.size))} bytes`)
        const last = posted[posted.length - 1].i
        const reached = got.length && got[got.length - 1].i === last
        check(reached, 'tapi26.relay.recv.progress', 'MUST', `${S} (as many frames as fit, always at least one; next says where to continue)`, ctx,
          `paging stalled at ${got.length ? got[got.length - 1].i : 'nothing'} before the last posted index ${last} (a cursor that never advances kills the channel)`)
        const byI = new Map(posted.map((p) => [p.i, p.frame]))
        const idx = got.map((f) => f.i)
        const firstKept = posted.findIndex((p) => p.i === idx[0])
        const suffix = firstKept >= 0 && got.length === posted.length - firstKept && got.every((f, j) => f.i === posted[firstKept + j].i && f.frame === byI.get(f.i))
        check(suffix, 'tapi26.relay.recv.paging-order', 'MUST', `${S} (posting order; only the oldest frames MAY be dropped)`, ctx,
          `across pages got ${got.length} frames (${idx.slice(0, 6).join(',')}…) that are not an in-order suffix of the ${posted.length} posted`)
      }
    }
  }

  // ======================================================================================================
  // 7. Long-poll (all at once, so the run costs one relay cap of wall time) / 长轮询（并发执行，只花一个上限的时间）
  // ======================================================================================================
  {
    const HOLD = 1200
    const W = hex(32)
    const w0 = (await postAny(W, 'longpoll:create')).res
    const wx = okResult(w0)
    const holds = pEpoch !== undefined ? recv(P, pIdx[3], { waitMs: HOLD, epoch: pEpoch, ctx: `longpoll:waitMs=${HOLD}` }) : null
    const fullTail = pEpoch !== undefined ? recv(P, pIdx[3], { waitMs: fullWaitMs, epoch: pEpoch, ctx: `longpoll:full:waitMs=${fullWaitMs}`, timeoutMs: pollTimeoutMs }) : null
    const fullNone = recv(hex(32), -1, { waitMs: fullWaitMs, ctx: `longpoll:full-unknown:waitMs=${fullWaitMs}`, timeoutMs: pollTimeoutMs })
    let wake = null, postedAt = 0, wakeFrame
    if (wx) {
      const t0 = Date.now()
      const pending = recv(W, wx.i, { waitMs: 5000, epoch: wx.epoch, ctx: 'longpoll:wake' }).then((res) => ({ res, at: Date.now() }))
      await sleep(300)
      postedAt = Date.now()
      const p = await postAny(W, 'longpoll:wake-post')
      wakeFrame = p.frame
      wake = { ...(await pending), t0 }
    }
    if (holds) {
      const h = await holds
      if (usable(h, 'tapi26.relay.longpoll.bounded', 'MUST', 'longpoll')) {
        const x = okResult(h)
        check(x && Array.isArray(x.frames) && !x.frames.length && h.ms <= HOLD + slackMs, 'tapi26.relay.longpoll.bounded', 'MUST', `${S} (MAY hold the request for up to waitMs)`, `longpoll:waitMs=${HOLD}`,
          `an empty poll with waitMs ${HOLD} answered after ${h.ms} ms: ${outcome(h)}`)
        check(h.ms >= HOLD - 300, 'tapi26.relay.longpoll.holds', 'SHOULD', `${S} (MAY hold for up to waitMs; TAPI-26 §4 long-poll)`, `longpoll:waitMs=${HOLD}`,
          `answered an empty poll after ${h.ms} ms: the relay does not hold polls (or caps waitMs below ${HOLD} ms), so peers busy-poll`)
      }
    } else skip('tapi26.relay.longpoll.bounded', 'MUST', S, 'longpoll', 'no room to poll (posting failed above)')
    if (!wake) skip('tapi26.relay.longpoll.wakes', 'SHOULD', S, 'longpoll:wake', `could not create a room: ${outcome(w0)}`)
    else if (wake.res.limited) skip('tapi26.relay.longpoll.wakes', 'SHOULD', S, 'longpoll:wake', 'rate limited')
    else {
      const x = okResult(wake.res)
      const got = Array.isArray(x?.frames) ? x.frames : []
      if (wake.at < postedAt && !got.length) skip('tapi26.relay.longpoll.wakes', 'SHOULD', S, 'longpoll:wake', `the poll returned empty after ${wake.at - wake.t0} ms, before a frame was posted: the relay does not hold polls`)
      else check(got.some((f) => f.frame === wakeFrame) && wake.at - postedAt <= slackMs, 'tapi26.relay.longpoll.wakes', 'SHOULD', `${S} (answer as soon as one arrives)`, 'longpoll:wake',
        `a poll waiting 5000 ms answered ${wake.at - postedAt} ms after a frame was posted, with ${got.length} frame(s): ${outcome(wake.res)}`, `woke ${wake.at - postedAt} ms after the post`)
    }
    for (const [pr, ctx] of [[fullTail, 'longpoll:full:existing-room'], [fullNone, 'longpoll:full:unknown-room']]) {
      if (!pr) { skip('tapi26.relay.longpoll.full-length', 'MUST', S, ctx, 'no room to poll'); continue }
      const f = await pr
      if (f.limited) { skip('tapi26.relay.longpoll.full-length', 'MUST', S, ctx, 'rate limited'); continue }
      const x = okResult(f)
      check(!!x && Array.isArray(x.frames) && !x.frames.length, 'tapi26.relay.longpoll.full-length', 'MUST', `${S} (a relay caps waitMs below its own response deadline, or a full-length poll is answered with INTERNAL instead of an empty result)`, `${ctx}:waitMs=${fullWaitMs}`,
        `a poll asking for ${fullWaitMs} ms got, after ${f.ms} ms: ${outcome(f)}`, `empty answer after ${f.ms} ms (the relay's effective cap)`)
    }
  }

  // ======================================================================================================
  // 8. relayHandshake: the free path carries 0x01 accept / ready only / 免费握手通道只承载 0x01 accept / ready
  // ======================================================================================================
  if (!canHandshake) {
    for (const id of ['tapi26.relay.handshake.accept', 'tapi26.relay.handshake.refuse-other']) skip(id, 'MUST', S, 'handshake', byName.has('relayHandshake') ? 'relayHandshake is priced (see tapi26.relay.manifest.handshake-free)' : 'the manifest lists no relayHandshake')
  } else {
    const Hs = hex(32)
    const acc = await call('relayHandshake', { room: Hs, frame: handshakeWire('accept') }, { ctx: 'handshake:accept' })
    const rdy = await call('relayHandshake', { room: Hs, frame: handshakeWire('ready') }, { ctx: 'handshake:ready' })
    for (const [res, t] of [[acc, 'accept'], [rdy, 'ready']]) {
      if (!usable(res, 'tapi26.relay.handshake.accept', 'MUST', `handshake:${t}`)) continue
      const x = okResult(res)
      check(postShapeOk(res) && EPOCH_RE.test(x.epoch), 'tapi26.relay.handshake.accept', 'MUST', `${S} (relayHandshake carries 0x01 + { t: accept | ready }, result { i, epoch })`, `handshake:${t}`, `refused or malformed: ${outcome(res)}`)
    }
    if (sendPrice > 0n && okResult(acc)) pass('tapi26.relay.handshake.no-payment', 'MUST', `${S} (a priced relay MUST carry the handshake for free)`, 'handshake:accept', 'accepted without a voucher')
    else if (sendPrice > 0n) fail('tapi26.relay.handshake.no-payment', 'MUST', `${S} (a priced relay MUST carry the handshake for free)`, 'handshake:accept', `a priced relay refused a free handshake message: ${outcome(acc)}`)
    const ax = okResult(acc), rx = okResult(rdy)
    if (ax && rx) {
      check(ax.epoch === rx.epoch && rx.i > ax.i, 'tapi26.relay.index.increasing', 'MUST', `${S} (i strictly increasing; epoch returned from every method)`, 'handshake', `accept ${ax.i}/${ax.epoch}, ready ${rx.i}/${rx.epoch}`)
      const back = await recv(Hs, -1, { ctx: 'handshake:recv' })
      const bx = okResult(back)
      check(bx?.epoch === ax.epoch, 'tapi26.relay.epoch.every-method', 'MUST', `${S} (Epoch: returned from every method)`, 'relayHandshake/relayRecv', `relayRecv epoch ${JSON.stringify(bx?.epoch)} != relayHandshake epoch ${ax.epoch}`)
    }
    // Anything but 0x01 + { t: accept | ready } is refused / 其余一律拒绝
    const others = [
      ['wire 0x02', wire(0x02, 40)],
      ['wire 0x03', wire(0x03, 200)],
      ['wire 0x04', wire(0x04, 100)],
      ['0x01 t:hello', b64(Buffer.concat([Buffer.of(1), Buffer.from(JSON.stringify({ t: 'hello', cid: hex(16) }))]))],
      ['0x01 non-JSON', b64(Buffer.concat([Buffer.of(1), Buffer.from('accept, honest')]))],
      ['0x01 JSON array', b64(Buffer.concat([Buffer.of(1), Buffer.from(JSON.stringify(['accept']))]))],
      ['0x01 bad UTF-8', b64(Buffer.concat([Buffer.of(1), Buffer.from('{"t":"accept","x":"'), Buffer.of(0xff, 0xfe), Buffer.from('"}')]))],
    ]
    for (const [what, frame] of others) {
      const ctx = `handshake:refuse:${what}`
      const res = await call('relayHandshake', { room: hex(32), frame }, { ctx })
      if (!usable(res, 'tapi26.relay.handshake.refuse-other', 'MUST', ctx)) continue
      check(res.env.ok === false, 'tapi26.relay.handshake.refuse-other', 'MUST', `${S} (relayHandshake MUST decode to 0x01 + { t: accept | ready }; the relay refuses anything else)`, ctx, `accepted: ${outcome(res)}`)
      if (res.env.ok === false) check(errCode(res) === 'BAD_REQUEST', 'tapi26.relay.handshake.refuse-code', 'SHOULD', `${S} / TAPI-21 §3.2 (a caller error)`, ctx, `refused with ${errCode(res)}, expected BAD_REQUEST`)
    }
    // A handshake message is small / 握手消息很小
    {
      const padded = handshakeWire('accept', { pad: 'x'.repeat(Math.ceil(handshakeB64 * 0.75)) })
      const level = opts.handshakeB64 ? 'MUST' : 'SHOULD'
      const ctx = `handshake:${padded.length}b64>cap ${handshakeB64}`
      const res = await call('relayHandshake', { room: hex(32), frame: padded }, { ctx })
      if (usable(res, 'tapi26.relay.handshake.size', level, ctx)) check(res.env.ok === false, 'tapi26.relay.handshake.size', level, `${S} (the relayHandshake frame is small)`, ctx,
        `a ${padded.length}-character handshake message was accepted${opts.handshakeB64 ? '' : '; pass --handshake-b64 if your cap is larger than the reference 2,048'}`)
    }
    // Per-room limit (MAY); when present it is a caller error / 每房间上限（MAY）；有则为调用方错误
    {
      const HL = hex(32), ctx = 'handshake:per-room'
      let n = 0, refused = null
      for (; n < 32; n++) {
        const res = await call('relayHandshake', { room: HL, frame: handshakeWire(n % 2 ? 'ready' : 'accept') }, { ctx: `${ctx}#${n}`, bulk: true })
        if (res.limited || !res.env) break
        if (res.env.ok === false) { refused = res; break }
      }
      if (!refused) skip('tapi26.relay.handshake.room-limit', 'SHOULD', S, ctx, `no per-room limit within ${n} handshake messages (a relay MAY refuse more than N)`)
      else check(errCode(refused) === 'BAD_REQUEST', 'tapi26.relay.handshake.room-limit', 'SHOULD', `${S} (MAY refuse more than N per room) / TAPI-21 §3.2`, ctx, `message ${n + 1} refused with ${errCode(refused)}, expected BAD_REQUEST`, `refused after ${n}`)
    }
  }

  // ======================================================================================================
  // 9. Invites and epoch messages are kept apart (arch B2) / 邀请与纪元消息单独保存
  // ======================================================================================================
  if (!canSend) for (const [id, lv] of [['tapi26.relay.kept.survives-flood', 'MUST'], ['tapi26.relay.kept.order', 'MUST'], ['tapi26.relay.kept.source-cap', 'SHOULD']]) skipPriced(id, lv, 'kept')
  else {
    const K = hex(32), ctx = `kept:flood=${roomFrames + 44}`
    const posted = []
    const put = async (frame, c, bulk) => {
      const res = await call('relaySend', { room: K, frame }, { ctx: c, bulk })
      const x = okResult(res)
      if (x) posted.push({ i: x.i, frame, type: typeOf(frame), epoch: x.epoch })
      return x
    }
    await put(wire(0x02, 30), 'kept:before', false)
    const inv = await put(wire(0x03, 400), 'kept:0x03', false)
    const epm = await put(wire(0x04, 200), 'kept:0x04', false)
    for (let j = 0; j < roomFrames + 44; j++) if (!(await put(wire(j % 2 ? 0x05 : 0x02, 30), `kept:flood#${j}`, true))) break
    if (!inv || !epm || posted.length < roomFrames + 47) {
      fail('tapi26.relay.kept.survives-flood', 'MUST', S, ctx, `could not post the flood: ${posted.length}/${roomFrames + 47} accepted (invite ${!!inv}, epoch message ${!!epm})`)
    } else {
      const { got } = await drain(K, posted[0].epoch, 'kept', { lastPosted: posted[posted.length - 1].i })
      const byI = new Map(posted.map((p) => [p.i, p]))
      const flood = posted.filter((p) => p.type === 0x02 || p.type === 0x05)
      const floodBack = got.filter((f) => byI.get(f.i) && (byI.get(f.i).type === 0x02 || byI.get(f.i).type === 0x05)).length
      const keptBack = ['0x03', '0x04'].map((t, j) => [t, [inv, epm][j]]).filter(([, x]) => got.some((f) => f.i === x.i && f.frame === byI.get(x.i).frame))
      const idx = got.map((f) => f.i)
      check(idx.every((i, j) => (j === 0 || i > idx[j - 1]) && byI.get(i)?.frame === got[j].frame), 'tapi26.relay.kept.order', 'MUST', `${S} (relayRecv MUST still return messages of every type in posting order under one index sequence)`, ctx,
        `drained indices are not increasing or do not match what was posted: ${idx.slice(0, 8).join(',')}…`)
      if (floodBack === flood.length) skip('tapi26.relay.kept.survives-flood', 'MUST', S, ctx, `no frame was evicted (all ${flood.length} came back), so the protected ring was not exercised; pass --room-frames with your per-room frame bound`)
      else check(keptBack.length === 2, 'tapi26.relay.kept.survives-flood', 'MUST', `${S} (a relay MUST hold 0x03 and 0x04 under a bound of their own that 0x02 / 0x05 cannot evict)`, ctx,
        `after ${flood.length - floodBack} frames were evicted, missing: ${['0x03', '0x04'].filter((t) => !keptBack.some(([k]) => k === t)).join(', ')}`, `${flood.length - floodBack} frames evicted, invite and epoch message kept`)
    }
    // Per source per room: further 0x03 / 0x04 refused as BAD_REQUEST (SHOULD) / 每来源每房间上限
    const Sx = hex(32), sctx = 'kept:per-source'
    let n = 0, refused = null
    for (; n < 65; n++) {
      const res = await call('relaySend', { room: Sx, frame: wire(0x03, 300) }, { ctx: `${sctx}#${n}`, bulk: true })
      if (res.limited || !res.env) break
      if (res.env.ok === false) { refused = res; break }
    }
    if (!refused) fail('tapi26.relay.kept.source-cap', 'SHOULD', `${S} (SHOULD cap 0x03 / 0x04 posts per room per source)`, sctx, `${n} sealed invites from one source were all accepted`)
    else check(errCode(refused) === 'BAD_REQUEST', 'tapi26.relay.kept.source-cap', 'SHOULD', `${S} (refuse further ones as a caller error, BAD_REQUEST)`, sctx, `invite ${n + 1} refused with ${errCode(refused)}: ${outcome(refused)}`, `refused after ${n}`)
  }

  // ======================================================================================================
  // 10. Rate limiting: every 429 seen, plus an optional burst (last) / 限流：所有见到的 429，外加可选突发（最后）
  // ======================================================================================================
  if (opts.checkRateLimit) {
    H.setRatePhase(true)
    const n = Number(opts.checkRateLimit) + 5, room = hex(32)
    const rs = await Promise.all(Array.from({ length: n }, (_, i) => post('relayRecv', { id: `relay-rl-${i}`, method: 'relayRecv', params: { room, after: -1, waitMs: 0 } })))
    seen429.push(...rs.filter((r) => r.status === 429))
    H.setRatePhase(false)
  }
  if (seen429.length) H.checkRateLimited(seen429, `observed:${seen429.length}x429`)
  else for (const id of ['tapi21.ratelimit.unsigned', 'tapi21.ratelimit.retry-after', 'tapi21.ratelimit.code']) skip(id, 'MUST', 'TAPI-21 §3.4', 'observed', `no 429 seen${opts.checkRateLimit ? ` within ${Number(opts.checkRateLimit) + 5} rapid calls` : ' (pass --check-rate-limit N to provoke one)'} (rate limiting is MAY)`)

  return finish()

  function finish() {
    for (const [id, a] of agg) {
      if (a.fails) fail(id, a.level, a.spec, `bulk:${a.n}`, `${a.fails}/${a.n} failed; first ${a.first}`)
      else pass(id, a.level, a.spec, `bulk:${a.n}`)
    }
    H.checkSizeCap()
    return { results, summary: summarize(results, opts.strict) }
  }
}

// ---- CLI ----
const USAGE = `usage: node conformance/relay.mjs --url http://host:port [options]
  --manifest path.json        trusted manifest (resolved on-chain); default: the served /.well-known/tapeapi.json
  --live URL                  live base (default <url>/tapeapi/v1)
  --max-frame-b64 N           your relay's frame cap in base64 characters (makes the oversize check a MUST; default: reference 22000, SHOULD)
  --handshake-b64 N           your relayHandshake frame cap (makes its check a MUST; default: reference 2048, SHOULD)
  --room-frames N             your per-room frame bound, so the flood that must not evict 0x03 / 0x04 is large enough (default 256)
  --full-wait-ms MS           waitMs of the full-length poll (default 60000)   --poll-timeout-ms MS  its client deadline (default 90000)
  --check-rate-limit N        send N+5 rapid relayRecv calls and check any 429 (run against a quiet instance)
  --slack-ms MS               how late a long-poll answer may be (default 2000)
  --max-retry-wait S          longest Retry-After the suite waits out before giving up on a call (default 120)
  --max-skew S                ts window (default 300)       --timeout-ms MS  per request (default 30000)
  --junit out.xml             write JUnit XML               --json out.json  write raw results
  --strict                    SHOULD failures also fail the run     --quiet  print only non-passing checks`

async function main() {
  let a
  try { a = parseArgs(process.argv.slice(2)) } catch (e) { console.error(e.message + '\n' + USAGE); process.exit(2) }
  if (a.help || !a.url) { console.error(USAGE); process.exit(a.help ? 0 : 2) }
  let out
  try {
    out = await runRelaySuite({
      url: a.url, live: a.live, manifest: a.manifest ? safeParseJSON(readFileSync(a.manifest, 'utf8')) : undefined,
      maxFrameB64: a.maxFrameB64, handshakeB64: a.handshakeB64, roomFrames: a.roomFrames, fullWaitMs: a.fullWaitMs, pollTimeoutMs: a.pollTimeoutMs,
      slackMs: a.slackMs ? Number(a.slackMs) : undefined, maxRetryWaitS: a.maxRetryWait, checkRateLimit: a.checkRateLimit ? Number(a.checkRateLimit) : 0,
      maxSkewS: a.maxSkew ? Number(a.maxSkew) : undefined, timeoutMs: a.timeoutMs ? Number(a.timeoutMs) : undefined, strict: !!a.strict,
    })
  } catch (e) { console.error(`configuration error: ${e.message}`); process.exit(2) }
  console.log(formatText(out.results, out.summary, { verbose: !a.quiet }))
  if (a.junit) writeFileSync(a.junit, formatJUnit(out.results, out.summary, { strict: !!a.strict, name: 'tapeapi-relay-conformance' }))
  if (a.json) writeFileSync(a.json, JSON.stringify(out, null, 2))
  process.exit(out.summary.conformant ? 0 : 1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
