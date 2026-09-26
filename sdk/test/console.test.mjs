// The holder console at tapeapi.fun/console builds a delegation and a putFile transaction without the SDK (a static page
// for a phone wallet). Here every byte it builds is checked against the SDK. / 持有人操作台不依赖 SDK 构造委托与 putFile 交易；
// 这里逐字节对照 SDK 检查。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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

test('FIXED console-F1: the page stores the generated key\'s address and step 6 signs only for it', async () => {
  const { readFile } = await import('node:fs/promises')
  const html = await readFile(new URL('../../site/console/index.html', import.meta.url), 'utf8')
  assert.match(html, /saveSvc\(\{ keyAddress,/)
  assert.match(html, /h\.signer\.toLowerCase\(\) !== s\.keyAddress\.toLowerCase\(\)/)
  assert.match(html, /delegationTypedData\(\{ container: s\.container, signer: s\.keyAddress,/)
  assert.doesNotMatch(html, /signer: h\.signer/)
  assert.match(html, /C\.manifestText\(/, 'step 7 publishes the page\'s own bytes')
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
  const { readFile } = await import('node:fs/promises')
  const html = await readFile(new URL('../../site/console/index.html', import.meta.url), 'utf8')
  assert.match(html, /eth\?\.on\?\.\('accountsChanged', \(\) => location\.reload\(\)\)/)
  assert.match(html, /eth\?\.on\?\.\('chainChanged', \(\) => location\.reload\(\)\)/)
  assert.equal((html.match(/await ensureSame\(\)/g) || []).length, 4, 'before the deploy, the test message, the signature and the putFile')
  assert.equal((html.match(/chainId: BSC,/g) || []).length, 3, 'every transaction names the chain')
  assert.match(html, /C\.recoverAddress\(C\.delegationDigest\(/)
  assert.ok(html.indexOf("if (cid !== BSC)") < html.indexOf('account = accs[0]'), 'the account is kept only once the chain is right')
  assert.match(html, /eth_getCode', \[c\.container/, 'step 4 refuses an unopened container')
  assert.match(html, /30cd7471/, 'step 7 translates NotOwner from the pre-flight estimate')
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
  const { readFileSync } = await import('node:fs')
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
  const html = readFileSync(new URL('../../site/console/index.html', import.meta.url), 'utf8')
  assert.match(html, /sm\.methods\.map\(\(x\) => x\.name\)/, 'step 7 names every method before the wallet asks')
})
