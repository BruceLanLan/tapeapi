// Runs the spec vectors and a live TAP-26 handshake inside a real browser, against the unbundled SDK source.
// 在真实浏览器里、对未打包的 SDK 源码运行规范向量与一次真实的 TAP-26 握手。
import { canonicalJSON, safeParseJSON } from '/sdk/src/index.js'
import * as channel from '/sdk/src/channel.js'   // the implementation module (toHex, fromHex) / 实现模块
import { responseDigest, personalDigest, signDigest, recoverAddress, privateKeyToAddress } from '/sdk/src/sig.js'
import { toHex } from '/sdk/src/abi.js'

const results = { ok: true, checks: 0, failures: [], env: navigator.userAgent, webcrypto: !!globalThis.crypto?.getRandomValues }
const check = (name, got, want) => { results.checks++; if (got !== want) { results.ok = false; results.failures.push({ name, got: String(got).slice(0, 80), want: String(want).slice(0, 80) }) } }
const load = async (n) => (await fetch(`/spec/vectors/${n}`)).json()
try {
  const canon = await load('tap-21-canon.json')
  for (const c of canon.positive) check(`canon: ${c.name}`, canonicalJSON(c.input), c.canonical)
  for (const c of canon.negative.filter((x) => x.text)) {
    let threw = false; try { safeParseJSON(c.text) } catch (e) { threw = e.code === c.expect }
    check(`canon-neg: ${c.name}`, threw, true)
  }
  const env = await load('tap-21-envelope.json')
  check('signer address', privateKeyToAddress(env.signerKey), env.signerAddress)
  for (const c of env.cases) {
    const d = responseDigest({ container: env.container, id: c.id, method: c.method, params: c.params, ok: c.ok, body: c.body, ts: c.ts })
    check(`envelope digest: ${c.name}`, toHex(d), c.digest)
    // EIP-191 personal_sign over the digest (TAP-21 §3.3), as the vectors are signed since 0.5.0. / 自 0.5.0 起向量按 EIP-191 签名。
    const pd = personalDigest(d)
    check(`envelope personal digest: ${c.name}`, toHex(pd), c.personalDigest)
    check(`envelope sig: ${c.name}`, signDigest(pd, env.signerKey), c.sig)
    check(`envelope recover: ${c.name}`, recoverAddress(pd, c.sig).toLowerCase(), c.recoversTo.toLowerCase())
  }
  const v = await load('tap-26-channel.json')
  const hx = channel.fromHex
  const replay = (...chunks) => { let i = 0; return () => chunks[i++] }
  const A = { container: v.initiator.container, chainId: 56 }, B = { container: v.responder.container, chainId: 56 }
  const { invite, pending } = channel.createInvite({ self: { ...A, staticSecret: hx(v.initiator.staticSecret) }, peer: { ...B, staticPublic: v.responder.staticPublic }, relays: v.invite.relays, ttlS: v.invite.exp - 1789000000, now: 1789000000, random: replay(hx(v.invite.cid), hx(v.initiator.ephemeralSecret)) })
  const { accept, session: bob } = channel.acceptInvite({ self: { ...B, staticSecret: hx(v.responder.staticSecret) }, peer: { ...A, staticPublic: v.initiator.staticPublic }, invite, now: 1789000000, random: replay(hx(v.responder.ephemeralSecret)) })
  check('tap26 accept.confirm', accept.confirm, v.accept.confirm)
  const { ready, session: alice } = channel.completeInvite(pending, accept, { now: 1789000000 })
  check('tap26 ready.confirm', ready.confirm, v.ready.confirm)
  bob.confirm(ready, { now: 1789000000 })
  for (const f of v.frames) {
    const [from, to] = f.from === 'initiator' ? [alice, bob] : [bob, alice]
    check(`tap26 frame ${JSON.stringify(f.plaintext)}`, channel.toHex(from.seal(f.plaintext)), f.frame)
    check(`tap26 open ${JSON.stringify(f.plaintext)}`, to.open(hx(f.frame), { text: true }).data, f.plaintext)
  }
  // A live handshake with fresh keys from the browser's own CSPRNG / 用浏览器自己的安全随机数做一次真实握手
  const ka = channel.generateKeyPair(), kb = channel.generateKeyPair()
  const i2 = channel.createInvite({ self: { ...A, staticSecret: ka.secretKey }, peer: { ...B, staticPublic: kb.publicKey } })
  const a2 = channel.acceptInvite({ self: { ...B, staticSecret: kb.secretKey }, peer: { ...A, staticPublic: ka.publicKey }, invite: i2.invite })
  const c2 = channel.completeInvite(i2.pending, a2.accept)
  a2.session.confirm(c2.ready)
  check('live handshake transcripts agree', c2.session.transcript, a2.session.transcript)
  check('live frame round-trip', a2.session.open(c2.session.seal('hello from a browser'), { text: true }).data, 'hello from a browser')
  const t0 = performance.now(); for (let i = 0; i < 2000; i++) a2.session.open(c2.session.seal(new Uint8Array(1024)))
  results.frames1KiBPerSec = Math.round(2000 / ((performance.now() - t0) / 1000))
} catch (e) { results.ok = false; results.failures.push({ name: 'exception', got: String(e && e.stack || e).slice(0, 300) }) }

// Every site page with a script loads without an uncaught error at load (review P2-F12, after RC-1 left "My services"
// dead on load). A page with a module script: probe.mjs re-imports that script inside the page, which rejects with the
// page's own evaluation error. The status page (a classic script): its cards are drawn. scripts/dashboard.test.mjs
// checks that this list names every page with a module script. The pages may start reading the chain; only loading is
// checked. / 每个带脚本的站点页面加载时都没有未捕获的错误（RC-1 曾让“我的服务”整页失效）。
const PAGES = ['dashboard', 'playground', 'verify', 'console', 'status']
const frameOf = (page) => new Promise((ok, fail) => {
  const f = document.createElement('iframe')
  f.style.cssText = 'width:800px;height:600px;position:absolute;left:-10000px'
  const t = setTimeout(() => fail(new Error('the page did not load in 30 s')), 30_000)
  f.onload = () => { clearTimeout(t); ok(f) }
  f.src = `/site/${page}/`
  document.body.appendChild(f)
})
const probe = (f) => new Promise((ok) => {
  const t = setTimeout(() => ok({ ok: false, error: 'the page script did not settle in 30 s' }), 30_000)
  addEventListener('message', function on(ev) {
    if (ev.source !== f.contentWindow || !ev.data || !('smokeProbe' in ev.data)) return
    removeEventListener('message', on); clearTimeout(t); ok(ev.data)
  })
  const s = f.contentDocument.createElement('script')
  s.type = 'module'; s.src = '/scripts/browser-smoke/probe.mjs'
  f.contentDocument.head.appendChild(s)
})
for (const page of PAGES) {
  try {
    const f = await frameOf(page)
    if (page === 'status') { check('page status: cards drawn', f.contentDocument.querySelectorAll('#cards > *').length, 2); continue }
    const r = await probe(f)
    check(`page ${page}: its module script loads`, r.ok ? 'ok' : r.error, 'ok')
  } catch (e) { check(`page ${page}: loads`, String(e && e.message || e), 'ok') }
}
window.__smoke = results
document.getElementById('out').textContent = JSON.stringify(results, null, 2)
document.title = results.ok ? `PASS ${results.checks}` : `FAIL ${results.failures.length}/${results.checks}`
