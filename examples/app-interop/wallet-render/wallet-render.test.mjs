// examples/app-interop/wallet-render: the page asks a wallet to sign exactly what the SDK builds, says what it is at the
// top, calls only the three wallet methods it names, makes no network request, and its result checker accepts a real
// signature over the shown payload and refuses anything else. Static checks plus a local server: no browser, no wallet.
// 测试页签的正是 SDK 生成的数据；顶部写明是什么；只调用它写明的三个钱包方法；不联网；结果核对器接受对所示载荷的真签名、拒绝其他。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { sig } from '@tapeapi/sdk'
import { grantDigest, grantRevocationDigest, grantForWallet, STATEMENT_TEMPLATES } from '@tapeapi/interop'
import { buildPayloads, payloadsSource, CHAIN_ID, HUB, PLACEHOLDER_USER } from './make-payloads.mjs'
import { checkResult } from './check-result.mjs'
import { startServer } from './serve.mjs'

const read = (f) => readFileSync(new URL(f, import.meta.url), 'utf8')
const code = (f) => read(f).replace(/\/\*[^]*?\*\/|\/\/[^\n]*/g, '')

test('payloads.js is exactly what make-payloads.mjs builds from @tapeapi/interop (regenerate with node make-payloads.mjs)', () => {
  assert.equal(read('payloads.js'), payloadsSource())
})

test('every payload is the SDK\'s own typed data: grantForWallet accepts it, the statement is the first field and the v1 rendering, the domain is "TapeAPI Visitor Grant" on chain 56 with the hub', () => {
  const ps = buildPayloads()
  assert.deepEqual(ps.map((p) => p.id), ['v1-en', 'v1-zh', 'v1-en-max', 'revocation'])
  for (const p of ps) {
    const td = p.typedData
    assert.deepEqual(td.domain, { name: 'TapeAPI Visitor Grant', version: '1', chainId: CHAIN_ID, verifyingContract: HUB })
    const out = grantForWallet(td, { chainId: CHAIN_ID, hub: HUB, callerName: '12.7.tape', audienceName: '13.7.tape' })
    assert.deepEqual(out.payload, td)
    if (td.primaryType === 'VisitorGrant') {
      assert.equal(td.types.VisitorGrant[0].name, 'statement')
      assert.equal(td.message.statement, STATEMENT_TEMPLATES[p.id === 'v1-zh' ? 'zh' : 'en'](td.message))
      // the visitor is a placeholder the page replaces: the statement names no address, so it does not change
      assert.equal(td.message.user.toLowerCase(), PLACEHOLDER_USER)
      assert.doesNotMatch(td.message.statement, /0x[0-9a-fA-F]{6}/)
    }
  }
  const max = ps.find((p) => p.id === 'v1-en-max').typedData.message
  assert.equal(max.methods.length, 8)
  assert.equal(Math.max(...max.methods.map((m) => m.length)), 64)
  assert.equal(max.maxCalls, 10_000)
  assert.equal(max.expires - max.notBefore, 7 * 86400)
})

test('the page says what it is at the top, claims nothing, and calls only eth_requestAccounts, eth_chainId and eth_signTypedData_v4; no network, no transaction, no balance, no network switch', () => {
  const html = read('index.html')
  const top = html.slice(html.indexOf('<body>'), html.indexOf('<h1>'))
  assert.match(top, /实验性原型，不是 TAP，不发送任何交易/)
  assert.match(top, /Experimental prototype\. Not a TAP\. Sends no transaction\./)
  const js = code('app.js')
  const methods = [...js.matchAll(/method:\s*'([^']+)'/g)].map((m) => m[1]).sort()
  assert.deepEqual([...new Set(methods)], ['eth_chainId', 'eth_requestAccounts', 'eth_signTypedData_v4'])
  for (const f of ['app.js', 'payloads.js']) {
    assert.doesNotMatch(code(f), /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|eth_send|eth_getBalance|wallet_|personal_sign|eth_sign'|importScripts|\bimport\s*\(/, f)
  }
  // no external resource of any kind: every src / href is one of the page's own files / 无任何外部资源
  const refs = [...html.matchAll(/\b(?:src|href)\s*=\s*"([^"]*)"/g)].map((m) => m[1])
  assert.deepEqual(refs.sort(), ['app.js', 'payloads.js'])
  assert.doesNotMatch(html + read('app.js'), /https?:\/\/(?!localhost)/)
  // no claim of endorsement / 不声称任何认证、合作
  for (const f of ['index.html', 'app.js', 'CHECKLIST.zh.md']) assert.doesNotMatch(read(f), /\b(?:certified|endorsed|partner(?:ship)?|official|audited|approved by)\b|认证通过|官方认可|合作伙伴|已审计/i, f)
})

test('the result checker: a signature over the shown payload (user = the account) is OK; another account or signer, another variant, a changed field or an unsigned result is NOT OK', () => {
  const key = '0x' + '6d'.repeat(32), account = sig.privateKeyToAddress(key).toLowerCase()
  for (const p of buildPayloads()) {
    const td = JSON.parse(JSON.stringify(p.typedData)); td.message.user = account
    const digest = td.primaryType === 'VisitorGrant' ? grantDigest(CHAIN_ID, HUB, td.message) : grantRevocationDigest(CHAIN_ID, HUB, td.message)
    const rec = { page: 'wallet-render/1', variant: p.id, account, typedData: JSON.stringify(td, null, 2), signature: sig.signDigest(digest, key) }
    assert.equal(checkResult(rec).ok, true, `${p.id}: ${checkResult(rec).why}`)
    assert.equal(checkResult({ ...rec, account: sig.privateKeyToAddress('0x' + '6e'.repeat(32)) }).ok, false, 'another account')
    assert.equal(checkResult({ ...rec, signature: sig.signDigest(digest, '0x' + '6e'.repeat(32)) }).ok, false, 'signed by someone else')
    assert.equal(checkResult({ ...rec, variant: p.id === 'v1-en' ? 'v1-zh' : 'v1-en' }).ok, false, 'another variant')
    const changed = JSON.parse(rec.typedData); changed.domain.chainId = 97
    assert.equal(checkResult({ ...rec, typedData: JSON.stringify(changed) }).ok, false, 'a changed field')
    assert.equal(checkResult({ ...rec, signature: undefined, error: { code: 4001, message: 'User rejected the request.' } }).ok, false, 'unsigned')
  }
})

test('serve.mjs serves the three files on 127.0.0.1 and nothing else (not this test, not the generator, no directory listing)', async () => {
  const server = await startServer(0)
  try {
    const base = `http://127.0.0.1:${server.address().port}`
    for (const p of ['/', '/index.html', '/app.js', '/payloads.js']) assert.equal((await fetch(base + p)).status, 200, p)
    for (const p of ['/wallet-render.test.mjs', '/make-payloads.mjs', '/serve.mjs', '/CHECKLIST.zh.md', '/../world.mjs', '/%2e%2e/world.mjs']) assert.equal((await fetch(base + p)).status, 404, p)
    assert.equal((await fetch(base + '/', { method: 'POST' })).status, 404)
    assert.equal(server.address().address, '127.0.0.1')
  } finally { await new Promise((r) => server.close(r)) }
})

test('the folder names no person and no internal file (it sits under examples/, which a public copy would take)', () => {
  // written in pieces so that this file does not match itself / 分段书写，本文件不匹配自己
  const internal = new RegExp(['\\bBru' + 'ce\\b', '\\/Us' + 'ers\\/', 'road' + 'map-', '01-inter' + 'op', 'interop' + '-plan', 'final' + '-design', '\\bwi' + 'p\\/', 'DESI' + 'GN-[\\w-]+', '\\bBl' + 'on'].join('|'))
  for (const f of readdirSync(new URL('.', import.meta.url))) assert.doesNotMatch(read(f), internal, f)
})
