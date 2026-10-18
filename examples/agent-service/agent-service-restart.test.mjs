// examples/agent-service, phase 1, restart (EXPERIMENTAL, local chains only; the internal phase-1 draft §10.9): a spend
// order survives a restart of the agent's process. Its agent key is kept sealed (scrypt + XChaCha20-Poly1305) in a file
// store (state.mjs, 0600 files in a 0700 directory); a new runtime over the same directory resumes it (recover) and goes
// on paying and delivering, the total never above the cap. A restart never resumes an order that was revoked, whose
// provider moved, or whose sealed key does not open (a wrong passphrase, a changed or swapped file): it fails closed. The
// key is nowhere in the clear on disk, and it is destroyed when the order ends. On the SDK's fake chain with the escrow
// modelled, as agent-service-spend.test.mjs. Named FIXED P1RS-Exx; each was checked by removing what implements it.
// 阶段 1 的重启：spend 单跨代理进程重启。钥匙以密文保存在文件存储里（0600 文件、0700 目录）；同一目录上的新运行时恢复它（recover）
// 并继续付费与交付，总额不超过 cap。被撤销、provider 换了托管、密文打不开（错口令、文件被改或被换）的单绝不恢复：失败关闭。
// 磁盘上任何地方都没有明文钥匙，订单结束即销毁。
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, hostname } from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { abi } from '@tapeapi/sdk'
import { passphraseKeyVault, spendKeyContext } from '@tapeapi/sdk/agent'
import { createDemoWorld, restoreTime, KEYS, AG, S } from './demo-world.mjs'
import { blockHeightTask } from './agent.mjs'
import { createFileStore, persistenceFromEnv, modeOf, PASSPHRASE_ENV, STATE_DIR_ENV, LOCK_FILE } from './state.mjs'
import { offerMsg, mandateOf, mandateMsg, addrOf, nowS, BEM_TOKEN, nameEscrow, escrowContract, revocationFile, revocationMsg } from '../../sdk/test/helpers/agent-chain.mjs'

const dirs = []
afterEach(() => { restoreTime(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const E1 = '0x00000000000000000000000000000000000E5C71', E2 = '0x00000000000000000000000000000000000E5c72'
const HOLDER = addrOf(KEYS.principalHolder)
const SETTLER = addrOf(KEYS.providerHolder)
const PRICE = 10_000n
const P1 = 'https://provider-1.example'
const PASS = 'correct horse battery staple'
const TASK = { kind: 'calls', spec: 'call the provider' }
const stateDir = () => { const d = mkdtempSync(join(tmpdir(), 'tapeapi-agent-state-')); dirs.push(d); return d }

// a vault that also tells the test which secrets it sealed (the runtime never shows them), so that the disk can be
// scanned for them; the order records it seals are kept apart (`records`) / 同时告诉测试封存了哪些密钥的保险箱，用来扫描磁盘；
// 它封存的订单记录另放（records）
function spyVault(passphrase = PASS) {
  const inner = passphraseKeyVault({ passphrase }), sealed = [], records = []
  return { sealed, records, seal: async (b, o) => { (o.context.startsWith('tapeapi-agent-order/') ? records : sealed).push(Buffer.from(b).toString('hex')); return inner.seal(b, o) }, open: (blob, o) => inner.open(blob, o) }
}
// a task that calls provider S `n` times in total over the order's life: after a restart only what is left (the receipts of
// the calls before it are kept); `freezeAt` (the first process only): the process "dies" before that call, its task
// waits forever / 整单共调用 S n 次；重启后只做剩下的。freezeAt：在那次调用之前进程"死掉"，任务永远等待
function callsTask(n, { freezeAt = null, frozen } = {}) {
  return {
    needsProviders: true,
    async run(task, ctx) {
      const results = []
      for (let i = ctx.resumed.calls; i < n; i++) {
        if (i === freezeAt) { frozen?.(); await new Promise(() => {}) }
        try { const r = await ctx.call(S, 'blockNumber', {}); results.push(Number.isSafeInteger(r?.blockNumber) ? 'ok' : 'bad') } catch (e) { results.push(e?.data?.reason ?? e?.code ?? 'error') }
      }
      return { kind: 'calls', results }
    },
  }
}
async function restartWorld({ cap = 5n * PRICE, n = 5, freezeAt = 3, vault = spyVault(), dir = stateDir(), wrap = (st) => st, tasks } = {}) {
  let frozen
  const isFrozen = new Promise((res) => { frozen = res })
  const store = wrap(createFileStore(dir))
  const w = await createDemoWorld({ spend: { escrow: E1, holderBalance: 10n ** 12n }, agentOptions: { tasks: tasks ?? { calls: callsTask(n, { freezeAt, frozen }) }, spend: { store, vault, maxCallPrice: PRICE.toString() } } })
  const svc = await w.principalApi.resolve(AG)
  // Root cause hunt for the flaky P1RS-E06 (review T-4): hire() got a signed INTERNAL "internal error" and the cause was
  // in the provider log, which the world discarded. A failed call now carries that log. / 追查 P1RS-E06 偶发：hire() 得到签名的
  // INTERNAL，原因在服务端日志里，而世界把日志丢了。失败的调用现在带上那段日志。
  const call = async (method, params) => {
    try { return await w.principalApi.call(await w.principalApi.resolve(AG), method, params) } catch (e) {
      if (w.providerLog.length) e.message += `\nprovider log (${method}):\n${w.providerLog.slice(-20).join('\n')}`
      throw e
    }
  }
  return { w, call, svc, cap, n, dir, store, vault, isFrozen, expires: nowS() + 86400 }
}
// offer, plan, mandate: the work starts; resolves once the first process froze (or finished) / 报价、计划、授权书：开工
async function hire(t, { nonce = '1', waitFor = 'frozen' } = {}) {
  const { w, call } = t
  const offer = offerMsg({ task: TASK, mode: 1, nonce })
  const acc = (await call('task_offer', { message: offer })).result
  const m = mandateOf({ task: TASK, agentKey: acc.agentKey, mode: 1, nonce, scope: [{ provider: S, token: BEM_TOKEN, cap: t.cap.toString() }], expires: t.expires })
  const msg = mandateMsg(m)
  const plan = await w.principalKit.holderPlan(m, { holder: HOLDER, path: 'holder', history: [], signed: { mandate: m, sig: msg.sig } })
  for (const step of plan.steps) w.escrow.send(HOLDER, step.tx)
  const started = (await call('task_mandate', { offerHash: acc.offerHash, message: msg })).result
  if (waitFor === 'frozen') await t.isFrozen
  else if (waitFor === 'done') await w.service.order(started.mandateHash).work
  return { m, msg, plan, acc, mandateHash: started.mandateHash }
}
async function settleAll(w) {
  const p = w.providerAt(P1)
  for (const v of await p.pendingSettlements()) { try { w.escrow.send(SETTLER, p.settleTx(v)) } catch { /* nothing to settle */ } }
}
// the restart: a new runtime over the same directory (a new file store, a new vault on the same passphrase unless
// given); its task does not freeze / 重启：同一目录上的新运行时（新的文件存储、同一口令的新保险箱）；它的任务不再冻结
const restart = (t, { vault = spyVault(), tasks = { calls: callsTask(t.n) } } = {}) => t.w.restartAgent({ tasks, spend: { store: createFileStore(t.dir), vault } })
// every file in the state directory, as bytes / 状态目录里的每个文件（字节）
const filesOf = (dir) => readdirSync(dir).map((f) => ({ f, bytes: readFileSync(join(dir, f)) }))
function plaintextOnDisk(dir, secrets) {
  const hits = []
  for (const hex of secrets) {
    const raw = Buffer.from(hex, 'hex')
    const forms = [hex, hex.toUpperCase(), raw.toString('base64'), raw.toString('base64url')]
    for (const { f, bytes } of filesOf(dir)) {
      if (bytes.includes(raw) || forms.some((x) => bytes.toString('latin1').toLowerCase().includes(x.toLowerCase())) || f.toLowerCase().includes(hex)) hits.push(f)
    }
  }
  return hits
}
const sealedKeyFile = (dir, agentKey) => readdirSync(dir).find((f) => f.toLowerCase().includes(agentKey.slice(2).toLowerCase()) && f.endsWith('_3akey.json'))
const orderFiles = (dir) => readdirSync(dir).filter((f) => f.startsWith('tapeapi-agent-order_3a'))

test('FIXED P1RS-E01: signed 3 vouchers, the process died, a new one resumed the order from the files and signed on: 5 calls paid in all, the total exactly the cap, the 6th refused; delivered; the sealed key destroyed', async () => {
  const t = await restartWorld({ n: 7, freezeAt: 3 })
  const o = await hire(t)
  assert.deepEqual(t.w.upstreamCalls(), { 'provider-1': 3 })
  // the sealed key and the order are on disk, the key in no form / 磁盘上有密封的钥匙与订单，钥匙没有任何明文形式
  assert.ok(sealedKeyFile(t.dir, o.acc.agentKey), 'the sealed key is on disk')
  assert.equal(orderFiles(t.dir).length, 1)
  assert.equal(t.vault.sealed.length, 1)
  assert.deepEqual(plaintextOnDisk(t.dir, t.vault.sealed), [])
  // review p1-restart: the order record is sealed too: the task text is nowhere on disk / 订单记录也封存：盘上没有任务文本
  assert.ok(t.vault.records.length >= 3)
  assert.deepEqual(filesOf(t.dir).filter(({ bytes }) => bytes.includes(Buffer.from(TASK.spec))).map((x) => x.f), [])
  await settleAll(t.w)                                      // the provider settled what it held before the crash / 崩溃前的结算
  // the restart: a new runtime over the same directory, a new vault on the same passphrase / 重启：同一目录、同一口令的新保险箱
  const endpointHits = () => t.w.requests.filter((u) => u.startsWith(P1 + '/tapeapi/')).length
  const hitsBefore = endpointHits()
  const svc2 = restart(t)
  const r = await svc2.recover()
  assert.deepEqual(r, { persistence: true, recovered: [o.acc.offerHash], refused: [] })
  const order = svc2.order(o.mandateHash)
  await order.work
  assert.deepEqual(order.deliverable.results, ['ok', 'ok', 'spend-cap-exceeded', 'spend-cap-exceeded'], 'the task went on from call 4: 2 more paid, then the cap')
  assert.deepEqual(t.w.upstreamCalls(), { 'provider-1': 5 })
  assert.equal(endpointHits() - hitsBefore, 2, 'the payer carried on from its stored counter: no voucher bounced back for a resync')
  await settleAll(t.w)
  assert.equal(t.w.escrow.claimedOf(HOLDER, S), t.cap, 'the key paid exactly the cap across the restart')
  assert.equal(t.w.escrow.channelOf(HOLDER, S), 0n)
  const rec = await svc2.limiter.record({ chainId: 56, agentKey: o.acc.agentKey })
  assert.deepEqual([rec.providers[0].base, rec.providers[0].hi], ['0', t.cap.toString()])
  const d = (await t.call('task_deliver', { mandateHash: o.mandateHash })).result
  assert.equal(d.receipts.length, 5, 'the receipts of the calls before the restart are kept')
  assert.deepEqual(d.spend.map((x) => x.spent), [t.cap.toString()])
  // the order ended: its sealed key and record are gone; the limiter's record stays (a key without it never signs)
  // 订单结束：密文与订单记录都已删除；限额记录保留
  assert.equal(sealedKeyFile(t.dir, o.acc.agentKey), undefined)
  assert.deepEqual(orderFiles(t.dir), [])
  assert.deepEqual(plaintextOnDisk(t.dir, t.vault.sealed), [])
})

test('FIXED P1RS-E02: every file of the state is 0600 in a 0700 directory, and the passphrase is nowhere on disk', async () => {
  const t = await restartWorld({ n: 2, freezeAt: 1 })
  await hire(t)
  assert.equal(modeOf(t.dir), 0o700)
  const files = filesOf(t.dir)
  assert.ok(files.length >= 4, files.map((x) => x.f).join(', '))
  for (const { f, bytes } of files) {
    assert.equal(modeOf(join(t.dir, f)), 0o600, f)
    assert.equal(bytes.includes(Buffer.from(PASS)), false, f)
  }
})

test('FIXED P1RS-E03: revoked while the process was down (the principal\'s site file): the order is not resumed, its record is stopped, the sealed key and the order record destroyed, nothing more paid', async () => {
  const t = await restartWorld({ n: 4, freezeAt: 2 })
  const o = await hire(t)
  revocationFile(t.w.x, { mandateHashes: [o.mandateHash] })
  const svc2 = restart(t)
  const r = await svc2.recover()
  assert.deepEqual(r.recovered, [])
  assert.deepEqual(r.refused.map((x) => x.reason), ['spend-revoked'])
  assert.equal(svc2.order(o.mandateHash), null)
  const rec = await svc2.limiter.record({ chainId: 56, agentKey: o.acc.agentKey })
  assert.ok(rec.stopped.reasons.includes('spend-revoked'))
  assert.equal(sealedKeyFile(t.dir, o.acc.agentKey), undefined)
  assert.deepEqual(orderFiles(t.dir), [])
  assert.deepEqual(t.w.upstreamCalls(), { 'provider-1': 2 })
  // and a third start finds nothing to resume / 第三次启动没有可恢复的
  const svc3 = restart(t)
  assert.deepEqual((await svc3.recover()).recovered, [])
})

test('FIXED P1RS-E04: the provider moved to another escrow while the process was down: not resumed, stopped (spend-escrow-changed), the sealed key destroyed', async () => {
  const t = await restartWorld({ n: 4, freezeAt: 2 })
  const o = await hire(t)
  escrowContract(t.w.x, E2, BEM_TOKEN); nameEscrow(t.w.x, S, E2)
  const svc2 = restart(t)
  const r = await svc2.recover()
  assert.deepEqual(r.refused.map((x) => x.reason), ['spend-escrow-changed'])
  assert.equal(sealedKeyFile(t.dir, o.acc.agentKey), undefined)
  assert.deepEqual(t.w.upstreamCalls(), { 'provider-1': 2 })
})

test('FIXED P1RS-E05: a wrong passphrase, a changed file and another order\'s sealed key fail closed: not resumed, not stopped, the files kept; the right passphrase then resumes it', async () => {
  const t = await restartWorld({ n: 4, freezeAt: 2 })
  const o = await hire(t)
  const f1 = sealedKeyFile(t.dir, o.acc.agentKey)
  const keep = readFileSync(join(t.dir, f1))
  const wrong = restart(t, { vault: passphraseKeyVault({ passphrase: PASS + '!' }) })
  const r1 = await wrong.recover()
  assert.deepEqual(r1.recovered, [])
  // the order record is sealed by the same vault: a wrong passphrase stops at the record (review p1-restart)
  // 订单记录由同一保险箱封存：错口令在记录这一步就失败
  assert.deepEqual([...new Set(r1.refused.map((x) => x.reason))], ['order-record-unreadable'])
  assert.equal(orderFiles(t.dir).length, 1, 'the order record is kept')
  assert.deepEqual(readFileSync(join(t.dir, f1)), keep, 'the sealed key is kept')
  assert.equal((await wrong.limiter.record({ chainId: 56, agentKey: o.acc.agentKey })).stopped, null, 'not stopped')
  // one hex digit of the ciphertext changed on disk / 磁盘上密文改了一个十六进制位
  const blob = keep.toString('utf8')
  writeFileSync(join(t.dir, f1), blob.slice(0, -8) + (blob.at(-8) === 'a' ? 'b' : 'a') + blob.slice(-7))
  const changed = restart(t, { vault: passphraseKeyVault({ passphrase: PASS }) })
  const r2 = await changed.recover()
  assert.deepEqual(r2.refused.find((x) => x.offerHash === o.acc.offerHash)?.reason, 'spend-key-unreadable')
  // another key's sealed key (the same passphrase, its own context, as another order's file is) copied over this one's
  // 另一把钥匙的密文（同一口令、它自己的 context，与另一单的文件相同）覆盖到这一单
  const other = '0x' + '5a'.repeat(32)
  writeFileSync(join(t.dir, f1), await passphraseKeyVault({ passphrase: PASS }).seal(Buffer.from(other.slice(2), 'hex'), { context: spendKeyContext(56, addrOf(other)) }))
  const swapped = restart(t, { vault: passphraseKeyVault({ passphrase: PASS }) })
  const r3 = await swapped.recover()
  assert.deepEqual(r3.refused.find((x) => x.offerHash === o.acc.offerHash)?.reason, 'spend-key-unreadable')
  assert.deepEqual(t.w.upstreamCalls(), { 'provider-1': 2 }, 'nothing was paid by any of them')
  // the file back, the right passphrase: resumed / 文件复原、口令正确：恢复
  writeFileSync(join(t.dir, f1), keep)
  const right = restart(t, { vault: passphraseKeyVault({ passphrase: PASS }) })
  const r4 = await right.recover()
  assert.ok(r4.recovered.includes(o.acc.offerHash))
})

test('FIXED P1RS-E06: a corrupt order record (not JSON, an earlier plaintext record, its envelope changed) is not resumed and nothing is signed; the sealed key is kept', async () => {
  const t = await restartWorld({ n: 4, freezeAt: 2 })
  const o = await hire(t)
  const f = orderFiles(t.dir)[0]
  const keep = readFileSync(join(t.dir, f))
  const env = JSON.parse(keep.toString('utf8'))
  assert.deepEqual(Object.keys(env).sort(), ['agentKey', 'offerHash', 'sealed', 'taskHash', 'v'])
  const reasons = async () => (await restart(t).recover()).refused.map((x) => x.reason)
  writeFileSync(join(t.dir, f), '{not json')
  assert.deepEqual(await reasons(), ['order-record-corrupt'])
  // a plaintext record (the form before review p1-restart) is never read: anyone could have written it
  // 明文记录（审查 p1-restart 之前的形式）绝不读取：谁都可能写了它
  writeFileSync(join(t.dir, f), JSON.stringify({ v: 1, offerHash: o.acc.offerHash, agentKey: o.acc.agentKey, state: 'accepted' }))
  assert.deepEqual(await reasons(), ['order-record-corrupt'])
  // the envelope's names are the seal's context: another key or task named there does not open / 信封里的名字就是 context：改了打不开
  writeFileSync(join(t.dir, f), JSON.stringify({ ...env, agentKey: addrOf(KEYS.stranger).toLowerCase() }))
  assert.deepEqual(await reasons(), ['order-record-unreadable'])
  writeFileSync(join(t.dir, f), JSON.stringify({ ...env, taskHash: '0x' + '12'.repeat(32) }))
  assert.deepEqual(await reasons(), ['order-record-unreadable'])
  assert.ok(sealedKeyFile(t.dir, o.acc.agentKey), 'kept: nothing was decided on a corrupt record')
  assert.deepEqual(t.w.upstreamCalls(), { 'provider-1': 2 })
  writeFileSync(join(t.dir, f), keep)
  assert.deepEqual((await restart(t).recover()).recovered, [o.acc.offerHash])
})

test('FIXED P1RS-E07: a resumed order that then receives a revocation stops at once and its sealed key is destroyed', async () => {
  const t = await restartWorld({ n: 6, freezeAt: 1 })
  const o = await hire(t)
  // the restarted task waits for the revocation before its next call / 重启后的任务在下一次调用前等撤销
  let release
  const gate = new Promise((res) => { release = res })
  const svc2 = restart(t, { tasks: { calls: { needsProviders: true, async run(task, ctx) { await gate; const out = []; try { await ctx.call(S, 'blockNumber', {}); out.push('ok') } catch (e) { out.push(e?.data?.reason ?? 'error') } return { kind: 'calls', results: out } } } } })
  assert.deepEqual((await svc2.recover()).recovered, [o.acc.offerHash])
  const st = (await t.call('task_status', { mandateHash: o.mandateHash, revocation: revocationMsg({ mandateHashes: [o.mandateHash] }) })).result
  assert.equal(st.state, 'revoked')
  assert.equal(sealedKeyFile(t.dir, o.acc.agentKey), undefined, 'the sealed key is destroyed')
  assert.deepEqual(orderFiles(t.dir), [])
  release()
  await svc2.order(o.mandateHash).work
  assert.deepEqual(svc2.order(o.mandateHash).deliverable?.results ?? ['refused'], ['mandate-revoked'])
  assert.deepEqual(t.w.upstreamCalls(), { 'provider-1': 1 })
  const rec = await svc2.limiter.record({ chainId: 56, agentKey: o.acc.agentKey })
  assert.ok(rec.stopped.reasons.includes('spend-revoked'))
})

test('FIXED P1RS-E08: an order accepted but not yet given its mandate survives a restart: the new process starts it from the mandate', async () => {
  const t = await restartWorld({ n: 1, freezeAt: null })
  const offer = offerMsg({ task: TASK, mode: 1, nonce: '3' })
  const acc = (await t.call('task_offer', { message: offer })).result
  const svc2 = restart(t)
  assert.deepEqual((await svc2.recover()).recovered, [acc.offerHash])
  // the same offer again: the same key, never a second one / 同一报价：同一把钥匙
  assert.equal((await t.call('task_offer', { message: offer })).result.agentKey, acc.agentKey)
  const m = mandateOf({ task: TASK, agentKey: acc.agentKey, mode: 1, nonce: '3', scope: [{ provider: S, token: BEM_TOKEN, cap: t.cap.toString() }], expires: t.expires })
  const msg = mandateMsg(m)
  const plan = await t.w.principalKit.holderPlan(m, { holder: HOLDER, path: 'holder', history: [], signed: { mandate: m, sig: msg.sig } })
  for (const step of plan.steps) t.w.escrow.send(HOLDER, step.tx)
  const started = (await t.call('task_mandate', { offerHash: acc.offerHash, message: msg })).result
  await svc2.order(started.mandateHash).work
  assert.deepEqual(svc2.order(started.mandateHash).deliverable.results, ['ok'])
})

test('FIXED P1RS-E09: an order done but not delivered when the process died is resumed ready and delivered, without calling again', async () => {
  const t = await restartWorld({ n: 2, freezeAt: null })
  const o = await hire(t, { waitFor: 'done' })
  const svc2 = restart(t)
  assert.deepEqual((await svc2.recover()).recovered, [o.acc.offerHash])
  assert.equal(svc2.order(o.mandateHash).state, 'ready')
  await settleAll(t.w)
  const d = (await t.call('task_deliver', { mandateHash: o.mandateHash })).result
  assert.equal(d.receipts.length, 2)
  assert.deepEqual(t.w.upstreamCalls(), { 'provider-1': 2 })
  assert.equal(sealedKeyFile(t.dir, o.acc.agentKey), undefined)
})

test('FIXED P1RS-E10: without a passphrase in the environment nothing is persisted, and the log says so; a short one is refused; with both, the directory is 0700', () => {
  const lines = []
  assert.equal(persistenceFromEnv({}, { log: (l) => lines.push(l) }), null)
  assert.match(lines[0], new RegExp(`persistence OFF: set ${PASSPHRASE_ENV}`))
  assert.match(lines[0], /a restart voids every order/)
  assert.equal(persistenceFromEnv({ [PASSPHRASE_ENV]: PASS }, { log: () => {} }), null, 'no directory: off')
  const off = []
  assert.equal(persistenceFromEnv({ [STATE_DIR_ENV]: stateDir() }, { log: (l) => off.push(l) }), null, 'a directory without a passphrase: off, never in the clear')
  assert.match(off[0], /persistence OFF/)
  assert.throws(() => persistenceFromEnv({ [PASSPHRASE_ENV]: 'short', [STATE_DIR_ENV]: stateDir() }), /at least 12/)
  const d = join(stateDir(), 'state')
  const on = []
  const p = persistenceFromEnv({ [PASSPHRASE_ENV]: PASS, [STATE_DIR_ENV]: d }, { log: (l) => on.push(l) })
  assert.ok(p.store && p.vault)
  assert.equal(modeOf(d), 0o700)
  assert.equal(on.join('\n').includes(PASS), false, 'the passphrase is never logged')
})

test('FIXED P1RS-E11: a runtime without a vault keeps nothing: a restart resumes no order (the M4 behaviour)', async () => {
  const w = await createDemoWorld({ spend: { escrow: E1, holderBalance: 10n ** 12n }, agentOptions: { tasks: { calls: callsTask(1) }, spend: { maxCallPrice: PRICE.toString() } } })
  const svc2 = w.restartAgent()
  assert.deepEqual(await svc2.recover(), { persistence: false, recovered: [], refused: [] })
  assert.throws(() => w.restartAgent({ spend: { vault: spyVault(), store: undefined } }), /spend.vault needs spend.store/)
  // review p1-restart: a maxCallPrice the limiter would refuse fails at construction, not after an order started
  // 审查 p1-restart：限额器会拒绝的 maxCallPrice 在构造时就失败，而不是开工之后
  for (const maxCallPrice of ['0', 0, [], { nope: '1' }]) assert.throws(() => w.restartAgent({ spend: { maxCallPrice } }), (e) => e.code === 'INVALID_ARGUMENT', JSON.stringify(maxCallPrice))
})

test('FIXED P1RS-E12: the file store compares and sets on the record\'s seq (the limiter\'s compare-and-set within the process), and deletes', () => {
  const st = createFileStore(stateDir())
  assert.equal(st.get('a:b'), null)
  assert.equal(st.set('a:b', JSON.stringify({ seq: 0 }), { ifSeq: 1 }), false, 'nothing stored: only ifSeq null writes')
  assert.equal(st.set('a:b', JSON.stringify({ seq: 0 }), { ifSeq: null }), true)
  assert.equal(st.set('a:b', JSON.stringify({ seq: 1 }), { ifSeq: null }), false, 'a record is there now')
  assert.equal(st.set('a:b', JSON.stringify({ seq: 1 }), { ifSeq: 0 }), true)
  assert.equal(JSON.parse(st.get('a:b')).seq, 1)
  assert.equal(st.set('a:b', 'x'), true, 'without ifSeq: written')
  st.delete('a:b'); st.delete('a:b')
  assert.equal(st.get('a:b'), null)
  assert.deepEqual(readdirSync(st.dir), [LOCK_FILE], 'no temporary file is left behind (only the directory\'s lock)')
})

// ---- review p1-restart (FIXED P1RR-xx): the findings of the review of the restart, written as tests ----
// 审查 p1-restart 的发现，写成测试
const encode = (fn, args) => abi.selector(`${fn}(address,uint256)`) + abi.bytesToHex(abi.encodeParams(['address', 'uint256'], args))
const blobFiles = (dir) => readdirSync(dir).filter((f) => f.endsWith('_3akey.json'))
// the order record opened, changed and sealed again with the right passphrase (what only the passphrase's holder, or a
// bug, could do): checkRecord must still refuse it / 用正确口令打开、修改、重新封存的订单记录（只有口令持有者或 bug 能做到）
async function reseal(dir, edit) {
  const f = orderFiles(dir)[0]
  const env = JSON.parse(readFileSync(join(dir, f), 'utf8'))
  const v = passphraseKeyVault({ passphrase: PASS })
  const context = `tapeapi-agent-order/v1/56/${AG.toLowerCase()}/${env.offerHash}/${env.agentKey}/${env.taskHash}`
  const rec = JSON.parse(Buffer.from(await v.open(env.sealed, { context })).toString('utf8'))
  const keep = readFileSync(join(dir, f))
  edit(rec)
  writeFileSync(join(dir, f), JSON.stringify({ ...env, sealed: await v.seal(Buffer.from(JSON.stringify(rec)), { context }) }))
  return () => writeFileSync(join(dir, f), keep)
}

test('FIXED P1RR-01: a ready order\'s deliverable and receipts changed on disk are never signed as the agent\'s own: a plaintext record is corrupt, a record re-sealed with the right passphrase is checked again; the genuine one then delivers', async () => {
  const t = await restartWorld({ n: 2, freezeAt: null })
  const o = await hire(t, { waitFor: 'done' })
  const f = orderFiles(t.dir)[0]
  const genuine = readFileSync(join(t.dir, f))
  const reasons = async () => (await restart(t).recover()).refused.map((x) => x.reason)
  const refusedFor = async () => (await restart(t).recover()).refused
  // the probe of the review: a plaintext record with a forged deliverable and receipts / 审查的探针：伪造交付物与回执的明文记录
  writeFileSync(join(t.dir, f), JSON.stringify({ v: 2, offerHash: o.acc.offerHash, state: 'ready', deliverable: { kind: 'calls', results: ['FORGED'] }, receipts: [{ forged: true }] }))
  assert.deepEqual(await reasons(), ['order-record-corrupt'])
  writeFileSync(join(t.dir, f), genuine)
  // re-sealed with the passphrase: each change is caught by the record's own checks / 用口令重新封存：每处修改都被记录检查抓到
  const S2 = '0x00000000000000000000000000000000000005e2'
  const edits = [
    (r) => { r.receipts = [{ forged: true }] },
    (r) => { r.receipts[0] = { ...r.receipts[0], service: { ...r.receipts[0].service, container: S2 } } },
    (r) => { r.receipts = Array.from({ length: 9 }, () => r.receipts[0]) },
    (r) => { r.mandateHash = '0x' + '77'.repeat(32) },
    (r) => { r.mandateMsg.mandate.agentKey = addrOf(KEYS.stranger) },
    (r) => { r.agentKey = addrOf(KEYS.stranger) },
    (r) => { r.offerMsg.task.spec = 'another task' },
    (r) => { r.state = 'delivered' },
  ]
  for (const [i, edit] of edits.entries()) {
    const back = await reseal(t.dir, edit)
    assert.deepEqual(await reasons(), ['order-record-corrupt'], `edit ${i}`)
    back()
  }
  // a ready record without its deliverable is refused as such (not only because nothing could be hashed)
  // 没有交付物的 ready 记录按此拒绝（不只是因为算不出哈希）
  const back = await reseal(t.dir, (r) => { delete r.deliverable })
  const missing = await refusedFor()
  assert.deepEqual(missing.map((x) => x.reason), ['order-record-corrupt']); assert.match(missing[0].message, /a ready order without its deliverable/)
  back()
  assert.deepEqual(t.w.upstreamCalls(), { 'provider-1': 2 }, 'nothing was called or signed for a changed record')
  // the genuine record: resumed ready, the deliverable and receipts the agent made / 原记录：恢复为 ready，交付的是代理自己做的
  const svc = restart(t)
  assert.deepEqual((await svc.recover()).recovered, [o.acc.offerHash])
  const d = (await t.call('task_deliver', { mandateHash: o.mandateHash })).result
  assert.equal(d.receipts.length, 2)
  assert.deepEqual(svc.order(o.mandateHash).deliverable.results, ['ok', 'ok'])
})

// the first process dies while the limiter's start is being written (after the order was recorded working)
// 第一个进程在写限额器开工记录时死掉（订单已记为 working）
const dieAtStart = (signal) => (st) => ({ ...st, set: (k, val, o) => { if (k.startsWith('tapeapi-spend:') && !k.endsWith(':key') && !k.endsWith(':stopped') && val.includes('"state":"started"')) { signal(); return new Promise(() => {}) } return st.set(k, val, o) } })
async function hireUntilStart(t, died) {
  const offer = offerMsg({ task: TASK, mode: 1, nonce: '1' })
  const acc = (await t.call('task_offer', { message: offer })).result
  const m = mandateOf({ task: TASK, agentKey: acc.agentKey, mode: 1, nonce: '1', scope: [{ provider: S, token: BEM_TOKEN, cap: t.cap.toString() }], expires: t.expires })
  const msg = mandateMsg(m)
  const plan = await t.w.principalKit.holderPlan(m, { holder: HOLDER, path: 'holder', history: [], signed: { mandate: m, sig: msg.sig } })
  for (const step of plan.steps) t.w.escrow.send(HOLDER, step.tx)
  t.call('task_mandate', { offerHash: acc.offerHash, message: msg }).catch(() => {})   // never answers: the process died / 永不回答
  await died
  return { acc, m, msg }
}

test('FIXED P1RR-02: the process died between recording the mandate and the limiter\'s start: the restart starts it (an ok check), and the key pays up to the cap', async () => {
  let signal
  const died = new Promise((res) => { signal = res })
  const t = await restartWorld({ n: 5, freezeAt: null, wrap: dieAtStart(signal) })
  const o = await hireUntilStart(t, died)
  assert.equal((await t.w.service.limiter.record({ chainId: 56, agentKey: o.acc.agentKey })).state, 'accepted', 'the start never landed')
  assert.deepEqual(t.w.upstreamCalls(), {})
  const svc2 = restart(t)
  assert.deepEqual(await svc2.recover(), { persistence: true, recovered: [o.acc.offerHash], refused: [] })
  const rec = await svc2.limiter.record({ chainId: 56, agentKey: o.acc.agentKey })
  assert.equal(rec.state, 'started')
  const order = svc2.order(o.acc.offerHash)
  await order.work
  assert.deepEqual(order.deliverable.results, ['ok', 'ok', 'ok', 'ok', 'ok'])
  await settleAll(t.w)
  assert.equal(t.w.escrow.claimedOf(HOLDER, S), t.cap, 'paid exactly the cap')
  const d = (await t.call('task_deliver', { mandateHash: order.mandateHash })).result
  assert.equal(d.receipts.length, 5)
  assert.deepEqual(orderFiles(t.dir), []); assert.deepEqual(blobFiles(t.dir), [])
})

test('FIXED P1RR-03: the same crash, but the mandate no longer verifies at the restart (a live withdraw request): mandate-not-valid, nothing started, the limiter record stays accepted, the sealed key and the order record are kept', async () => {
  let signal
  const died = new Promise((res) => { signal = res })
  const t = await restartWorld({ n: 5, freezeAt: null, wrap: dieAtStart(signal) })
  const o = await hireUntilStart(t, died)
  t.w.escrow.send(HOLDER, { to: E1, data: encode('requestWithdraw', [S, t.w.escrow.channelOf(HOLDER, S)]) })
  const svc2 = restart(t)
  const r = await svc2.recover()
  assert.deepEqual(r.recovered, [])
  assert.deepEqual(r.refused.map((x) => x.reason), ['mandate-not-valid'])
  assert.match(r.refused[0].message, /withdraw-pending/)
  assert.equal((await svc2.limiter.record({ chainId: 56, agentKey: o.acc.agentKey })).state, 'accepted')
  assert.equal(orderFiles(t.dir).length, 1); assert.equal(blobFiles(t.dir).length, 1)
  assert.deepEqual(t.w.upstreamCalls(), {})
})

test('FIXED P1RR-04: an order accepted but given no mandate before its accept expired is not resumed: accept-expired, its sealed key and record destroyed', async () => {
  const t = await restartWorld({ n: 1, freezeAt: null })
  const acc = (await t.call('task_offer', { message: offerMsg({ task: TASK, mode: 1, nonce: '4' }) })).result
  assert.equal(blobFiles(t.dir).length, 1)
  t.w.advance(3601)
  const r = await restart(t).recover()
  assert.deepEqual(r.refused.map((x) => [x.offerHash, x.reason]), [[acc.offerHash, 'accept-expired']])
  assert.deepEqual(orderFiles(t.dir), []); assert.deepEqual(blobFiles(t.dir), [])
})

test('FIXED P1RR-09: with persistence, nothing is served before recover(): the kept offer never gets a second key', async () => {
  const t = await restartWorld({ n: 4, freezeAt: 2 })
  const o = await hire(t)
  const offer = offerMsg({ task: TASK, mode: 1, nonce: '1' })
  const svc2 = restart(t)
  const recovering = (p) => assert.rejects(p, (e) => e.data?.reason === 'recovering')
  await recovering(t.call('task_offer', { message: offer }))
  await recovering(t.call('task_status', { offerHash: o.acc.offerHash }))
  await recovering(svc2.receiveRevocation(o.mandateHash, {}))
  assert.equal(svc2.issuedKeys().length, 0, 'no key was made')
  assert.deepEqual((await svc2.recover()).recovered, [o.acc.offerHash])
  assert.equal((await t.call('task_offer', { message: offer })).result.agentKey, o.acc.agentKey, 'the same key')
  assert.equal(orderFiles(t.dir).length, 1); assert.equal(blobFiles(t.dir).length, 1)
})

test('FIXED P1RR-10: a call paid just before the process died has no receipt: ctx.resumed says what the key signed, and a task that knows its price does not pay it again (the total stays the cap)', async () => {
  // the first process dies while the order record with the 3rd receipt is written (the 3rd voucher was accepted)
  // 第一个进程在写入带第 3 张回执的订单记录时死掉（第 3 张凭证已被接受）
  let writes = 0, signal
  const died = new Promise((res) => { signal = res })
  const wrap = (st) => ({ ...st, set: (k, val, o) => { if (k.startsWith('tapeapi-agent-order:') && ++writes === 5) { signal(); return new Promise(() => {}) } return st.set(k, val, o) } })
  const t = await restartWorld({ n: 5, freezeAt: null, wrap })
  t.call('task_offer', { message: offerMsg({ task: TASK, mode: 1, nonce: '1' }) }).then(async ({ result: acc }) => {
    const m = mandateOf({ task: TASK, agentKey: acc.agentKey, mode: 1, nonce: '1', scope: [{ provider: S, token: BEM_TOKEN, cap: t.cap.toString() }], expires: t.expires })
    const msg = mandateMsg(m)
    const plan = await t.w.principalKit.holderPlan(m, { holder: HOLDER, path: 'holder', history: [], signed: { mandate: m, sig: msg.sig } })
    for (const step of plan.steps) t.w.escrow.send(HOLDER, step.tx)
    await t.call('task_mandate', { offerHash: acc.offerHash, message: msg })
  })
  await died
  assert.deepEqual(t.w.upstreamCalls(), { 'provider-1': 3 })
  // the restarted task: skips what was paid, by the price it knows / 重启后的任务：按已知单价跳过已付的调用
  let seen
  const priced = { needsProviders: true, async run(task, ctx) {
    seen = structuredClone(ctx.resumed)
    const p = ctx.resumed.providers.find((x) => x.provider.toLowerCase() === S.toLowerCase())
    const paid = Math.max(ctx.resumed.calls, p ? Number(BigInt(p.signed) / PRICE) : 0)
    const results = []
    for (let i = paid; i < 5; i++) { try { await ctx.call(S, 'blockNumber', {}); results.push('ok') } catch (e) { results.push(e?.data?.reason ?? 'error') } }
    return { kind: 'calls', results }
  } }
  const svc2 = restart(t, { tasks: { calls: priced } })
  const r = await svc2.recover()
  assert.equal(r.recovered.length, 1)
  const order = svc2.order(r.recovered[0])
  await order.work
  assert.deepEqual(seen, { calls: 2, providers: [{ provider: abi.checksumAddress(S), signed: (3n * PRICE).toString(), receipts: 2 }] })
  assert.deepEqual(order.deliverable.results, ['ok', 'ok'])
  assert.deepEqual(t.w.upstreamCalls(), { 'provider-1': 5 }, 'the unreceipted call was not paid again')
  await settleAll(t.w)
  assert.equal(t.w.escrow.claimedOf(HOLDER, S), t.cap)
})

test('FIXED P1RR-11: a sealed key never outlives its order record: a crash between the record and the key (accept), or between destroying the key and the record (the end), leaves a record that recover drops (spend-key-lost)', async () => {
  // at the accept: the record written, the process dies while the key is sealed / 接单：记录已写，封存钥匙时进程死掉
  let signal
  const died = new Promise((res) => { signal = res })
  const t = await restartWorld({ n: 1, freezeAt: null, wrap: (st) => ({ ...st, set: (k, val, o) => { if (k.endsWith(':key')) { signal(); return new Promise(() => {}) } return st.set(k, val, o) } }) })
  t.call('task_offer', { message: offerMsg({ task: TASK, mode: 1, nonce: '5' }) }).catch(() => {})
  await died
  assert.equal(orderFiles(t.dir).length, 1); assert.deepEqual(blobFiles(t.dir), [])
  const r = await restart(t).recover()
  assert.deepEqual(r.refused.map((x) => x.reason), ['spend-key-lost'])
  assert.deepEqual(orderFiles(t.dir), [], 'the record without its key is dropped')
  // at the end: the key destroyed, the record's removal fails (the review's probe) / 结束：钥匙已销毁、删除记录失败（审查的探针）
  let fail = false
  const u = await restartWorld({ n: 1, freezeAt: null, wrap: (st) => ({ ...st, delete: (k) => { if (fail && k.startsWith('tapeapi-agent-order:')) throw new Error('the disk failed'); return st.delete(k) } }) })
  const o = await hire(u, { waitFor: 'done' })
  fail = true
  assert.equal((await u.call('task_deliver', { mandateHash: o.mandateHash })).result.receipts.length, 1)
  assert.equal(orderFiles(u.dir).length, 1); assert.deepEqual(blobFiles(u.dir), [])
  const r2 = await restart(u).recover()
  assert.deepEqual(r2.refused.map((x) => x.reason), ['spend-key-lost'])
  assert.deepEqual(orderFiles(u.dir), [])
  assert.deepEqual((await restart(u).recover()).refused, [], 'nothing left to refuse')
})

// another process on the directory: a child that takes the store, says so, and then waits, exits or dies
// 目录上的另一个进程：子进程拿到存储后报告，然后等待、退出或被杀
function childOn(dir, then = 'wait') {
  const url = new URL('./state.mjs', import.meta.url).href
  const code = `import { createFileStore } from ${JSON.stringify(url)}; const st = createFileStore(${JSON.stringify(dir)}); process.stdout.write('held ' + st.lock.pid + '\\n'); ${then === 'exit' ? 'process.exit(0)' : 'setInterval(() => {}, 1000)'}`
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'inherit'] })
  const held = new Promise((res, rej) => { child.stdout.on('data', (b) => { if (String(b).startsWith('held')) res() }); child.on('exit', (c) => (then === 'exit' ? res() : rej(new Error(`the child exited (${c})`)))) })
  const exited = new Promise((res) => child.on('exit', res))
  return { child, held, exited }
}
const locked = (fn, re) => assert.throws(fn, (e) => { assert.equal(e.code, 'STATE_DIR_LOCKED', e.message); if (re) assert.match(e.message, re); return true })

test('FIXED P1RR-12: one process per state directory: a live process\'s lock refuses another, a process that exits releases it, a killed one\'s is taken over; the same process may open it again', async (t) => {
  const dir = stateDir()
  // a live process holds it (killed after the test whatever happens, so that a failure does not hang the run)
  // 活着的进程持有（无论测试结果如何，结束后都杀掉子进程，免得失败时挂住）
  const a = childOn(dir)
  t.after(() => { if (a.child.exitCode === null && a.child.signalCode === null) a.child.kill('SIGKILL') })
  await a.held
  const lock = JSON.parse(readFileSync(join(dir, LOCK_FILE), 'utf8'))
  assert.equal(lock.pid, a.child.pid); assert.equal(lock.host, hostname()); assert.ok(!Number.isNaN(Date.parse(lock.startedAt)))
  assert.equal(modeOf(join(dir, LOCK_FILE)), 0o600)
  locked(() => createFileStore(dir), new RegExp(`in use by process ${a.child.pid}`))
  assert.throws(() => persistenceFromEnv({ [PASSPHRASE_ENV]: PASS, [STATE_DIR_ENV]: dir }), (e) => e.code === 'STATE_DIR_LOCKED')
  // killed (no exit handler runs): its lock stays, and is taken over because its pid is gone / 被杀：锁留下，pid 已不在即接管
  a.child.kill('SIGKILL'); await a.exited
  assert.equal(JSON.parse(readFileSync(join(dir, LOCK_FILE), 'utf8')).pid, a.child.pid, 'the dead process\'s lock is still there')
  const st = createFileStore(dir)
  assert.equal(st.lock.pid, process.pid)
  assert.equal(createFileStore(dir).lock.pid, process.pid, 'this process again: the same lock (a restart within one process)')
  st.lock.release()
  assert.equal(readdirSync(dir).includes(LOCK_FILE), false)
  // a process that exits releases its lock / 正常退出的进程释放锁
  const b = childOn(dir, 'exit')
  await b.held; await b.exited
  assert.equal(readdirSync(dir).includes(LOCK_FILE), false, 'released at exit')
})

test('FIXED P1RR-13: a lock is taken over only when its process is gone on this host: another host, a pid the system will not signal (EPERM), or a lock that cannot be read refuse', () => {
  const dir = stateDir()
  const put = (x) => writeFileSync(join(dir, LOCK_FILE), typeof x === 'string' ? x : JSON.stringify(x), { mode: 0o600 })
  const at = new Date().toISOString()
  put({ pid: 999_999, host: 'another-host.example', startedAt: at })
  locked(() => createFileStore(dir), /another-host\.example/)
  put({ pid: 1, host: hostname(), startedAt: at })                                     // launchd / init: alive, another user's
  locked(() => createFileStore(dir), /in use by process 1 /)
  put('{"pid": ')
  locked(() => createFileStore(dir), /cannot be read/)
  put({ host: hostname(), startedAt: at })
  locked(() => createFileStore(dir), /cannot be read/)
  // a pid on this host that no longer exists: taken over / 本机上已不存在的 pid：接管
  const gone = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).stdout.toString()
  put({ pid: Number(gone), host: hostname(), startedAt: at })
  assert.equal(createFileStore(dir).lock.pid, process.pid)
  assert.deepEqual(readdirSync(dir), [LOCK_FILE], 'no temporary or moved-aside file is left behind')
})

test('FIXED P1RR-14: the default task (chain.block-height) does not call again the providers it called before a restart: they are listed without a number', async () => {
  const P = ['0x' + 'a1'.repeat(20), '0x' + 'a2'.repeat(20), '0x' + 'a3'.repeat(20)]
  const run = async (calls) => {
    const called = []
    const ctx = { providers: P, resumed: { calls, providers: [] }, async call(provider) { called.push(provider); return { blockNumber: 100 + P.indexOf(provider) } } }
    return { called, out: await blockHeightTask().run({ kind: 'chain.block-height' }, ctx) }
  }
  const fresh = await run(0)
  assert.deepEqual(fresh.called, P)
  assert.deepEqual(fresh.out, { kind: 'chain.block-height', chain: 'bsc', blockNumber: 102, answers: P.map((provider, i) => ({ provider, blockNumber: 100 + i })) }, 'unchanged without a restart')
  const resumed = await run(1)
  assert.deepEqual(resumed.called, P.slice(1))
  assert.deepEqual(resumed.out.answers[0], { provider: P[0], blockNumber: null, answeredBeforeRestart: true })
  assert.equal(resumed.out.blockNumber, 102)
  const all = await run(3)
  assert.deepEqual(all.called, []); assert.equal(all.out.blockNumber, null)
})
