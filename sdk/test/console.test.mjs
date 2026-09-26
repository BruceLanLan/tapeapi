// The holder console at tapeapi.fun/console builds a delegation and a putFile transaction without the SDK (a static page
// for a phone wallet). Here every byte it builds is checked against the SDK. / 持有人操作台不依赖 SDK 构造委托与 putFile 交易；
// 这里逐字节对照 SDK 检查。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import * as C from '../../site/console/lib.js'
import { createTapeAPI, sig, abi, MAINNET, MANIFEST_KEY } from '../src/index.js'
import { privateKeyToAddress } from '../src/sig.js'

const container = '0x86DDaEF00401E3F10418398D67D7189fc458eA95', circuits = '0x50a994e71615474b55559ff4f500928fbc339dd9'
const signer = privateKeyToAddress('0x' + '22'.repeat(32))
const expires = 1800000000

test('constants and selectors are the SDK\'s', () => {
  assert.equal(C.HUB, MAINNET.hub)
  assert.equal(C.SITE_REGISTRY, MAINNET.siteRegistry)
  assert.equal(C.FACTORY, MAINNET.factory)
  assert.equal(C.MANIFEST_KEY, MANIFEST_KEY)
  for (const name of ['isCPU', 'accountOf', 'ownerOf', 'putFile']) assert.equal(C.SEL[name], abi.selector(name), name)
})

test('the delegation typed data is exactly sdk sig.delegationTypedData', () => {
  assert.deepEqual(C.delegationTypedData({ container, signer, expires }), sig.delegationTypedData(56, MAINNET.hub, { container, signer, expires }))
})

test('putFile calldata is byte for byte what api.tx.publishManifest builds', () => {
  for (const text of ['{"a":1}', JSON.stringify({ tapeapi: '0.1', name: 'TapeAPI Reader 读取服务', container, methods: [{ name: 'x'.repeat(300) }] })]) {
    const sha = '0x' + createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
    const mine = C.putFileTx({ container, text, sha256Hex: sha })
    const sdk = createTapeAPI({}).tx
    const want = abi.encodeCall('putFile', [container, MANIFEST_KEY, 'application/json', sha, '0x' + Buffer.from(text, 'utf8').toString('hex')])
    assert.equal(mine.data, want.toLowerCase())
    assert.equal(mine.to, MAINNET.siteRegistry)
    assert.ok(sdk)
  }
  assert.throws(() => C.putFileTx({ container, text: 'x'.repeat(24_001), sha256Hex: '0x' + '00'.repeat(32) }), /24000/)
})

test('readCircuit reads processor, container and holder, and refuses a non-TapeOut processor or a missing contract', async () => {
  const w = (a) => '0x' + a.slice(2).toLowerCase().padStart(64, '0')
  const holder = '0x' + '77'.repeat(20)
  const answers = (cpu) => async (to, data) => {
    if (data.startsWith(C.SEL.cpuAt)) { assert.equal(BigInt('0x' + data.slice(10)), 7n); return w(circuits) }
    if (data.startsWith(C.SEL.isCPU)) return '0x' + (cpu ? '1' : '0').padStart(64, '0')
    if (data.startsWith(C.SEL.accountOf)) { assert.equal(to, C.HUB); return w(container) }
    if (data.startsWith(C.SEL.ownerOf)) { assert.equal(to.toLowerCase(), circuits); return w(holder) }
    throw new Error('unexpected call')
  }
  assert.deepEqual(await C.readCircuit(answers(true), { processor: 7, tokenId: 1 }), { circuits, tokenId: '1', container: container.toLowerCase(), holder })
  await assert.rejects(C.readCircuit(answers(false), { processor: 7, tokenId: 1 }), /not a TapeOut processor/)
  await assert.rejects(C.readCircuit(async () => '0x', { processor: 7, tokenId: 1 }), /no code there/)
  await assert.rejects(C.readCircuit(answers(true), { processor: 7, tokenId: 0 }), /1 or more/)
})

test('newSignerKey draws from the CSPRNG and never returns 0 or a key outside the curve order', () => {
  const draws = [new Uint8Array(32), new Uint8Array(32).fill(0xff), Uint8Array.from({ length: 32 }, (_, i) => i + 1)]
  const k = C.newSignerKey((b) => { b.set(draws.shift()); return b })
  assert.equal(k, '0x' + Array.from({ length: 32 }, (_, i) => (i + 1).toString(16).padStart(2, '0')).join(''))
  assert.match(privateKeyToAddress(C.newSignerKey()), /^0x[0-9a-fA-F]{40}$/)
})

test('keccak256 and addressOfKey are the SDK\'s (noble), across block boundaries and random keys', () => {
  for (const n of [0, 1, 31, 32, 135, 136, 137, 271, 272, 1000]) {
    const b = Uint8Array.from({ length: n }, (_, i) => (i * 131 + n) & 0xff)
    assert.equal(Buffer.from(C.keccak256(b)).toString('hex'), Buffer.from(sig.keccak256(b)).toString('hex'), `length ${n}`)
  }
  for (let i = 0; i < 25; i++) { const k = C.newSignerKey(); assert.equal(C.addressOfKey(k), privateKeyToAddress(k)) }
  for (const k of ['0x' + '00'.repeat(31) + '01', '0x' + 'ff'.repeat(15) + 'fe' + 'aa'.repeat(16)]) assert.equal(C.addressOfKey(k), privateKeyToAddress(k))
  for (const bad of ['0x' + '00'.repeat(32), '0x' + 'ff'.repeat(32)]) assert.throws(() => C.addressOfKey(bad), /curve order/)
  assert.throws(() => C.addressOfKey('0x1234'), /32 bytes/)
  assert.equal(C.checksum(signer.toLowerCase()), signer)
})

const sigHex = '0x' + 'ab'.repeat(65)
const S = { container, circuits, tokenId: '1', signer, expires, sig: sigHex, endpoint: 'https://api.tapeapi.fun/tapeapi/v1' }

test('the manifest the page publishes is exactly what worker.js serves, and passes the SDK\'s manifest rules', async () => {
  const { default: worker } = await import('../../examples/cloudflare-worker/worker.js?console')
  const HOLDER_KEY = '0x' + '11'.repeat(32), SIGNER_KEY = '0x' + '22'.repeat(32)
  const exp = Math.floor(Date.now() / 1000) + 86400
  const dsig = sig.signDigest(sig.delegationDigest(56, MAINNET.hub, { container, signer, expires: exp }), HOLDER_KEY)
  const env = { SIGNER_KEY, PUBLIC_URL: 'https://api.tapeapi.fun/', CIRCUITS: circuits, TOKEN_ID: '1', CONTAINER: container, DELEGATION_EXPIRES: String(exp), DELEGATION_SIG: dsig }
  const served = await (await worker.fetch(new Request('https://api.tapeapi.fun/.well-known/tapeapi.json'), env)).text()
  const s = { ...S, expires: exp, sig: dsig }
  assert.deepEqual(C.manifestProblems(served, s), [])
  assert.deepEqual(JSON.parse(C.manifestText({ ...s, name: JSON.parse(served).name })), JSON.parse(served))
  const { validateManifest } = await import('../src/manifest.js')
  assert.doesNotThrow(() => validateManifest(JSON.parse(C.manifestText(s)), { requireDelegation: true }))
})

test('FIXED console-F2: manifestProblems refuses every field the page did not build', () => {
  const good = JSON.parse(C.manifestText(S))
  assert.deepEqual(C.manifestProblems(JSON.stringify(good), S), [])
  assert.deepEqual(C.manifestProblems(JSON.stringify({ ...good, container: container.toLowerCase(), signer: signer.toLowerCase() }), S), [], 'hex case does not matter')
  const mutations = {
    'second endpoint': { ...good, endpoints: { live: [S.endpoint, 'https://evil.example/tapeapi/v1'], async: false } },
    'priced method': { ...good, methods: [{ ...good.methods[0], priceBEM: '1000' }] },
    'extra priced method': { ...good, methods: [...good.methods, { name: 'x', priceBEM: '0.1', params: {}, returns: {} }] },
    payment: { ...good, payment: { escrow: '0x' + 'ee'.repeat(20), unit: 'BEM', decimals: 8 } },
    dev: { ...good, dev: true },
    junk: { ...good, junk: 'x'.repeat(20_000) },
    'wrong signer': { ...good, signer: '0x' + '99'.repeat(20) },
    'wrong sig': { ...good, delegation: { expires, sig: '0x00' } },
    'tokenId 01': { ...good, tokenId: '01' },
    'async missing': { ...good, endpoints: { live: [S.endpoint] } },
    'control chars in name': { ...good, name: 'TapeAPI\u202e\u0007' },
    'long name': { ...good, name: 'n'.repeat(65) },
  }
  for (const [what, m] of Object.entries(mutations)) assert.ok(C.manifestProblems(JSON.stringify(m), S).length > 0, what)
  assert.deepEqual(C.manifestProblems('nope', S), ['not JSON'])
  assert.deepEqual(C.manifestProblems('[1]', S), ['not a JSON object'])
  assert.throws(() => C.manifestText({ ...S, endpoint: 'http://api.tapeapi.fun/tapeapi/v1' }), /https/)
  for (const e of ['https://evil.example@api.tapeapi.fun/tapeapi/v1', 'https://api.tapeapi.fun/x/tapeapi/v1', 'http://localhost.evil.com/tapeapi/v1', 'https://api.tapeapi.fun/tapeapi/v1/']) assert.throws(() => C.manifestText({ ...S, endpoint: e }), /https/, e)
  assert.doesNotThrow(() => C.manifestText({ ...S, endpoint: 'http://127.0.0.1:8797/tapeapi/v1' }), 'loopback http for local testing, as the Worker allows')
  assert.equal(JSON.parse(C.manifestText({ ...S, name: '读取服务' })).name, '读取服务', 'the service may choose its display name')
})

// The page's script lives in site/console/console.js (no inline script, so /console/* can run under script-src 'self').
// 页面脚本在 site/console/console.js（没有内联脚本，/console/* 才能用 script-src 'self'）。
const pageScript = () => readFileSync(new URL('../../site/console/console.js', import.meta.url), 'utf8')

test('FIXED console-F1: the page stores the generated key\'s address and step 4 signs only for it', async () => {
  const html = pageScript()
  assert.match(html, /saveSvc\(\{ keyAddress,/)
  assert.match(html, /h\.signer\.toLowerCase\(\) !== s\.keyAddress\.toLowerCase\(\)/)
  assert.match(html, /delegationTypedData\(\{ container: s\.container, signer: s\.keyAddress,/)
  assert.doesNotMatch(html, /signer: h\.signer/)
  assert.match(html, /C\.manifestText\(/, 'step 5 publishes the page\'s own bytes')
})

test('readCircuit normalises the circuit number ("01" is circuit 1) and refuses non-digits', async () => {
  const w = (a) => '0x' + a.slice(2).toLowerCase().padStart(64, '0')
  const answers = async (to, data) => data.startsWith(C.SEL.isCPU) ? '0x' + '1'.padStart(64, '0') : w(data.startsWith(C.SEL.cpuAt) ? circuits : container)
  assert.equal((await C.readCircuit(answers, { processor: '7', tokenId: ' 01 ' })).tokenId, '1')
  await assert.rejects(C.readCircuit(answers, { processor: '1e3', tokenId: '1' }), /whole number/)
  // The processor's contract address pasted in the number box is named as such (Bruce did this on launch day).
  // 把处理器合约地址填进编号框时，直接说明要填的是数字（上线当天真实发生过）。
  await assert.rejects(C.readCircuit(answers, { processor: '0xe02c26c7432A7121168AA9B610DE24eCf9a1a414', tokenId: '11' }), /not a contract address/)
  await assert.rejects(C.readCircuit(answers, { processor: '7', tokenId: '0x1' }), /1 or more/)
})

test('FIXED console-F4: the page recovers the delegation signature itself, as the SDK does, and refuses anything else', () => {
  const HOLDER_KEY = '0x' + '11'.repeat(32), holder = privateKeyToAddress(HOLDER_KEY)
  const d = { container, signer, expires }
  const digest = sig.delegationDigest(56, MAINNET.hub, d)
  assert.equal(Buffer.from(C.delegationDigest(d)).toString('hex'), Buffer.from(digest).toString('hex'))
  const good = sig.signDigest(digest, HOLDER_KEY)
  assert.equal(C.recoverAddress(C.delegationDigest(d), good), holder)
  const v01 = good.slice(0, 130) + (parseInt(good.slice(130), 16) - 27).toString(16).padStart(2, '0')
  assert.equal(C.recoverAddress(C.delegationDigest(d), v01), holder, 'v = 0/1 as some wallets return it')
  for (let i = 0; i < 10; i++) {
    const k = C.newSignerKey(), dd = { container, signer: C.addressOfKey(C.newSignerKey()), expires: expires + i }
    assert.equal(C.recoverAddress(C.delegationDigest(dd), sig.signDigest(sig.delegationDigest(56, MAINNET.hub, dd), k)), privateKeyToAddress(k))
  }
  assert.notEqual(C.recoverAddress(C.delegationDigest({ ...d, expires: expires + 1 }), good), holder, 'another message')
  for (const bad of ['0x', good.slice(0, 128), good + '00', '0x' + '00'.repeat(65), good.slice(0, 130) + '05']) assert.equal(C.recoverAddress(C.delegationDigest(d), bad), null, bad.length)
})

test('FIXED console-F4/F5/F3: the page re-checks the wallet, the container and the transaction before each step', async () => {
  const html = pageScript()
  assert.match(html, /eth\?\.on\?\.\('accountsChanged', \(\) => location\.reload\(\)\)/)
  assert.match(html, /eth\?\.on\?\.\('chainChanged', \(\) => location\.reload\(\)\)/)
  assert.equal((html.match(/await ensureSame\(\)/g) || []).length, 4, 'before the deploy, the test message, the signature and the putFile')
  assert.equal((html.match(/chainId: BSC,/g) || []).length, 3, 'every transaction names the chain')
  assert.match(html, /C\.recoverAddress\(C\.delegationDigest\(/)
  assert.ok(html.indexOf("if (cid !== BSC)") < html.indexOf('account = accs[0]'), 'the account is kept only once the chain is right')
  assert.match(html, /eth_getCode', \[c\.container/, 'step 2 refuses an unopened container')
  assert.match(html, /30cd7471/, 'step 5 translates NotOwner from the pre-flight estimate')
  assert.match(html, /\$\('btn-publish'\)\.disabled = true/, 'one tap, one transaction')
  const pub = html.slice(html.indexOf("$('btn-publish').onclick"), html.indexOf("$('republish').onchange"))
  assert.match(pub, /\} finally \{[\s\S]*enableSvc\(\)[\s\S]*\}\s*\}\s*$/, 'every early return re-enables the button for a retry')
  assert.match(html, /box\.remove\(\)/, 'the key can be cleared from the page')
  assert.doesNotMatch(html, /localStorage\.setItem\([^)]*SIGNER_KEY/)
})

test('FIXED R7-3: the console refuses a high-s signature, as the SDK and every client do', () => {
  const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
  const d = { container, signer, expires }
  const good = sig.signDigest(sig.delegationDigest(56, MAINNET.hub, d), '0x' + '11'.repeat(32))
  const s = BigInt('0x' + good.slice(66, 130)), v = parseInt(good.slice(130), 16)
  const high = good.slice(0, 66) + (N - s).toString(16).padStart(64, '0') + (v === 27 ? 28 : 27).toString(16)
  assert.throws(() => sig.recoverAddress(sig.delegationDigest(56, MAINNET.hub, d), high), 'the SDK refuses it')
  assert.equal(C.recoverAddress(C.delegationDigest(d), high), null, 'so the page must not accept it either')
  assert.equal(C.recoverAddress(C.delegationDigest(d), good), privateKeyToAddress('0x' + '11'.repeat(32)))
})

test('probeTx is byte for byte ChannelBus.send(room, wire) as the SDK encodes it', () => {
  const bus = '0x' + 'cb'.repeat(20)
  for (const text of ['', 'probe 2026-09-26T10:00:00Z', 'x'.repeat(300)]) {
    const tx = C.probeTx({ bus, text })
    const wire = '0x02' + Buffer.from(text, 'utf8').toString('hex')
    assert.equal(tx.data, abi.encodeCall('send', ['0x' + C.PROBE_ROOM, wire]).toLowerCase())
    assert.equal(tx.to, bus)
  }
  assert.equal(C.PROBE_ROOM, Buffer.from('tapeapi deploy probe').toString('hex').padEnd(64, '0'))
})

// The one amendment to F2 (2026-09-26, for the public service): a service may choose its method list, but only free
// methods with the TAP-20 fields and plain notations; the page publishes that list, shows every name, and nothing else
// in the manifest can come from the service. / F2 的唯一修订：服务可以自选方法列表，但只能是免费的、只含 TAP-20 字段的方法；
// 页面发布这个列表并列出每个方法名，清单的其他部分仍不能来自服务。
test('FIXED console-F2 (amended): a free method list may come from the service; everything else about it is checked', async () => {
  const { MANIFEST_METHODS } = await import('../../examples/public-api/methods.js')
  const { validateManifest } = await import('../src/manifest.js')
  const good = JSON.parse(C.manifestText({ ...S, methods: MANIFEST_METHODS }))
  assert.deepEqual(C.manifestProblems(JSON.stringify(good), S), [], 'the public service\'s own list is publishable')
  assert.deepEqual(good.methods, MANIFEST_METHODS)
  assert.doesNotThrow(() => validateManifest(good, { requireDelegation: true }), 'and it is a valid TAP-20 manifest')
  const one = { name: 'x', priceBEM: '0', params: {}, returns: {} }
  const refused = {
    priced: [{ ...one, priceBEM: '0.00000001' }],
    'price as a number': [{ ...one, priceBEM: 0 }],
    'unexpected field': [{ ...one, payment: { escrow: '0x' + 'ee'.repeat(20) } }],
    'prototype name': [{ ...one, name: '__proto__' }],
    'bad name': [{ ...one, name: 'a-b' }],
    duplicate: [one, one],
    'no methods': [],
    'too many': Array.from({ length: 65 }, (_, i) => ({ ...one, name: `m${i}` })),
    'object notation': [{ ...one, params: { a: { type: 'x' } } }],
    'params array': [{ ...one, params: [] }],
    'long notation': [{ ...one, returns: { a: 'x'.repeat(201) } }],
    'control chars': [{ ...one, description: 'ok\u0007' }],
    'long description': [{ ...one, description: 'd'.repeat(257) }],
    'not an object': ['blockNumber'],
  }
  for (const [what, methods] of Object.entries(refused)) {
    assert.ok(C.manifestProblems(JSON.stringify({ ...good, methods }), S).length > 0, what)
    assert.throws(() => C.manifestText({ ...S, methods }), undefined, what)
  }
  assert.ok(C.manifestProblems(JSON.stringify({ ...good, methods: undefined }), S).length > 0, 'missing list')
  assert.match(pageScript(), /sm\.methods\.map\(\(x\) => x\.name\)/, 'step 5 names every method before the wallet asks')
})

// ---------------------------------------------------------------- the page itself: CSP, anti-phishing, language ----
const SITE = new URL('../../site/', import.meta.url)
const consoleHtml = () => readFileSync(new URL('console/index.html', SITE), 'utf8')

test('the console has no inline script, so /console/* can forbid every script that is not a file of the site', () => {
  const html = consoleHtml()
  const scripts = [...html.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0])
  assert.ok(scripts.length >= 2, 'lang.js and console.js')
  for (const tag of scripts) {
    const src = tag.match(/\ssrc="([^"]+)"/)?.[1]
    assert.ok(src, `inline script: ${tag}`)
    assert.match(src, /^\.\/[a-z]+\.js$/, `a file next to the page: ${src}`)
    assert.ok(existsSync(new URL(`console/${src.slice(2)}`, SITE)), `${src} exists`)
  }
  assert.doesNotMatch(html, /<script\b(?![^>]*\bsrc=)/i)
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'no inline event handlers')
  assert.doesNotMatch(html, /javascript:/i)
})

test('nothing under site/console/ mentions Claude (the page is for outside developers)', () => {
  const walk = (u) => readdirSync(u, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(new URL(`${e.name}/`, u)) : [new URL(e.name, u)])
  const files = walk(new URL('console/', SITE))
  assert.ok(files.length >= 4)
  for (const f of files) assert.doesNotMatch(readFileSync(f, 'utf8'), /claude/i, f.pathname)
})

// A tiny model of Cloudflare Pages _headers: a path line, then indented "Name: value" lines; a request inherits the
// headers of every rule whose path matches (a splat is any run of characters), and a header set twice is joined.
// Cloudflare Pages _headers 的小模型：路径行，下面缩进的“名称: 值”行；请求继承所有匹配规则的头，设两次的头会拼接。
function headersFor(text, path) {
  const rules = []
  for (const raw of text.split('\n')) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue
    if (!/^\s/.test(raw)) { rules.push({ path: raw.trim(), headers: [] }); continue }
    const m = raw.trim().match(/^([A-Za-z-]+):\s*(.+)$/)
    assert.ok(m && rules.length, `a header line under a path: ${raw}`)
    rules.at(-1).headers.push([m[1].toLowerCase(), m[2]])
  }
  const re = (p) => new RegExp('^' + p.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$')
  const out = {}
  for (const r of rules) if (re(r.path).test(path)) for (const [k, v] of r.headers) (out[k] ||= []).push(v)
  return out
}

test('_headers: the console gets exactly one strict CSP; every page forbids framing; the site sends HSTS', () => {
  const text = readFileSync(new URL('_headers', SITE), 'utf8')
  for (const line of text.split('\n')) assert.ok(line.length <= 2000, 'Pages limits a line to 2,000 characters')
  const con = headersFor(text, '/console/')
  assert.equal(con['content-security-policy']?.length, 1, 'one policy, not two joined by a comma')
  const csp = con['content-security-policy'][0]
  for (const d of ["default-src 'self'", "script-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'", "connect-src 'self' https:"]) assert.ok(csp.split(/;\s*/).includes(d), d)
  assert.doesNotMatch(csp, /unsafe-eval|script-src[^;]*unsafe-inline/, 'no script escape hatch')
  assert.deepEqual(headersFor(text, '/console/lib.js')['content-security-policy'], [csp])
  for (const path of ['/', '/console/', '/docs/', '/playground/', '/status/', '/style.css']) {
    const h = headersFor(text, path)
    assert.deepEqual(h['x-frame-options'], ['DENY'], path)
    assert.deepEqual(h['x-content-type-options'], ['nosniff'], path)
    assert.deepEqual(h['referrer-policy'], ['no-referrer'], path)
    assert.deepEqual(h['strict-transport-security'], ['max-age=31536000'], path)
  }
  assert.equal(headersFor(text, '/style.css')['content-security-policy'], undefined, '/* sets no CSP, so no page gets two')
  // Every page directory in site/ (and the homepage) forbids framing with exactly one policy; only the console restricts scripts.
  // site/ 下每个页面目录（和首页）都恰好一条禁止嵌入的策略；只有操作台限制脚本。
  const pages = ['/', ...readdirSync(SITE, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(new URL(`${e.name}/index.html`, SITE))).map((e) => `/${e.name}/`), '/status/']
  for (const path of pages) {
    const p = headersFor(text, path)['content-security-policy']
    assert.equal(p?.length, 1, `${path} has exactly one CSP`)
    assert.ok(p[0].split(/;\s*/).includes("frame-ancestors 'none'"), path)
    if (path !== '/console/') assert.doesNotMatch(p[0], /script-src/, `${path} may have inline scripts`)
  }
})

test('the console warns against look-alike addresses and shows what the wallet will be asked to write', () => {
  const html = consoleHtml(), js = pageScript()
  assert.match(html, /id="phish"[\s\S]*https:\/\/tapeapi\.fun\/console\/[\s\S]*https:\/\/tapeapi\.fun\/console\//, 'the banner, in both languages')
  assert.ok(html.indexOf('id="phish"') < html.indexOf('id="s-wallet"'), 'above step 1')
  assert.match(js, /location\.origin !== 'https:\/\/tapeapi\.fun'/, 'a copy elsewhere says so')
  const pub = js.slice(js.indexOf("$('btn-publish').onclick"))
  const shown = pub.search(/kv\(out, \[\[bi\('容器', 'Container'\), s\.container\], \[bi\('清单 SHA-256', 'Manifest SHA-256'\), sha\]/)
  assert.ok(shown > 0 && shown < pub.indexOf("eth_sendTransaction"), 'the container and SHA-256 are on screen before the wallet asks')
  assert.match(js, /https:\/\/bscscan\.com\/tx\/\$\{hash\}/, 'transactions link to BscScan')
})

test('the console is bilingual, and the ChannelBus deployment is an optional section at the bottom', () => {
  const html = consoleHtml()
  const zh = (html.match(/<span lang="zh">/g) || []).length, en = (html.match(/<span lang="en">/g) || []).length
  assert.ok(zh > 20 && zh === en, `every Chinese text has an English twin (${zh} / ${en})`)
  const steps = [...html.matchAll(/<h2><span lang="zh">(\d)\. [^<]+<\/span><span lang="en">(\d)\. /g)].map((m) => [m[1], m[2]])
  assert.deepEqual(steps, [['1', '1'], ['2', '2'], ['3', '3'], ['4', '4'], ['5', '5']])
  const adv = html.indexOf('<details id="s-advanced">')
  assert.ok(adv > html.indexOf('id="s-publish"'), 'after the last step')
  assert.ok(html.indexOf('id="s-bus"') > adv && html.indexOf('id="s-verify"') > adv && html.indexOf('</details>') > html.indexOf('id="s-verify"'))
  assert.ok(html.includes(MAINNET.channelBus), 'names the public ChannelBus')
  assert.match(readFileSync(new URL('console/lang.js', SITE), 'utf8'), /'tapeapi\.lang'/, 'the same remembered choice as the homepage')
  // No step number left over from the old seven-step page. / 不残留旧七步页面的步骤号。
  assert.doesNotMatch(html + pageScript(), /第 [67] 步|step [67]\b/i)
})

// ---------------------------------------------------------------- renewal: the key already on chain ----
// Renewing a delegation signs for the SAME service key, which the page may not have generated (the owner set up another
// service since, or the browser was cleared). The page reads the manifest already in the container, as a client does,
// and signs only for a signer whose on-chain delegation recovers to the current holder. / 续期为**同一把**服务密钥签名，
// 这把密钥可能不是本页生成的。页面像客户端一样读容器里已有的清单，只为链上委托恢复出当前持有人的签名地址签名。
const HOLDER_KEY = '0x' + '11'.repeat(32), holder = privateKeyToAddress(HOLDER_KEY)
const circuit = { circuits, tokenId: '1', container: container.toLowerCase(), holder: holder.toLowerCase() }   // as readCircuit returns it / 与 readCircuit 返回的一致
const RELAY = 'https://relay.tapeapi.fun'
const onChainText = ({ key = HOLDER_KEY, signer: sg = signer, exp = expires, endpoint = `${RELAY}/tapeapi/v1`, ...rest } = {}) =>
  C.manifestText({ ...S, signer: sg, expires: exp, sig: sig.signDigest(sig.delegationDigest(56, MAINNET.hub, { container, signer: sg, expires: exp }), key), endpoint, ...rest })
const sha256 = async (b) => createHash('sha256').update(b).digest('hex')
// eth_call through the SDK's fake chain, as the wallet's node would answer it. / 经 SDK 的假链做 eth_call，如同钱包的节点。
const { createFakeChain } = await import('./helpers/fake-chain.mjs')
const chainCall = (chain, seen = []) => async (to, data) => {
  seen.push({ to, data })
  const r = await (await chain.fetch('http://rpc', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }) })).json()
  if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code })
  return r.result
}

test('readManifestFile reads the manifest on chain as the SDK does: fileInfo, read, exact length and SHA-256', async () => {
  for (const name of ['fileInfo', 'read']) assert.equal(C.SEL[name], abi.selector(name), name)
  const chain = createFakeChain(), seen = [], text = onChainText()
  assert.equal(await C.readManifestFile(chainCall(chain, seen), container, sha256), null, 'no manifest: fileInfo.size = 0')
  chain.writeFile(container, MANIFEST_KEY, text)
  assert.equal(await C.readManifestFile(chainCall(chain, seen), container, sha256), text)
  assert.deepEqual(seen.slice(-2).map((x) => x.to), [C.SITE_REGISTRY, C.SITE_REGISTRY])
  assert.equal(seen.at(-2).data, abi.encodeCall('fileInfo', [container, MANIFEST_KEY]).toLowerCase())
  assert.equal(seen.at(-1).data, abi.encodeCall('read', [container, MANIFEST_KEY]).toLowerCase())
  // A manifest written in several chunks (appendChunk) is still readable: renewal republishes the page's own bytes.
  // 分块写入的较大清单照样能读：续期发布的是页面自己的字节。
  const big = JSON.stringify({ ...JSON.parse(text), pad: 'x'.repeat(30_000) })
  chain.writeFile(container, MANIFEST_KEY, big)
  assert.equal(await C.readManifestFile(chainCall(chain), container, sha256), big)
  // A bad file on chain is UNVERIFIABLE (the page then allows only a fresh setup, which replaces it); a failing call is
  // not, and stays an error to retry. / 链上坏文件标为 UNVERIFIABLE（页面此时只允许新密钥设置，由它替换）；调用失败不标记，照常重试。
  const refused = {
    'bytes that do not hash to the index': () => { chain.writeFile(container, MANIFEST_KEY, text); chain.setFileBytes(container, MANIFEST_KEY, text.replace('"1"', '"2"')) },
    'a truncated read': () => { chain.writeFile(container, MANIFEST_KEY, text); chain.setFileBytes(container, MANIFEST_KEY, text.slice(0, -1)) },
    'no SHA-256 on chain': () => { chain.writeFile(container, MANIFEST_KEY, text); chain.setFileInfo(container, MANIFEST_KEY, { sha256Hash: '0x' + '00'.repeat(32) }) },
    'over 64 KiB': () => { chain.writeFile(container, MANIFEST_KEY, 'x'.repeat(64 * 1024 + 1)) },
    'not UTF-8': () => { chain.writeFile(container, MANIFEST_KEY, Uint8Array.of(0xff, 0xfe, 0x7b)) },
  }
  for (const [what, arrange] of Object.entries(refused)) { arrange(); await assert.rejects(C.readManifestFile(chainCall(chain), container, sha256), { code: 'UNVERIFIABLE' }, what) }
  await assert.rejects(C.readManifestFile(async () => '0x1234', container, sha256), { code: 'UNVERIFIABLE', message: /ABI/ }, 'a garbled answer')
  chain.writeFile(container, MANIFEST_KEY, text); chain.setFileBytes(container, MANIFEST_KEY, null)
  await assert.rejects(C.readManifestFile(chainCall(chain), container, sha256), (e) => e.code !== 'UNVERIFIABLE', 'read() failing is a call error')
  await assert.rejects(C.readManifestFile(async () => { throw new Error('node down') }, container, sha256), (e) => e.code === undefined && /node down/.test(e.message))
})

test('onChainAuthorisation: the signer of a delegation that recovers to the CURRENT holder, for this circuit only', () => {
  const a = C.onChainAuthorisation(onChainText(), circuit)
  assert.deepEqual(a, { ok: true, signer, endpoints: [`${RELAY}/tapeapi/v1`], expires })
  assert.deepEqual(C.onChainAuthorisation(onChainText({ exp: 1000 }), circuit).ok, true, 'an expired delegation is still the holder\'s: renewing it is the point')
  assert.deepEqual(C.onChainAuthorisation(null, circuit), { ok: false, code: 'NO_MANIFEST' })
  const other = privateKeyToAddress('0x' + '33'.repeat(32))
  assert.deepEqual(C.onChainAuthorisation(onChainText({ key: '0x' + '33'.repeat(32) }), circuit), { ok: false, code: 'NOT_HOLDER', detail: other }, 'a previous holder\'s delegation')
  assert.equal(C.onChainAuthorisation(onChainText(), { ...circuit, holder: other }).code, 'NOT_HOLDER', 'the circuit changed hands')
  assert.equal(C.onChainAuthorisation(onChainText(), { ...circuit, tokenId: '2' }).code, 'WRONG_CIRCUIT')
  assert.equal(C.onChainAuthorisation(onChainText(), { ...circuit, container: '0x' + '61'.repeat(20) }).code, 'WRONG_CIRCUIT')
  const good = JSON.parse(onChainText())
  // The same holder's signature over another signer or another expiry does not carry over. / 同一持有人对别的签名地址或别的到期的签名不能挪用。
  assert.equal(C.onChainAuthorisation(JSON.stringify({ ...good, signer: '0x' + '99'.repeat(20) }), circuit).code, 'NOT_HOLDER')
  assert.equal(C.onChainAuthorisation(JSON.stringify({ ...good, delegation: { ...good.delegation, expires: expires + 1 } }), circuit).code, 'NOT_HOLDER')
  const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n, g = good.delegation.sig
  const high = g.slice(0, 66) + (N - BigInt('0x' + g.slice(66, 130))).toString(16).padStart(64, '0') + (parseInt(g.slice(130), 16) === 27 ? '1c' : '1b')
  assert.equal(C.onChainAuthorisation(JSON.stringify({ ...good, delegation: { ...good.delegation, sig: high } }), circuit).code, 'BAD_SIGNATURE', 'high s, as every client refuses it')
  for (const [what, m] of Object.entries({
    'not JSON': 'nope', array: '[]', 'major 1': JSON.stringify({ ...good, tapeapi: '1.0' }), 'no delegation': JSON.stringify({ ...good, delegation: undefined }),
    'fractional expiry': JSON.stringify({ ...good, delegation: { ...good.delegation, expires: 1.5 } }), 'short sig': JSON.stringify({ ...good, delegation: { ...good.delegation, sig: '0x00' } }),
    'no endpoints': JSON.stringify({ ...good, endpoints: { live: [], async: false } }), 'tokenId 01': JSON.stringify({ ...good, tokenId: '01' }), 'signer not an address': JSON.stringify({ ...good, signer: 'me' }),
  })) assert.equal(C.onChainAuthorisation(m, circuit).code, 'INVALID', what)
})

test('decideSigner: renewal signs only for the holder-authorised key on chain, and never weakens the fresh-key path', () => {
  const fresh = C.addressOfKey(C.newSignerKey())
  const ask = (o) => C.decideSigner({ text: onChainText(), circuit, base: RELAY, health: { ok: true, signer }, keyAddress: fresh, renew: true, moved: false, ...o })
  // Happy renewal: the relay's key is on chain, the page's stored key is another service's. / 正常续期：页面记着的是别的服务的密钥。
  const ok = ask()
  assert.equal(ok.ok, true); assert.equal(ok.mode, 'renew'); assert.equal(ok.signer, signer)
  assert.equal(ask({ keyAddress: undefined }).signer, signer, 'a cleared browser can renew')
  assert.equal(ask({ health: { signer: signer.toLowerCase() }, base: 'https://Relay.tapeapi.fun' }).ok, true, 'address and host case do not matter')
  assert.equal(ask({ text: onChainText({ exp: 1000 }) }).ok, true, 'an expired delegation can be renewed')
  // The on-chain delegation is not from the current holder: no renewal, fresh setup still works at any URL.
  // 链上委托不是当前持有人签的：不能续期；新密钥设置照常，网址不受限制。
  const prev = onChainText({ key: '0x' + '33'.repeat(32) })
  assert.equal(ask({ text: prev }).code, 'NOT_HOLDER')
  assert.equal(ask({ text: prev, renew: false, base: 'https://new.example', health: { signer: fresh } }).mode, 'fresh')
  // The service reports another signer: refused, and that address is never the one returned. / 服务报出别的地址：拒绝。
  const evil = privateKeyToAddress('0x' + '44'.repeat(32))
  assert.deepEqual([ask({ health: { signer: evil } }).code, ask({ health: { signer: evil } }).signer], ['SIGNER_MISMATCH', signer])
  assert.equal(ask({ health: { signer: fresh } }).code, 'SIGNER_MISMATCH', 'renewal does not sign for the page\'s own key either')
  // Endpoint mismatch: refused on both paths unless "moved"; with "moved" only the fresh key. / 网址不一致：两条路都拒绝，除非勾“已搬家”，此时只能用新密钥。
  const moved = { base: 'https://api.tapeapi.fun' }
  assert.deepEqual(ask(moved).code, 'ENDPOINT_MISMATCH'); assert.deepEqual(ask(moved).endpoints, [`${RELAY}/tapeapi/v1`])
  assert.equal(ask({ ...moved, renew: false, health: { signer: fresh } }).code, 'ENDPOINT_MISMATCH', 'the fresh path too')
  assert.equal(ask({ ...moved, moved: true }).code, 'MOVED')
  assert.equal(ask({ moved: true }).code, 'MOVED', 'ticking "moved" turns renewal off even at the same URL')
  assert.deepEqual(ask({ ...moved, moved: true, renew: false, health: { signer: fresh } }), { ok: true, mode: 'fresh', signer: fresh, onChain: C.onChainAuthorisation(onChainText(), circuit) })
  assert.equal(ask({ base: 'https://relay.tapeapi.fun.evil.example' }).code, 'ENDPOINT_MISMATCH', 'a look-alike host')
  // No manifest on chain: fresh setup only. / 链上没有清单：只能新密钥设置。
  assert.equal(ask({ text: null }).code, 'NO_MANIFEST')
  assert.equal(ask({ text: null, renew: false, base: 'https://api.tapeapi.fun', health: { signer: fresh } }).mode, 'fresh')
  // The fresh path is exactly review F1: only the generated key, only when the service reports it.
  // 新密钥路径就是审查 F1：只为生成的密钥签，且服务报出的正是它。
  assert.equal(ask({ renew: false, health: { signer } }).code, 'KEY_MISMATCH', 'the on-chain key is not signed on the fresh path')
  assert.equal(ask({ renew: false, keyAddress: undefined, health: { signer } }).code, 'NO_KEY')
  for (const health of [null, {}, [], { signer: 'x' }, { signer: fresh.slice(0, 41) }]) assert.equal(ask({ health }).code, 'NO_SIGNER')
  for (const base of ['http://relay.tapeapi.fun', 'https://relay.tapeapi.fun/x', 'https://a@relay.tapeapi.fun']) assert.equal(ask({ base }).code, 'BAD_URL', base)
  // Whatever the answers, an authorised signer is the on-chain one (renew) or the generated one (fresh), nothing else.
  // 不论怎样回答，能被授权的只有链上那个（续期）或生成的那个（新密钥）。
  for (const renew of [true, false]) for (const hs of [signer, fresh, evil]) for (const text of [onChainText(), prev, null]) {
    const d = ask({ renew, health: { signer: hs }, text })
    if (d.ok) assert.equal(d.signer, renew ? signer : fresh, `${renew} ${hs}`)
  }
})

test('renewal end to end on the fake chain: what the page publishes after renewing is a manifest a client accepts', async () => {
  const chain = createFakeChain()
  chain.writeFile(container, MANIFEST_KEY, onChainText({ exp: Math.floor(Date.now() / 1000) + 3600 }))
  const text = await C.readManifestFile(chainCall(chain), container, sha256)
  const d = C.decideSigner({ text, circuit, base: RELAY, health: { signer }, keyAddress: C.addressOfKey(C.newSignerKey()), renew: true })
  assert.equal(d.signer, signer)
  const exp = Math.floor(Date.now() / 1000) + 90 * 86400
  assert.deepEqual(C.delegationTypedData({ container: circuit.container, signer: d.signer, expires: exp }), sig.delegationTypedData(56, MAINNET.hub, { container: circuit.container, signer, expires: exp }))
  const renewed = sig.signDigest(C.delegationDigest({ container: circuit.container, signer: d.signer, expires: exp }), HOLDER_KEY)
  assert.equal(C.recoverAddress(C.delegationDigest({ container: circuit.container, signer: d.signer, expires: exp }), renewed), holder)
  const out = C.manifestText({ ...S, container: circuit.container, signer: d.signer, expires: exp, sig: renewed, endpoint: `${RELAY}/tapeapi/v1` })
  const { validateManifest } = await import('../src/manifest.js')
  assert.doesNotThrow(() => validateManifest(JSON.parse(out), { requireDelegation: true }))
  assert.equal(C.onChainAuthorisation(out, circuit).ok, true, 'and it can be renewed again next time')
})

test('the page: step 4 re-reads the chain, renewal signs only lib\'s decision, and the choice is explained in both languages', () => {
  const js = pageScript(), html = consoleHtml()
  const sign = js.slice(js.indexOf('async function signDelegation(renew)'), js.indexOf("$('btn-publish').onclick"))
  assert.match(sign, /try \{ text = await readOnChain\(s\) \} catch \(e\) \{\s*if \(renew \|\| e\.code !== 'UNVERIFIABLE'\) throw e/, 'only the fresh path goes on past an unverifiable file on chain, as if there were none')
  assert.match(sign, /C\.decideSigner\(\{ text, circuit: s, base, health: h, keyAddress: s\.keyAddress, renew, moved: \$\('moved'\)\.checked \}\)/)
  assert.ok(sign.indexOf('await readOnChain(s)') < sign.indexOf("h.signer.toLowerCase() !== s.keyAddress.toLowerCase()"), 'the chain is read before the F1 refusal, so it can point to renewal')
  assert.ok(sign.indexOf('C.decideSigner(') < sign.indexOf('await ensureSame()'), 'decided before the wallet is asked')
  assert.match(sign, /if \(!d\.ok\) \{[\s\S]*?return\s*\}/, 'a refusal stops before signing')
  assert.match(sign, /renew \? C\.delegationTypedData\(\{ container: s\.container, signer: d\.signer, expires \}\) : C\.delegationTypedData\(\{ container: s\.container, signer: s\.keyAddress, expires \}\)/)
  assert.match(sign, /C\.recoverAddress\(C\.delegationDigest\(\{ container: s\.container, signer: d\.signer, expires \}\), sig\)/)
  assert.doesNotMatch(js, /signer: (h|health)\.signer/, 'the health answer never becomes the signer')
  assert.match(js, /readManifestFile\(call, s\.container, sha256Hex\)/, 'the manifest is read from the chain, not the service')
  assert.match(js, /\$\('btn-renew'\)\.disabled = [^\n]*\$\('moved'\)\.checked/, '"moved" turns the renew button off')
  for (const id of ['renew-box', 'moved', 'btn-renew']) assert.match(html, new RegExp(`id="${id}"`), id)
  const box = html.slice(html.indexOf('id="renew-box"'), html.indexOf('id="deleg-out"'))
  assert.ok(box.includes('<span lang="zh">') && (box.match(/<span lang="zh">/g) || []).length === (box.match(/<span lang="en">/g) || []).length)
  assert.match(box, /恢复出你（当前持有人）/); assert.match(box, /recovers to you, the current holder/)
})
