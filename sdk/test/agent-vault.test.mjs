// Container agents phase 1, restart (experimental, internal; the internal phase-1 draft §10.9): the key vault an agent
// runtime keeps its session keys in across a restart. The vectors (phase1.keyVault, by hand in scripts/gen-vectors.mjs)
// are checked here against the SDK and, for scrypt, against Node's own OpenSSL implementation (node:crypto), which shares
// no code with @noble; verify.py checks the AEAD step in Python (and scrypt where its Python has hashlib.scrypt).
// Named FIXED P1RS-V*; each was checked by removing what implements it.
// 阶段 1 的重启：钥匙保险箱。向量与 SDK 比对，scrypt 另与 Node 自带的 OpenSSL 实现（node:crypto，与 @noble 无共用代码）比对。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { scryptSync } from 'node:crypto'
import * as agent from '../src/agent-public.js'
import { privateKeyToAddress } from '../src/sig.js'

const v = JSON.parse(readFileSync(new URL('../../spec/vectors/container-agent.json', import.meta.url), 'utf8')).phase1.keyVault
const h2b = (h) => Uint8Array.from(Buffer.from(h, 'hex'))
const b2h = (b) => Buffer.from(b).toString('hex')
const vaultErr = (reason) => (e) => { assert.equal(e.code, 'AGENT_KEY_VAULT', e.message); assert.equal(e.data?.reason, reason, e.message); return true }
const PASS = 'correct horse battery staple'

test('FIXED P1RS-V1: the key-vault parameters are the constants the vectors state', () => {
  assert.deepEqual({ ...agent.KEY_VAULT_SCRYPT }, { N: 131072, r: 8, p: 1, dkLen: 32 })
  assert.equal(Object.isFrozen(agent.KEY_VAULT_SCRYPT), true)
  assert.deepEqual(v.params, { ...agent.KEY_VAULT_SCRYPT, saltBytes: agent.KEY_VAULT_SALT_BYTES, nonceBytes: agent.KEY_VAULT_NONCE_BYTES, prefix: agent.KEY_VAULT_PREFIX, minPassphrase: agent.KEY_VAULT_MIN_PASSPHRASE })
  assert.equal(agent.spendKeyContext(56, '0xAe72A48c1a36bd18Af168541c53037965d26e4A8'), 'tapeapi-spend-key/v1/56/0xae72a48c1a36bd18af168541c53037965d26e4a8')
})

test('FIXED P1RS-V2: every phase1.keyVault seal vector: scrypt (the SDK and node:crypto agree), the associated data, the blob, and it opens', async () => {
  for (const c of v.seal) {
    const key = await agent.keyVaultKey(c.passphrase, h2b(c.salt))
    assert.equal(b2h(key), c.key, c.name)
    const { N, r, p, dkLen } = agent.KEY_VAULT_SCRYPT
    assert.equal(b2h(scryptSync(Buffer.from(c.passphrase, 'utf8'), h2b(c.salt), dkLen, { N, r, p, maxmem: 2 ** 28 })), c.key, `${c.name}: node:crypto`)
    assert.equal(b2h(agent.keyVaultAad(c.context)), c.aad, c.name)
    assert.equal(agent.keyVaultSeal(key, { salt: h2b(c.salt), nonce: h2b(c.nonce), context: c.context, plaintext: h2b(c.plaintext) }), c.blob, c.name)
    assert.equal(b2h(agent.keyVaultOpen(key, c.blob, { context: c.context })), c.plaintext, c.name)
  }
})

test('FIXED P1RS-V3: every phase1.keyVault open vector: it opens, or fails with key-vault-open-failed or key-vault-malformed, and never yields bytes', () => {
  for (const c of v.open) {
    if (c.expect === 'ok') { assert.ok(agent.keyVaultOpen(h2b(c.key), c.blob, { context: c.context }) instanceof Uint8Array, c.name); continue }
    if (c.key === null) assert.throws(() => agent.keyVaultParse(c.blob), vaultErr(c.expect), c.name)
    else assert.throws(() => agent.keyVaultOpen(h2b(c.key), c.blob, { context: c.context }), vaultErr(c.expect), c.name)
  }
})

test('FIXED P1RS-V4: passphraseKeyVault seals with a random nonce, opens in a new vault (a restart) with the same passphrase, and refuses a wrong passphrase or another context', async () => {
  const secret = h2b('5a'.repeat(32))
  const ctx = agent.spendKeyContext(56, privateKeyToAddress('0x' + '5a'.repeat(32)))
  const a = agent.passphraseKeyVault({ passphrase: PASS })
  const b1 = await a.seal(secret, { context: ctx }), b2 = await a.seal(secret, { context: ctx })
  assert.notEqual(b1, b2, 'a random nonce per blob')
  assert.ok(b1.startsWith(agent.KEY_VAULT_PREFIX))
  for (const b of [b1, b2]) {
    assert.equal(b.toLowerCase().includes('5a'.repeat(32)), false, 'the plaintext is not in the blob')
    assert.equal(b.includes(Buffer.from(secret).toString('base64')), false)
  }
  const restarted = agent.passphraseKeyVault({ passphrase: PASS })
  assert.equal(b2h(await restarted.open(b1, { context: ctx })), b2h(secret))
  // a random salt per vault: two vaults on one passphrase derive two keys / 每个保险箱一个随机盐
  const b3 = await restarted.seal(secret, { context: ctx })
  assert.notEqual(b2h(agent.keyVaultParse(b3).salt), b2h(agent.keyVaultParse(b1).salt))
  assert.equal(b2h(agent.keyVaultParse(b1).salt), b2h(agent.keyVaultParse(b2).salt), 'one salt within a vault (scrypt runs once)')
  const wrong = agent.passphraseKeyVault({ passphrase: PASS + '!' })
  await assert.rejects(wrong.open(b1, { context: ctx }), vaultErr('key-vault-open-failed'))
  await assert.rejects(restarted.open(b1, { context: agent.spendKeyContext(56, '0x' + '11'.repeat(20)) }), vaultErr('key-vault-open-failed'))
  await assert.rejects(restarted.open(b1, { context: agent.spendKeyContext(97, privateKeyToAddress('0x' + '5a'.repeat(32))) }), vaultErr('key-vault-open-failed'), 'another chain is another context')
  await assert.rejects(restarted.open(b1.slice(0, -2) + (b1.endsWith('00') ? '01' : '00'), { context: ctx }), vaultErr('key-vault-open-failed'))
  await assert.rejects(restarted.open('{"secret":"0x00"}', { context: ctx }), vaultErr('key-vault-malformed'))
})

test('FIXED P1RS-V5: a passphrase shorter than KEY_VAULT_MIN_PASSPHRASE, or no context, is an argument error', async () => {
  assert.throws(() => agent.passphraseKeyVault({}), (e) => e.code === 'INVALID_ARGUMENT')
  assert.throws(() => agent.passphraseKeyVault({ passphrase: 'short' }), (e) => e.code === 'INVALID_ARGUMENT' && /12/.test(e.message))
  const a = agent.passphraseKeyVault({ passphrase: PASS })
  await assert.rejects(a.seal(new Uint8Array(32), {}), (e) => e.code === 'INVALID_ARGUMENT')
  await assert.rejects(a.seal('0x' + '11'.repeat(32), { context: 'x' }), (e) => e.code === 'INVALID_ARGUMENT', 'bytes, never a hex string')
})

test('FIXED P1RR-08: a blob\'s form and length are checked before any KDF runs; at most 4 MiB is sealed, and a longer blob is malformed', async () => {
  const MAX = 4 * 1024 * 1024
  const ctx = agent.spendKeyContext(56, privateKeyToAddress('0x' + '5a'.repeat(32)))
  const key = new Uint8Array(32).fill(7), salt = new Uint8Array(16), nonce = new Uint8Array(24)
  assert.throws(() => agent.keyVaultSeal(key, { salt, nonce, context: ctx, plaintext: new Uint8Array(MAX + 1) }), (e) => e.code === 'INVALID_ARGUMENT' && /at most/.test(e.message))
  const atMost = agent.keyVaultSeal(key, { salt, nonce, context: ctx, plaintext: new Uint8Array(MAX) })
  assert.equal(agent.keyVaultOpen(key, atMost, { context: ctx }).length, MAX, '4 MiB exactly is sealed and opens')
  const tooLong = agent.KEY_VAULT_PREFIX + '00'.repeat(16 + 24 + 16 + MAX + 1)
  assert.throws(() => agent.keyVaultParse(tooLong), vaultErr('key-vault-malformed'))
  await assert.rejects(agent.passphraseKeyVault({ passphrase: PASS }).seal(new Uint8Array(MAX + 1), { context: ctx }), (e) => e.code === 'INVALID_ARGUMENT')
  // a fresh vault (no key derived yet) refuses a malformed or overlong blob without running scrypt: in well under one
  // derivation (half of it, so that a loaded machine does not make it flaky; a scrypt would take about all of it)
  // 新保险箱（尚未派生密钥）拒绝格式错或过长的密文，不跑 scrypt：远少于一次派生（取一半，机器繁忙时也不误报；跑 scrypt 约需全部）
  const t0 = performance.now(); await agent.keyVaultKey(PASS, new Uint8Array(16)); const kdf = performance.now() - t0
  for (const blob of [tooLong, agent.KEY_VAULT_PREFIX + 'zz'.repeat(60), 'not a blob']) {
    const fresh = agent.passphraseKeyVault({ passphrase: PASS })
    const t1 = performance.now()
    await assert.rejects(fresh.open(blob, { context: ctx }), vaultErr('key-vault-malformed'))
    assert.ok(performance.now() - t1 < kdf / 2, `refused in ${(performance.now() - t1).toFixed(1)} ms; one scrypt takes ${kdf.toFixed(1)} ms`)
  }
})
