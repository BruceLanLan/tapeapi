// The receipt checker (site/verify/, tapeapi.fun/verify/). Offline: it reads a receipt in every form the MCP tools hand
// out, refuses malformed or oversized input, reaches the right verdict for receipts signed here with the SDK's own
// helpers (valid, another key, tampered, wrong container, bad signature, chain unreadable), and the page itself runs
// no inline script but its hashed import map, uses only ids that exist, is bilingual, and loads nothing from elsewhere.
// 回执核验页。离线检查：能读出 MCP 工具给出的每种形式；拒绝格式错误或过大的输入；对用 SDK 自己的函数签出的回执得出正确结论
// （有效、别的密钥、被改动、容器不符、签名坏、读不到链）；页面除按哈希放行的 import map 外没有内联脚本，只用存在的 id，
// 中英成对，不从别处加载任何东西。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, posix } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { importsOf } from './build-playground.mjs'
import {
  extractReceipt, parseReceipt, readReceipt, envelopeOf, signedBlock, nameClaim, checkName, verdictOf, verifyReceipt,
  utc, ReceiptError, MAX_INPUT, RECEIPT_META_KEY,
} from '../site/verify/lib.js'
import { T } from '../site/verify/strings.js'
import { signResponse, recoverResponseSigner, randomPrivateKey, privateKeyToAddress } from '../sdk/src/sig.js'
import { receiptOf, toolResultOf, verifyLink, toBase64Url, hashReceipt } from '../sdk/src/mcp.js'
import { recoverResponseSignerFromHashes } from '../sdk/src/sig.js'
import { TapeAPIError } from '../sdk/src/errors.js'
import { readAny, parseUsageReceipt, usageEnvelopeOf, verifyUsage, isUsageShape } from '../site/verify/lib.js'
import { encodeReceipt, receiptComment } from '../sdk/src/ai.js'
import { createAIProxy } from '../server/src/ai-proxy.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SITE = join(ROOT, 'site')
const read = (p) => readFileSync(join(SITE, p), 'utf8')
const html = read('verify/index.html')
const js = read('verify/verify.js')
const lib = read('verify/lib.js')
const strings = read('verify/strings.js')
const boot = read('verify/boot.js')
const css = read('verify/verify.css')

// A real receipt from https://api.tapeapi.fun/mcp (tools/call bnbUsd, 2026-09-27), signed by the public service's key.
// 公共服务真实签出的回执。
const LIVE_SIGNER = '0xaB70dEe8e1CEabb1D10eDFeBcbe0c313c53cf154'
const LIVE = { v: 1, service: { circuits: '0xe02c26c7432A7121168AA9B610DE24eCf9a1a414', tokenId: '11', container: '0x1b2A657BcBa9D3229f57aC2f4FcbEE2AA756aAe8', name: '11.1013.tape' }, method: 'bnbUsd', params: {}, id: 'mcp-muk3u8vw-0', ts: 1790530855, ok: true, result: { bnbUsd: '776.211275170221302263', pair: '0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE', blockPinned: { blockNumber: 124374470, blockHash: '0x31475c05c5cb0b05c3ab9c274599fdab1e84888b0799ba7b40762e4a7131f693', blockRef: 'hash' } }, block: 124374471, sig: '0xcc24987edf206dac1b402c98a4d7d7f71bd129316a80cc2099c9fe5929ab919e2379427af148ca700a1954935a228ca914b1ecfaa04c4217f031ff23b579e8231c' }
const LIVE_REFUSAL = { v: 1, service: { circuits: '0xe02c26c7432A7121168AA9B610DE24eCf9a1a414', tokenId: '11', container: '0x1b2A657BcBa9D3229f57aC2f4FcbEE2AA756aAe8', name: '11.1013.tape' }, method: 'balance', params: { address: '0xnotanaddress' }, id: 'mcp-muk3uarx-0', ts: 1790530856, ok: false, error: { code: 'BAD_REQUEST', message: 'address must be a 0x address of 40 hex digits' }, block: 124374476, sig: '0x1e504f1f9bdc5899fa9ae4eeda97463ad3435faf0c01e0611b8fdc88039cbb9950d33969ac678364f40898a948bc00d3d166f3dfa93d2c47a27a13ff8d2bc9561c' }

// ── a service and receipts made here / 在这里造出的服务与回执 ─────────────────────────────────────────────────────
const NOW = 1_800_000_000
const CIRCUITS = '0xe02c26c7432A7121168AA9B610DE24eCf9a1a414'
const CONTAINER = '0x1b2A657BcBa9D3229f57aC2f4FcbEE2AA756aAe8'
const OTHER_CONTAINER = '0x2222222222222222222222222222222222222222'
const HOLDER = '0x086bFB1908B1DF8C0c4412f28E4DD22Bdd52d715'
const KEY = randomPrivateKey()
const SIGNER = privateKeyToAddress(KEY)
const OLD_KEY = randomPrivateKey()

function makeReceipt({ key = KEY, container = CONTAINER, method = 'bnbUsd', params = {}, ok = true, result = { bnbUsd: '600.1', blockPinned: { blockNumber: 99, blockHash: '0x' + 'ab'.repeat(32), blockRef: 'hash' } }, error = { code: 'BAD_REQUEST', message: 'no' }, ts = NOW - 60, name = '11.1013.tape', id = 'mcp-test-0' } = {}) {
  const body = ok ? result : error
  const env = { container, id, ts, ok, ...(ok ? { result } : { error }), block: 101 }
  env.sig = signResponse({ container, id, method, params, ok, body, ts }, key)
  return receiptOf({ envelope: env, method, params, circuits: CIRCUITS, tokenId: '11', name: name ?? undefined })   // name: null for none / null 表示没有名字
}
function service({ signer = SIGNER, container = CONTAINER, expires = NOW + 86_400 } = {}) {
  return { container, manifest: { name: 'TapeAPI Public', circuits: CIRCUITS, tokenId: '11', container, signer, delegation: { expires, sig: '0x' } }, verified: { delegation: true, holder: HOLDER } }
}
const io = (over = {}) => ({
  recover: recoverResponseSigner,
  resolve: async (target) => { assert.deepEqual(target, { circuits: CIRCUITS, tokenId: '11' }, 'resolved from the receipt\'s circuits and #ID'); return service() },
  cpuAt: async (p) => { if (p === '1013') return CIRCUITS; throw new TapeAPIError('NOT_FOUND', `processor ${p} does not exist`) },
  now: NOW,
  ...over,
})
const check = (r, over) => verifyReceipt(parseReceipt(r), io(over))
const stateOf = (out, id) => out.checks.find((c) => c.id === id).state

// ── reading every form / 读出每种形式 ──────────────────────────────────────────────────────────────────────────
test('verify: every form of the same receipt reads to the same thing', () => {
  const r = makeReceipt()
  const b64 = toBase64Url(JSON.stringify(r))
  const tool = toolResultOf({ receipt: r, checkedBy: 'service', signer: SIGNER })
  const rpc = { jsonrpc: '2.0', id: 1, result: tool }
  const forms = {
    link: verifyLink(r, undefined, { content: true }),
    localLink: `http://localhost:8765/verify/#r=${b64}`,
    fragment: `#r=${b64}`,
    bare: `r=${b64}`,
    base64url: b64,
    padded: `\n  ${b64}  \n`,
    receiptJson: JSON.stringify(r, null, 2),
    toolResult: JSON.stringify(tool),
    jsonRpc: JSON.stringify(rpc),
    noteWithDot: `See ${verifyLink(r, undefined, { content: true })}.`,
  }
  const want = parseReceipt(r)
  for (const [name, text] of Object.entries(forms)) assert.deepEqual(readReceipt(text), want, name)
  assert.deepEqual(readReceipt(verifyLink(LIVE, undefined, { content: true })), LIVE, 'the live content link reads to the live receipt')
  // The default link, and the note the model quotes, carry the hash-only form. / 默认链接与模型引用的说明行带只有哈希的形态。
  const hashed = parseReceipt(hashReceipt(r))
  for (const [name, text] of Object.entries({ link: verifyLink(r), note: tool.content[1].text, noteWithDot: `See ${verifyLink(r)}.` })) assert.deepEqual(readReceipt(text), hashed, name)
  assert.deepEqual(readReceipt(verifyLink(LIVE)), hashReceipt(LIVE), 'the live default link reads to its hash-only form')
})

test('verify: a hash-only receipt (v 2, the default link) carries no params or result, and the live one still recovers to the public service\'s key', async () => {
  const h = readReceipt(verifyLink(LIVE))
  assert.equal(h.v, 2)
  assert.deepEqual(Object.keys(h), ['v', 'service', 'method', 'requestHash', 'id', 'ts', 'ok', 'bodyHash', 'block', 'sig'])
  const text = JSON.stringify(h)
  assert.ok(!text.includes('776.211275170221302263') && !text.includes('blockPinned'), 'the result is not in it')
  assert.equal(recoverResponseSignerFromHashes({ container: h.service.container, id: h.id, requestHash: h.requestHash, ok: h.ok, bodyHash: h.bodyHash, ts: h.ts }, h.sig), LIVE_SIGNER)
  const refusal = readReceipt(verifyLink(LIVE_REFUSAL))
  assert.ok(!JSON.stringify(refusal).includes('0xnotanaddress') && !JSON.stringify(refusal).includes('must be a 0x address'), 'params and refusal hidden too')
  assert.equal(recoverResponseSignerFromHashes({ container: refusal.service.container, id: refusal.id, requestHash: refusal.requestHash, ok: refusal.ok, bodyHash: refusal.bodyHash, ts: refusal.ts }, refusal.sig), LIVE_SIGNER)
  // The whole check, as the page runs it. / 页面上的完整核对。
  const r = makeReceipt()
  const out = await verifyReceipt(parseReceipt(hashReceipt(r)), io({ recoverHashed: recoverResponseSignerFromHashes }))
  assert.equal(out.verdict, 'valid'); assert.equal(out.recovered, SIGNER)
  assert.equal(signedBlock(parseReceipt(hashReceipt(r))), null, 'the signed block is inside the result, which is not there')
  // Tampering with either hash, the id or the time recovers another key. / 改动任何一个哈希、id 或时间，恢复出的都是别的密钥。
  for (const k of ['requestHash', 'bodyHash']) {
    const bad = { ...hashReceipt(r), [k]: '0x' + '00'.repeat(32) }
    assert.equal((await verifyReceipt(parseReceipt(bad), io({ recoverHashed: recoverResponseSignerFromHashes }))).verdict, 'other-key', k)
  }
  assert.equal((await verifyReceipt(parseReceipt({ ...hashReceipt(r), ts: r.ts + 1 }), io({ recoverHashed: recoverResponseSignerFromHashes }))).verdict, 'other-key')
  // Without the hash recovery the page cannot check it, and says the signature failed rather than guessing.
  // 没有按哈希恢复的函数就无法核对，结论是签名不成立而不是猜测。
  assert.equal((await verifyReceipt(parseReceipt(hashReceipt(r)), io())).failed, 'sig')
  // Shape: both hashes are required, lowercase 0x-hex; a v 2 receipt carrying params is read without them.
  // 结构：两个哈希都必须有，且为小写 0x 十六进制；带 params 的 v 2 回执读出时不含它。
  const code = (x) => { try { parseReceipt(x); return 'ok' } catch (e) { return e.field } }
  assert.equal(code({ ...hashReceipt(r), requestHash: undefined }), 'requestHash')
  assert.equal(code({ ...hashReceipt(r), bodyHash: hashReceipt(r).bodyHash.toUpperCase() }), 'bodyHash')
  assert.equal(parseReceipt({ ...hashReceipt(r), params: { secret: 1 }, result: { secret: 2 } }).params, undefined)
  assert.equal(code({ ...hashReceipt(r), v: 3 }), 'v')
})

test('verify: JSON is read as JSON first, so a tool result\'s _meta wins over the link in its text', () => {
  const a = makeReceipt({ id: 'a' }), b = makeReceipt({ id: 'b' })
  const tool = toolResultOf({ receipt: a, checkedBy: 'service', link: verifyLink(b) })
  assert.equal(readReceipt(JSON.stringify(tool)).id, 'a')
  assert.equal(extractReceipt(JSON.stringify({ _meta: { [RECEIPT_META_KEY]: a } })).id, 'a')
})

test('verify: malformed, oversized and hostile input is refused with a reason', () => {
  const r = makeReceipt()
  const code = (text) => { try { readReceipt(text); return 'accepted' } catch (e) { assert.ok(e instanceof ReceiptError, e.message); return e.code } }
  assert.equal(code(''), 'empty')
  assert.equal(code('   \n '), 'empty')
  assert.equal(code(undefined), 'empty')
  assert.equal(code('x'.repeat(MAX_INPUT + 1)), 'too-large')
  assert.equal(code('é'.repeat(MAX_INPUT / 2 + 1)), 'too-large', 'counted in UTF-8 bytes')
  assert.equal(code(`https://tapeapi.fun/verify/#r=${toBase64Url(JSON.stringify({ ...r, pad: 'x'.repeat(MAX_INPUT) }))}`), 'too-large')
  assert.equal(code('hello world'), 'unreadable')
  assert.equal(code('r=abc$'), 'unreadable', 'a base64url run followed by garbage is not a link')
  assert.equal(code('#r=a'), 'bad-base64')
  assert.equal(code(`#r=${toBase64Url(JSON.stringify(r)).slice(0, 80)}`), 'bad-json', 'cut short')
  assert.equal(code('{"v":1,'), 'bad-json')
  assert.equal(code('{"jsonrpc":"2.0","id":1,"result":{"content":[]}}'), 'no-receipt')
  assert.equal(code('{"a":1}'), 'no-receipt')
  const text = JSON.stringify(r)
  assert.equal(code(text.replace('"ok":true', '"ok":false,"ok":true')), 'duplicate-key', 'two parsers could keep different values')
  assert.equal(code(text.replace('"params":{}', '"params":{"__proto__":{"x":1}}')), 'duplicate-key')
  assert.equal(code(toBase64Url('[1,2]')), 'shape')
  assert.equal(code(`#r=${toBase64Url('"just a string"')}`), 'shape')
  let deep = '1'; for (let i = 0; i < 100; i++) deep = `[${deep}]`
  assert.equal(code(JSON.stringify({ ...r, params: { deep: 0 } }).replace('"deep":0', `"deep":${deep}`)), 'bad-json', 'nesting is capped')
})

test('verify: the shape check names the bad field', () => {
  const r = makeReceipt()
  const field = (mut) => { const x = structuredClone(r); mut(x); try { parseReceipt(x); return 'accepted' } catch (e) { assert.equal(e.code, 'shape'); return e.field } }
  assert.equal(field(() => {}), 'accepted')
  assert.equal(field((x) => { x.v = 3 }), 'v')
  assert.equal(field((x) => { x.v = 2 }), 'requestHash', 'v 2 is the hash-only form, which needs its hashes')
  assert.equal(field((x) => { delete x.service }), 'service')
  assert.equal(field((x) => { x.service.circuits = '0x1234' }), 'service.circuits')
  assert.equal(field((x) => { x.service.tokenId = 11 }), 'service.tokenId')
  assert.equal(field((x) => { x.service.tokenId = '011' }), 'service.tokenId')
  assert.equal(field((x) => { x.service.container = 'container' }), 'service.container')
  assert.equal(field((x) => { x.service.name = 7 }), 'service.name')
  assert.equal(field((x) => { x.method = '' }), 'method')
  assert.equal(field((x) => { x.params = [1] }), 'params')
  assert.equal(field((x) => { x.params = 'a=1' }), 'params')
  assert.equal(field((x) => { x.id = 1 }), 'id')
  assert.equal(field((x) => { x.ts = -1 }), 'ts')
  assert.equal(field((x) => { x.ts = 1.5 }), 'ts')
  assert.equal(field((x) => { x.ts = '1790530855' }), 'ts')
  assert.equal(field((x) => { x.ok = 'true' }), 'ok')
  assert.equal(field((x) => { delete x.result }), 'result')
  assert.equal(field((x) => { x.ok = false; delete x.result }), 'error')
  assert.equal(field((x) => { x.block = -1 }), 'block')
  assert.equal(field((x) => { x.sig = x.sig.slice(0, 20) }), 'sig')
  assert.equal(field((x) => { x.sig = x.sig.slice(2) + '00' }), 'sig')
  // What is not part of a v1 receipt is dropped, absent params are {} (as the digest reads them), null result is kept.
  // 不属于 v1 回执的字段丢弃；缺省 params 读作 {}（与摘要一致）；null 结果保留。
  const p = parseReceipt({ ...r, extra: '<img src=x>', service: { ...r.service, evil: 1 }, params: undefined })
  assert.equal('extra' in p, false); assert.equal('evil' in p.service, false); assert.deepEqual(p.params, {})
  assert.equal(parseReceipt({ ...r, result: null }).result, null)
})

test('verify: helpers: envelope, signed block, name claim, UTC time', () => {
  const live = parseReceipt(LIVE)
  assert.deepEqual(Object.keys(envelopeOf(live)).sort(), ['body', 'container', 'id', 'method', 'ok', 'params', 'ts'], 'block and name are not signed')
  assert.equal(recoverResponseSigner(envelopeOf(live), live.sig), LIVE_SIGNER, 'the live receipt recovers to the public service key offline')
  assert.equal(recoverResponseSigner(envelopeOf(parseReceipt(LIVE_REFUSAL)), LIVE_REFUSAL.sig), LIVE_SIGNER, 'a signed refusal too')
  assert.equal(signedBlock(live), 124374470)
  assert.equal(signedBlock(parseReceipt(LIVE_REFUSAL)), null)
  assert.deepEqual(nameClaim(live), { tokenId: '11', processor: '1013' })
  assert.equal(nameClaim(parseReceipt({ ...LIVE, service: { ...LIVE.service, name: '11.1013.TAPE' } })), 'malformed')
  assert.equal(nameClaim(parseReceipt({ ...LIVE, service: { ...LIVE.service, name: undefined } })), null)
  assert.equal(utc(1790530855), '2026-09-27 17:40:55 UTC')
})

// ── verdicts / 结论 ─────────────────────────────────────────────────────────────────────────────────────────────
test('verify: VALID when today\'s key signed exactly this request and result (a result or a signed refusal)', async () => {
  for (const r of [makeReceipt(), makeReceipt({ ok: false }), makeReceipt({ name: null }), makeReceipt({ params: { address: CIRCUITS, n: [1, 'x'] } })]) {
    const out = await check(r)
    assert.equal(out.verdict, 'valid', JSON.stringify(out.checks))
    assert.equal(out.failed, null)
    assert.equal(out.recovered, SIGNER)
    for (const c of out.checks) assert.ok(c.state === 'pass' || (c.id === 'name' && r.service.name === undefined && c.state === 'skip'), c.id)
  }
  // Addresses compare without regard to case: a lowercase container in the receipt still matches.
  // 地址比较不区分大小写。
  const r = makeReceipt({ container: CONTAINER.toLowerCase() })
  assert.equal((await check(r)).verdict, 'valid')
})

test('verify: CANNOT CONFIRM (other key) when a well-formed signature is not today\'s key: rotation or tampering look the same', async () => {
  const rotated = await check(makeReceipt({ key: OLD_KEY }))
  assert.equal(rotated.verdict, 'other-key')
  assert.equal(rotated.recovered, privateKeyToAddress(OLD_KEY))
  assert.equal(stateOf(rotated, 'sig'), 'pass', 'the signature itself holds')
  assert.equal(stateOf(rotated, 'signer'), 'fail')
  // The signature binds the request and the result: any change recovers some other well-formed address.
  // 签名绑定请求与结果：任何改动都会恢复出另一个格式正确的地址。
  const tamper = [
    (x) => { x.result.bnbUsd = '9999' },
    (x) => { x.result.blockPinned.blockNumber = 1 },
    (x) => { x.method = 'balance' },
    (x) => { x.params = { address: CIRCUITS } },
    (x) => { x.ts += 1 },
    (x) => { x.id = 'mcp-other' },
  ]
  for (const mut of tamper) {
    const x = makeReceipt(); mut(x)
    const out = await check(x)
    assert.equal(out.verdict, 'other-key', mut.toString())
    assert.notEqual(out.recovered, SIGNER)
  }
  const live = structuredClone(LIVE); live.result.bnbUsd = '1.0'
  const out = await check(live, { resolve: async () => ({ ...service({ signer: LIVE_SIGNER }) }) })
  assert.equal(out.verdict, 'other-key', 'a tampered live receipt')
  // Unsigned fields do not change the signer: the page labels them as not covered. / 未签名字段不影响签名者，页面会标明。
  const r = makeReceipt(); r.block = 5
  assert.equal((await check(r)).verdict, 'valid')
})

test('verify: INVALID when the container does not match, naming that check', async () => {
  // Signed over the other container (so the signature itself holds), resolved to ours.
  // 签名用的是另一个容器（签名本身成立），链上解析出的是我们的容器。
  const out = await check(makeReceipt({ container: OTHER_CONTAINER }))
  assert.equal(out.verdict, 'invalid')
  assert.equal(out.failed, 'container')
  assert.equal(stateOf(out, 'sig'), 'pass')
})

test('verify: INVALID when the signature does not recover to an address', async () => {
  const r = makeReceipt()
  const bad = [
    '0x' + '00'.repeat(65),                                                   // r = s = 0
    r.sig.slice(0, 130) + '1d',                                               // v = 29
    '0x' + 'ff'.repeat(64) + '1b',                                           // r, s >= n
    r.sig.slice(0, 66) + 'f'.repeat(64) + r.sig.slice(130),                   // high s
  ]
  for (const sig of bad) {
    const out = await check({ ...r, sig })
    assert.equal(out.verdict, 'invalid', sig)
    assert.equal(out.failed, 'sig')
    assert.equal(out.recovered, null)
    assert.equal(stateOf(out, 'signer'), 'skip')
  }
})

test('verify: INVALID when the chain says the service is not valid; NOT CHECKED when the chain cannot be read', async () => {
  for (const code of ['MANIFEST_INVALID', 'DELEGATION_INVALID', 'NOT_FOUND']) {
    const out = await check(makeReceipt(), { resolve: async () => { throw new TapeAPIError(code, 'no') } })
    assert.equal(out.verdict, 'invalid', code); assert.equal(out.failed, 'resolve')
  }
  for (const err of [new TapeAPIError('RPC_UNAVAILABLE', 'down'), new TapeAPIError('RPC_DISAGREE', 'split'), new TypeError('Failed to fetch')]) {
    const out = await check(makeReceipt(), { resolve: async () => { throw err } })
    assert.equal(out.verdict, 'unchecked', err.message); assert.equal(stateOf(out, 'resolve'), 'unknown')
    assert.equal(out.recovered, SIGNER, 'the signer is still recovered offline')
  }
  // A bad signature is INVALID even when the chain is down. / 签名坏了，即使读不到链也是无效。
  const out = await check({ ...makeReceipt(), sig: '0x' + '00'.repeat(65) }, { resolve: async () => { throw new TapeAPIError('RPC_UNAVAILABLE', 'down') } })
  assert.equal(out.verdict, 'invalid'); assert.equal(out.failed, 'sig')
  // Belt and braces: an expired or unverified delegation handed over as resolved is still refused.
  // 双保险：即使传进来的已解析服务委托过期或未验证，也拒绝。
  const expired = await check(makeReceipt(), { resolve: async () => service({ expires: NOW - 1 }) })
  assert.equal(expired.failed, 'delegation')
  const unverified = await check(makeReceipt(), { resolve: async () => ({ ...service(), verified: { delegation: false } }) })
  assert.equal(unverified.failed, 'delegation')
})

test('verify: the receipt\'s name is checked on chain, since it is not signed', async () => {
  const wrongId = await check(makeReceipt({ name: '12.1013.tape' }))
  assert.equal(wrongId.verdict, 'invalid'); assert.equal(wrongId.failed, 'name')
  const wrongProcessor = await check(makeReceipt({ name: '11.1014.tape' }))
  assert.equal(wrongProcessor.failed, 'name', 'cpuAt(1014) does not exist')
  const otherCircuits = await check(makeReceipt(), { cpuAt: async () => OTHER_CONTAINER })
  assert.equal(otherCircuits.failed, 'name')
  assert.equal((await check(makeReceipt({ name: 'TapeAPI Public' }))).failed, 'name', 'not a TapeOut name')
  const down = await check(makeReceipt(), { cpuAt: async () => { throw new TapeAPIError('RPC_UNAVAILABLE', 'down') } })
  assert.equal(down.verdict, 'unchecked')
  assert.deepEqual(await checkName(parseReceipt(makeReceipt({ name: null })), () => { throw new Error('not called') }), { state: 'skip' })
})

test('verify: verdictOf is decided by facts in a fixed order', () => {
  const receipt = parseReceipt(makeReceipt())
  const base = { receipt, recovered: SIGNER, svc: service(), name: { state: 'pass' }, now: NOW }
  assert.equal(verdictOf(base).verdict, 'valid')
  assert.equal(verdictOf({ ...base, recovered: 'not an address' }).failed, 'sig')
  assert.equal(verdictOf({ ...base, recoverError: new Error('x') }).failed, 'sig')
  assert.equal(verdictOf({ ...base, svc: null }).verdict, 'unchecked', 'no service, no verdict')
  assert.equal(verdictOf({ ...base, svc: service({ container: OTHER_CONTAINER }), name: { state: 'fail' } }).failed, 'container', 'container before name')
  assert.deepEqual(verdictOf(base).checks.map((c) => c.id), ['sig', 'resolve', 'container', 'delegation', 'name', 'signer'])
})

// ── the page / 页面 ─────────────────────────────────────────────────────────────────────────────────────────────
const mapOf = (page) => {
  const m = /<script type="importmap">([^]*?)<\/script>/.exec(page)
  assert.ok(m, 'the page has an import map')
  return { body: m[1], imports: JSON.parse(m[1]).imports }
}

test('verify page: scripts are files from this site, except the import map, which the page policy allows by hash', () => {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([^]*?)<\/script>/g)]
  assert.equal(scripts.length, 3)
  for (const [, attrs, body] of scripts) {
    if (/type="importmap"/.test(attrs)) continue
    assert.match(attrs, /\ssrc="[^"]+"/, `inline script: ${attrs}`)
    assert.equal(body.trim(), '', 'a script with src has no body')
  }
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'no inline event handlers')
  assert.doesNotMatch(html, /\sstyle\s*=/i, 'no inline styles (style-src \'self\')')
  assert.doesNotMatch(html, /javascript:/i)
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)
  assert.ok(csp, 'a policy in the page')
  assert.ok(html.indexOf(csp[0]) < html.indexOf('<script'), 'the policy comes before any script')
  const dirs = Object.fromEntries(csp[1].split(/;\s*/).map((d) => { const [k, ...v] = d.trim().split(/\s+/); return [k, v] }))
  assert.deepEqual(dirs['default-src'], ["'none'"])
  assert.deepEqual(dirs['base-uri'], ["'none'"])
  assert.deepEqual(dirs['form-action'], ["'none'"])
  assert.deepEqual(dirs['style-src'], ["'self'"])
  assert.deepEqual(dirs['connect-src'], ['https:'], 'the public BSC nodes only need https')
  const hash = `'sha256-${createHash('sha256').update(mapOf(html).body).digest('base64')}'`
  assert.deepEqual(dirs['script-src'], ["'self'", hash], 'script-src is self plus the hash of the import map as it stands (rehash after build-playground changes the map)')
  assert.doesNotMatch(csp[1], /unsafe-inline|unsafe-eval|strict-dynamic/)
  for (const [name, text] of [['verify.js', js], ['lib.js', lib], ['strings.js', strings], ['boot.js', boot]]) {
    assert.doesNotMatch(text, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/, `${name}: receipt text must never become HTML or code`)
  }
  assert.doesNotMatch(js, /localStorage\.setItem\((?!k, v\))/, 'only language and theme are stored')
  assert.doesNotMatch(js, /fetch\(/, 'the page itself fetches nothing: only the SDK reads the chain')
})

test('verify page: the import map is the playground\'s, read from ../playground/vendor/, and every import resolves', () => {
  const mine = mapOf(html).imports
  const theirs = mapOf(read('playground/index.html')).imports
  const expected = Object.fromEntries(Object.entries(theirs).map(([k, v]) => [k, v.replace(/^\.\/vendor\//, '../playground/vendor/')]))
  assert.deepEqual(mine, expected, 'copy the import map from site/playground/index.html, with ./vendor/ -> ../playground/vendor/')
  const seen = new Set()
  const walk = (file) => {
    if (seen.has(file)) return
    seen.add(file)
    for (const spec of importsOf(read(file))) {
      let target
      // a relative import carries a content stamp (scripts/version-assets.mjs) / 相对导入带内容戳
      if (spec.startsWith('./') || spec.startsWith('../')) target = posix.normalize(posix.join(posix.dirname(file), spec.replace(/\?v=[0-9a-f]{10}$/, '')))
      else {
        assert.ok(Object.hasOwn(mine, spec), `${file}: bare import ${spec} is not in the import map`)
        target = posix.normalize(posix.join('verify/', mine[spec]))
      }
      assert.ok(existsSync(join(SITE, target)), `${file}: ${spec} -> site/${target} does not exist`)
      walk(target)
    }
  }
  assert.match(html, /<script type="module" src="verify\.js\?v=[0-9a-f]{10}"><\/script>/)
  assert.match(html, /<script src="boot\.js\?v=[0-9a-f]{10}"><\/script>/)
  walk('verify/verify.js')
  assert.ok(seen.has('playground/vendor/tapeapi-sdk/index.js') && seen.has('verify/lib.js') && seen.has('verify/strings.js'))
  assert.equal([...seen].some((f) => f.startsWith('verify/vendor')), false, 'no second copy of the vendor tree')
})

test('verify page: every id the script uses exists, and ids are unique', () => {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])
  assert.equal(new Set(ids).size, ids.length, 'unique ids')
  const used = new Set([...js.matchAll(/\$\('([^']+)'\)/g), ...js.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]))
  assert.ok(used.size >= 15)
  for (const id of used) assert.ok(ids.includes(id), `#${id} is used by verify.js but missing from index.html`)
  for (const m of html.matchAll(/(?:for|aria-labelledby)="([^"]+)"/g)) assert.ok(ids.includes(m[1]), `${m[0]} points at a missing id`)
})

test('verify page: Chinese and English go in pairs, in the page and in the script', () => {
  assert.deepEqual(Object.keys(T.zh).sort(), Object.keys(T.en).sort(), 'the same keys in both languages')
  for (const k of Object.keys(T.zh)) assert.equal(typeof T.zh[k], typeof T.en[k], k)
  // Every key the script asks for exists, including the families it builds (err.<code>, v.<verdict>, ...).
  // 脚本用到的每个键都存在，包括拼出来的键族。
  for (const m of js.matchAll(/\bt\('([^']+)'/g)) assert.ok(Object.hasOwn(T.en, m[1]), `t('${m[1]}')`)
  const families = {
    'err.': ['empty', 'too-large', 'unreadable', 'bad-base64', 'bad-json', 'duplicate-key', 'no-receipt', 'shape'],
    'v.': ['valid', 'other-key', 'invalid', 'unchecked'],
    'x.invalid.': ['sig', 'resolve', 'container', 'delegation', 'name', 'method', 'amount', 'request', 'response'],
    'c.': ['sig', 'resolve', 'container', 'delegation', 'name', 'signer', 'method', 'amount', 'request', 'response'],
    'c.method.': ['pass', 'fail', 'unknown', 'skip'],
    's.': ['pass', 'fail', 'unknown', 'skip'],
  }
  for (const [prefix, names] of Object.entries(families)) {
    assert.ok(js.includes(`t(\`${prefix}\${`), `verify.js builds ${prefix}<name> keys`)
    for (const n of names) assert.ok(Object.hasOwn(T.en, prefix + n), prefix + n)
  }
  assert.match(lib, /new ReceiptError\('(?:empty|too-large|unreadable|bad-base64|bad-json|duplicate-key|no-receipt|shape)'/)
  for (const m of lib.matchAll(/ReceiptError\('([a-z-]+)'/g)) assert.ok(families['err.'].includes(m[1]), `a message for ${m[1]}`)
  // In the HTML: each <span class="t" lang="zh"> is followed at once by its English twin. / 每个中文 span 紧跟英文 span。
  const zh = [...html.matchAll(/<span class="t" lang="zh">/g)]
  assert.ok(zh.length >= 15)
  assert.equal(zh.length, [...html.matchAll(/<span class="t" lang="en">/g)].length)
  for (const m of zh) {
    const close = html.indexOf('</span>', m.index)
    assert.ok(!html.slice(m.index + m[0].length, close).includes('<span'), 'no span inside a language span')
    assert.ok(html.startsWith('<span class="t" lang="en">', close + '</span>'.length), `zh text at ${m.index} has no English twin right after it`)
  }
  assert.match(css, /\.t\[lang\] \{ display: none; \}/)
  assert.match(css, /:root\[data-lang="zh"\] \.t\[lang="zh"\], :root\[data-lang="en"\] \.t\[lang="en"\] \{ display: inline; \}/)
})

test('verify page: nothing is loaded from elsewhere; links go to this site or the repository only', () => {
  for (const m of html.matchAll(/\b(?:src|href)="([^"]*)"/g)) {
    const r = m[1]
    if (/^https:\/\/github\.com\/BruceLanLan\/tapeapi$/.test(r)) continue
    assert.doesNotMatch(r, /^(?:[a-z][a-z0-9+.-]*:)?\/\//i, `${r}: another origin`)
    const path = r.split(/[?#]/)[0]
    const file = path.startsWith('/') ? path.slice(1) : posix.normalize(posix.join('verify/', path))
    assert.ok(existsSync(join(SITE, file.endsWith('/') || file === '' ? `${file}index.html` : file)), `${r} -> site/${file} does not exist`)
  }
  // Absolute URLs anywhere in the page text are tapeapi.fun ones (metadata, examples) or the repository.
  // 页面文字中的绝对 URL 只能是 tapeapi.fun（元数据、示例）或仓库。
  for (const m of html.matchAll(/https?:\/\/[^\s"'<)]+/g)) assert.match(m[0], /^https:\/\/((api\.)?tapeapi\.fun\/|github\.com\/BruceLanLan\/tapeapi$)/, m[0])
  const jsUrls = [...new Set([...js.matchAll(/https?:\/\/[^\s'"`)]+/g)].map((m) => m[0]))].sort()
  // The nodes are the vendored SDK's rpcUrlsFor(56) (three operators): the script names no URL itself.
  // 节点取自 vendor 的 SDK 的 rpcUrlsFor(56)（三家运营方）：脚本自己不写任何 URL。
  assert.deepEqual(jsUrls, [], 'the script reaches only the SDK\'s public BSC nodes')
  assert.match(js, /const RPC_URLS = rpcUrlsFor\(56\)/)
  for (const m of strings.matchAll(/https?:\/\/[^\s'"`)]+/g)) assert.match(m[0], /^https:\/\/tapeapi\.fun\/verify\//, 'placeholders only')
  assert.doesNotMatch(lib + boot, /https?:\/\//)
  for (const [name, text] of [['index.html', html], ['verify.js', js], ['lib.js', lib], ['strings.js', strings], ['verify.css', css], ['boot.js', boot]]) {
    assert.doesNotMatch(text, /@import|url\(\s*['"]?(?:https?:)?\/\//i, `${name}: remote stylesheet or asset`)
    assert.doesNotMatch(text, /claude/i, `${name}: the page is for outside developers`)
  }
})

test('verify page: served with one frame-forbidding policy, listed in the sitemap, reads the receipt from the fragment only', () => {
  const headers = read('_headers')
  const rule = /^\/verify\/\*\n((?:[ \t]+.+\n?)+)/m.exec(headers)
  assert.ok(rule, '_headers has a /verify/* rule')
  assert.deepEqual(rule[1].trim().split('\n').map((l) => l.trim()), ["Content-Security-Policy: frame-ancestors 'none'"])
  assert.match(read('sitemap.xml'), /<loc>https:\/\/tapeapi\.fun\/verify\/<\/loc>/)
  assert.match(js, /location\.hash/)
  assert.doesNotMatch(js, /location\.search|URLSearchParams|history\.pushState/, 'the receipt never moves into the query string')
  // The nav stays as it is on the other pages (the page is linked from the docs, not the header).
  // 页头导航与其他页面一致。
  const nav = (page) => /<nav class="hd-nav"[^]*?<\/nav>/.exec(page)[0].replace(/ aria-current="page"/g, '').replace(/href="\.\/"/g, 'href="../status/"')
  assert.equal(nav(html), nav(read('status/index.html')))
})

// ── AI usage receipts / AI 用量回执 ─────────────────────────────────────────────────────────────────────────────
// Made by the real sidecar, then read in every form a client holds and judged on facts. / 由真实旁路签发，再以各种形式读出并判断。
const AI_MODELS = [{ id: 'demo-chat', prices: [{ currency: 'BEM', unit: '1M tokens', input: '0.15', output: '0.6' }] }]
const AI_REQ = '{"model":"demo-chat","messages":[{"role":"user","content":"hi"}]}'
const AI_JSON = '{"id":"chatcmpl-7","model":"demo-chat","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30}}'
const AI_SSE = 'data: {"id":"chatcmpl-8","model":"demo-chat","choices":[]}\n\ndata: {"id":"chatcmpl-8","model":"demo-chat","choices":[],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}\n\ndata: [DONE]\n\n'
async function aiReceipts(key = KEY) {
  const p = createAIProxy({
    upstream: { baseUrl: 'https://up.example/v1' }, signerKey: key, models: AI_MODELS, log: () => {},
    manifestBase: { name: 'AI', circuits: CIRCUITS, tokenId: '11', container: CONTAINER, delegation: null, endpoints: { live: ['https://ai.example/tapeapi/v1'], async: false } },
    fetch: async (url, init) => (JSON.parse(new TextDecoder().decode(init.body)).stream
      ? new Response(AI_SSE, { headers: { 'content-type': 'text/event-stream' } })
      : new Response(AI_JSON, { headers: { 'content-type': 'application/json' } })),
  })
  const call = (body) => p.handleRequest(new Request('https://ai.example/v1/chat/completions', { method: 'POST', body }), { clientIp: '1.1.1.1' })
  const res = await call(AI_REQ)
  const header = res.headers.get('x-tapeapi-receipt')
  const streamReq = AI_REQ.replace('{', '{"stream":true,"stream_options":{"include_usage":true},')
  const streamText = await (await call(streamReq)).text()
  const outer = await (await p.handleRequest(new Request('https://ai.example/tapeapi/v1/receipt', { method: 'POST', body: JSON.stringify({ id: 'q', params: { id: 'chatcmpl-7' } }) }), { clientIp: '1.1.1.1' })).json()
  return { p, header, streamReq, streamText, outer, manifest: p.manifest() }
}
const aiService = (m, over = {}) => ({ container: CONTAINER, manifest: { ...m, delegation: { expires: NOW + 86_400, sig: '0x' } }, verified: { delegation: true, holder: HOLDER }, ...over })
const aiIo = (m, over = {}) => ({ recover: recoverResponseSigner, resolve: async (c) => { assert.equal(c, CONTAINER, 'resolved from the receipt\'s container'); return aiService(m) }, now: NOW, ...over })

test('verify: an AI usage receipt reads from the header value or line, the SSE comment or whole stream, the receipt method, or JSON', async () => {
  const { header, streamText, outer } = await aiReceipts()
  const env = JSON.parse(Buffer.from(header, 'base64url').toString())
  assert.ok(isUsageShape(env))
  const want = parseUsageReceipt(env)
  for (const [name, text] of Object.entries({
    headerValue: header, headerLine: `x-tapeapi-receipt: ${header}`, headerInDump: `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nx-tapeapi-receipt: ${header}\r\n\r\n{}`,
    json: JSON.stringify(env), receiptMethod: JSON.stringify(outer), comment: receiptComment(env),
  })) {
    const got = readAny(text)
    assert.equal(got.kind, 'usage', name); assert.deepEqual(got.receipt, want, name)
  }
  const s = readAny(streamText)
  assert.equal(s.kind, 'usage'); assert.equal(s.receipt.id, 'chatcmpl-8'); assert.equal(s.receipt.result.stream, true)
  // Still a TAP-21 receipt when it is one. / TAP-21 回执照旧。
  assert.equal(readAny(verifyLink(makeReceipt())).kind, 'receipt')
  const shape = (mut) => { const x = structuredClone(env); mut(x); try { parseUsageReceipt(x); return 'ok' } catch (e) { return e.field } }
  assert.equal(shape((x) => { x.params.requestSha256 = 'xyz' }), 'params')
  assert.equal(shape((x) => { x.result.usage = { prompt_tokens: -1 } }), 'result.usage')
  assert.equal(shape((x) => { x.result.prices[0].amount = '1.5' }), 'result.prices')
  assert.equal(shape((x) => { delete x.result.complete }), 'result.complete')
  assert.equal(shape((x) => { x.ok = false }), 'ok')
  assert.equal(shape((x) => { x.sig = '0x12' }), 'sig')
  assert.equal(recoverResponseSigner(usageEnvelopeOf(want), want.sig), SIGNER, 'the page\'s envelope is exactly what was signed')
})

test('verify: AI receipt verdicts: valid; other key when altered; invalid amount signed by the right key; hashes checked only when pasted', async () => {
  const { header, streamReq, streamText, manifest } = await aiReceipts()
  const env = JSON.parse(Buffer.from(header, 'base64url').toString())
  const r = parseUsageReceipt(env)
  const state = (out, id) => out.checks.find((c) => c.id === id).state
  let out = await verifyUsage(r, aiIo(manifest))
  assert.equal(out.verdict, 'valid', JSON.stringify(out.checks))
  assert.deepEqual(out.checks.map((c) => c.id), ['sig', 'resolve', 'container', 'delegation', 'signer', 'method', 'amount', 'request', 'response'])
  assert.equal(state(out, 'request'), 'skip'); assert.equal(state(out, 'response'), 'skip')
  out = await verifyUsage(r, { ...aiIo(manifest), request: AI_REQ, response: AI_JSON })
  assert.equal(out.verdict, 'valid'); assert.equal(state(out, 'request'), 'pass'); assert.equal(state(out, 'response'), 'pass')
  out = await verifyUsage(r, { ...aiIo(manifest), request: AI_REQ + ' ', response: AI_JSON })
  assert.deepEqual([out.verdict, out.failed], ['invalid', 'request'])
  out = await verifyUsage(r, { ...aiIo(manifest), response: AI_JSON.replace('20', '21') })
  assert.deepEqual([out.verdict, out.failed], ['invalid', 'response'])
  const sr = readAny(streamText).receipt
  out = await verifyUsage(sr, { ...aiIo(manifest), request: streamReq, response: streamText })
  assert.equal(out.verdict, 'valid', 'a stream: its data payloads are hashed, the receipt comment is ignored')
  // Altered after signing: another key. / 签名后被改：别的密钥。
  const altered = structuredClone(r); altered.result.usage.completion_tokens = 2
  assert.equal((await verifyUsage(altered, aiIo(manifest))).verdict, 'other-key')
  // The right key, a price the table does not give. / 密钥正确，价格与价目表不符。
  const priced = { ...manifest, ai: { ...manifest.ai, models: [{ ...AI_MODELS[0], prices: [{ ...AI_MODELS[0].prices[0], output: '0.5' }] }] } }
  out = await verifyUsage(r, aiIo(priced))
  assert.deepEqual([out.verdict, out.failed], ['invalid', 'amount'])
  assert.match(out.amountProblems[0], /manifest gives 0\.00001150/)
  out = await verifyUsage(r, aiIo({ ...manifest, ai: undefined }))
  assert.deepEqual([out.verdict, out.failed], ['invalid', 'amount'], 'a service with no price table cannot vouch for an amount')
  // Identity: another container, the chain down, a key rotated since. / 身份：别的容器、读不到链、此后换了钥。
  out = await verifyUsage(r, aiIo(manifest, { resolve: async () => aiService(manifest, { container: OTHER_CONTAINER }) }))
  assert.deepEqual([out.verdict, out.failed], ['invalid', 'container'])
  out = await verifyUsage(r, aiIo(manifest, { resolve: async () => { throw new TapeAPIError('RPC_UNAVAILABLE', 'down') } }))
  assert.equal(out.verdict, 'unchecked')
  const { header: h2 } = await aiReceipts(OLD_KEY)
  out = await verifyUsage(parseUsageReceipt(JSON.parse(Buffer.from(h2, 'base64url').toString())), aiIo(manifest))
  assert.equal(out.verdict, 'other-key')
  // A format this page does not know: the path is not checked, the rest is. / 本页不认识的格式：不核对路径，其余照常。
  const unknown = { ...env, method: 'future_format' }
  unknown.sig = signResponse(usageEnvelopeOf(unknown), KEY)
  out = await verifyUsage(parseUsageReceipt(unknown), aiIo(manifest))
  assert.equal(out.verdict, 'valid'); assert.equal(state(out, 'method'), 'unknown')
  const wrongPath = { ...env, method: 'openai_embeddings' }
  wrongPath.sig = signResponse(usageEnvelopeOf(wrongPath), KEY)
  assert.equal((await verifyUsage(parseUsageReceipt(wrongPath), aiIo(manifest))).failed, 'method')
  assert.ok(encodeReceipt(env).length < MAX_INPUT)
})
