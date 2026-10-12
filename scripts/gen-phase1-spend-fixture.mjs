// Container agents phase 1, M4 (experimental): one spend order as the SDK carries it out, written as Solidity
// constants for contracts/test/Phase1Spend.t.sol, which executes it on the UNCHANGED v3 escrow (a test-local deployment,
// nothing broadcast): the holder's plan (escrowPlan), the vouchers the agent key signs through api.payer wrapped by the
// spend limiter (createSpendLimiter) until the limiter refuses one, the close-out (closeOutPlan), and (phase 1, restart)
// the vouchers signed before and after a restart of the agent's process, the key resumed from its sealed form. The keys are the
// vectors' fixtures; the clock is fixed. sdk/test/agent-phase1-spend.test.mjs checks that the file is what this writes.
//   node scripts/gen-phase1-spend-fixture.mjs        writes contracts/test/Phase1SpendFixture.sol
// 阶段 1 的 M4：把 SDK 执行的一单 spend 写成 Solidity 常量，供 Phase1Spend.t.sol 在未改的 v3 托管上执行：持有人计划、
// 代理钥匙经限额器签出的凭证（直到限额器拒绝）、收尾。密钥是向量夹具，时钟固定。
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { escrowPlan, closeOutPlan, createSpendLimiter } from '../sdk/src/agent-pay.js'
import { passphraseKeyVault } from '../sdk/src/agent-vault.js'
import { mandateHashOf, taskHashOf } from '../sdk/src/agent-sig.js'
import { createTapeAPI } from '../sdk/src/index.js'
import { checksumAddress } from '../sdk/src/abi.js'
import { privateKeyToAddress, signDigest, voucherDigest } from '../sdk/src/sig.js'

const ROOT = new URL('../', import.meta.url)
export const SPEND_FIXTURE_PATH = fileURLToPath(new URL('contracts/test/Phase1SpendFixture.sol', ROOT))
const HUB = '0xe61A9C7213a6Aa616C246a2B569e555B417b25ee'
const HOLDER_PK = '0x' + '11'.repeat(32), AGENT_PK = '0x' + '77'.repeat(32)
const PRINCIPAL = '0x86DDaEF00401E3F10418398D67D7189fc458eA95', AGENT = '0x19366c3c69FFEB3b286D9fA6cC5e616375BAafd3'
const PROVIDER = '0x00000000000000000000000000000000000005e1'
const E1 = '0x00000000000000000000000000000000000E5C71'
const TOKEN = '0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a'          // BEM, 8 decimals
const NOT_BEFORE = 1789000000, EXPIRES = NOT_BEFORE + 10 * 86400, T = NOT_BEFORE + 3600
const PRICE = 10_000n, CAP = 5n * PRICE

export async function phase1SpendFixture() {
  const holder = privateKeyToAddress(HOLDER_PK), agentKey = privateKeyToAddress(AGENT_PK)
  const m = { principal: PRINCIPAL, agent: AGENT, agentKey, mode: 1, taskHash: taskHashOf({ kind: 'calls' }), scope: [{ provider: PROVIDER, token: TOKEN, cap: CAP.toString() }], feeToken: '0x' + '00'.repeat(20), feeCap: '0', notBefore: NOT_BEFORE, expires: EXPIRES, nonce: '1', subdelegate: false }
  const plan = escrowPlan(m, { chainId: 56, path: 'holder', holder, currentHolder: holder, now: T, hub: HUB, history: [], allowEscrows: [E1], providers: [{ provider: PROVIDER, escrow: E1, token: TOKEN, escrowCode: true, channel: '0', session: '0', claimed: '0', otherPath: { channel: '0', session: '0' } }] })
  // the check that starts the work, as verifyMandate returns it once the plan is on chain (claimedOf 0)
  const check = { ok: true, enforcement: 'escrow-channel', phase: 1, mandate: m, mandateHash: mandateHashOf(56, HUB, m), consumer: holder, problems: [], scope: [{ provider: PROVIDER, escrow: E1, claimedAtCheck: '0' }] }
  const limiter = createSpendLimiter({ clock: () => T })
  await limiter.accept({ chainId: 56, agentKey })
  await limiter.start({ chainId: 56, check })
  // 1.x behaviour; 2.0 default is conform: 'tap10'
  const api = createTapeAPI({ chainId: 56, clock: () => T, conform: false })
  // the price is 20% of the cap: above the default per-call ceiling (10% of the cap), so it is given explicitly
  // 单价是 cap 的 20%，高于默认的单次上限（cap 的 10%），所以显式给出
  const payer = limiter.payer({ chainId: 56, payer: api.payer({ consumer: holder, sessionKey: AGENT_PK, sessionExpiry: EXPIRES }), maxPrice: PRICE })
  const svc = { container: PROVIDER, manifest: { payment: { escrow: E1 } } }
  const vouchers = []
  let refused = null
  for (let i = 0; i < 10 && !refused; i++) {
    try { const l = await payer.reserve(svc, PRICE); await l.commit(); vouchers.push(l.voucher) } catch (e) { refused = e.data?.reason ?? e.code }
  }
  if (refused !== 'spend-cap-exceeded' || vouchers.length !== 5) throw new Error(`the limiter did not stop at the cap: ${vouchers.length} vouchers, ${refused}`)
  // scenario B (review p1m4): claimedAtCheck above 0. Before the plan the holder funded 2 prices by hand and settled its
  // own voucher for them on the same channel (claimedOf 2 prices, channel 0); the plan funds the cap; the check that
  // starts the work reads claimedAtCheck = 2 prices; the payer resumes from there and the limiter lets out vouchers up to
  // claimedAtCheck + cap and no further / 场景 B：开工时 claimedOf 已为 2 个价格（持有人自签结算），钥匙自开工起最多付 cap
  const BASE_B = 2n * PRICE
  const holderOwn = { consumer: holder, provider: PROVIDER, cumulative: BASE_B, expires: T + 3600 }
  const holderSig = signDigest(voucherDigest(56, E1, holderOwn), HOLDER_PK)
  const planB = escrowPlan(m, { chainId: 56, path: 'holder', holder, currentHolder: holder, now: T, hub: HUB, history: [], allowEscrows: [E1], providers: [{ provider: PROVIDER, escrow: E1, token: TOKEN, escrowCode: true, channel: '0', session: '0', claimed: BASE_B.toString(), otherPath: { channel: '0', session: '0' } }] })
  const limiterB = createSpendLimiter({ clock: () => T })
  await limiterB.accept({ chainId: 56, agentKey })
  await limiterB.start({ chainId: 56, check: { ...check, scope: [{ provider: PROVIDER, escrow: E1, claimedAtCheck: BASE_B.toString() }] } })
  // 1.x behaviour; 2.0 default is conform: 'tap10'
  const payerB = limiterB.payer({ chainId: 56, payer: createTapeAPI({ chainId: 56, clock: () => T, conform: false }).payer({ consumer: holder, sessionKey: AGENT_PK, sessionExpiry: EXPIRES }), maxPrice: PRICE })
  await payerB.setCumulative(svc, BASE_B)       // the payer resumes from the chain's claimedOf / 付款器从链上 claimedOf 续起
  const vouchersB = []
  let refusedB = null
  for (let i = 0; i < 10 && !refusedB; i++) {
    try { const l = await payerB.reserve(svc, PRICE); await l.commit(); vouchersB.push(l.voucher) } catch (e) { refusedB = e.data?.reason ?? e.code }
  }
  if (refusedB !== 'spend-cap-exceeded' || vouchersB.length !== 5 || BigInt(vouchersB[4].cumulative) !== BASE_B + CAP) throw new Error(`scenario B: the limiter did not stop at claimedAtCheck + cap: ${vouchersB.length} vouchers, ${refusedB}`)
  // scenario R (phase 1, restart): the agent's process signs 2 vouchers and dies; a new process (a new limiter and a new
  // passphrase vault over the same store) resumes the order from the sealed key and signs on until the cap. The provider
  // settled the second before the restart (the resume check reads claimedOf 2 prices); base stays 0.
  // 场景 R（阶段 1 的重启）：代理进程签 2 张凭证后死掉；新进程（同一存储上的新限额器与新口令保险箱）从封存的钥匙恢复订单，签到 cap 为止
  const PASS_R = 'a fixture passphrase, not a secret'
  const shared = new Map()
  const storeR = {
    get: (k) => shared.get(k) ?? null,
    set: (k, v, o) => { if (o && 'ifSeq' in o) { const cur = shared.get(k); const seq = cur ? (JSON.parse(cur).seq ?? 0) : null; if (seq !== o.ifSeq) return false } shared.set(k, v); return true },
    delete: (k) => { shared.delete(k) },
  }
  const payerStoreR = { get: (k) => shared.get(`payer:${k}`) ?? null, set: (k, v) => { shared.set(`payer:${k}`, v) } }
  const RESTART_AT = T + 1800
  const limR1 = createSpendLimiter({ store: storeR, vault: passphraseKeyVault({ passphrase: PASS_R }), clock: () => T })
  await limR1.accept({ chainId: 56, agentKey })
  await limR1.keepKey({ chainId: 56, agentKey, secret: AGENT_PK })
  await limR1.start({ chainId: 56, check })
  const payR1 = limR1.payer({ chainId: 56, payer: createTapeAPI({ chainId: 56, clock: () => T, conform: false }).payer({ consumer: holder, sessionKey: AGENT_PK, sessionExpiry: EXPIRES, store: payerStoreR }), maxPrice: PRICE })
  const vouchersR1 = []
  for (let i = 0; i < 2; i++) { const l = await payR1.reserve(svc, PRICE); await l.commit(); vouchersR1.push(l.voucher) }
  if ([...shared.values()].some((x) => String(x).toLowerCase().includes(AGENT_PK.slice(2)))) throw new Error('scenario R: the agent key is in the store in the clear')
  const limR2 = createSpendLimiter({ store: storeR, vault: passphraseKeyVault({ passphrase: PASS_R }), clock: () => RESTART_AT })
  const resumed = await limR2.resume({ chainId: 56, agentKey, check: { ...check, scope: [{ provider: PROVIDER, escrow: E1, claimedAtCheck: (2n * PRICE).toString() }] } })
  if (resumed.secret.toLowerCase() !== AGENT_PK.toLowerCase() || resumed.record.providers[0].base !== '0') throw new Error('scenario R: the resumed key or base is not the one kept')
  const payR2 = limR2.payer({ chainId: 56, payer: createTapeAPI({ chainId: 56, clock: () => RESTART_AT, conform: false }).payer({ consumer: holder, sessionKey: resumed.secret, sessionExpiry: EXPIRES, store: payerStoreR }), maxPrice: PRICE })
  const vouchersR2 = []
  let refusedR = null
  for (let i = 0; i < 10 && !refusedR; i++) {
    try { const l = await payR2.reserve(svc, PRICE); await l.commit(); vouchersR2.push(l.voucher) } catch (e) { refusedR = e.data?.reason ?? e.code }
  }
  if (refusedR !== 'spend-cap-exceeded' || vouchersR2.length !== 3 || BigInt(vouchersR2[2].cumulative) !== CAP) throw new Error(`scenario R: the resumed limiter did not stop at the cap: ${vouchersR2.length} vouchers, ${refusedR}`)
  // the agent stopped after three calls were settled: the close-out takes back the rest
  const closeAt = T + 7200
  const close = closeOutPlan(m, { chainId: 56, path: 'holder', holder, now: closeAt, history: plan.record, channels: [{ provider: PROVIDER, escrow: E1, channel: (CAP - 3n * PRICE).toString(), pending: null }] })
  const A = (a) => checksumAddress(a)
  const txs = (name, steps) => [
    `    function ${name}() internal pure returns (Tx[] memory t) {`,
    `        t = new Tx[](${steps.length});`,
    ...steps.map((s, i) => `        t[${i}] = Tx(${A(s.tx.to)}, ${BigInt(s.tx.value)}, hex"${s.tx.data.slice(2)}"); // ${s.kind}${s.amount ? ` ${s.amount}` : ''}`),
    '    }',
  ]
  const lines = [
    '// SPDX-License-Identifier: MIT',
    'pragma solidity ^0.8.24;',
    '',
    '// GENERATED by scripts/gen-phase1-spend-fixture.mjs from the SDK (escrowPlan, createSpendLimiter around api.payer,',
    '// closeOutPlan); do not edit. sdk/test/agent-phase1-spend.test.mjs checks it. / 由脚本生成，勿手改。',
    'library Phase1SpendFixture {',
    '    struct Tx { address to; uint256 value; bytes data; }',
    '    struct Voucher { uint256 cumulative; uint64 expires; bytes sig; }',
    `    address internal constant HOLDER = ${A(holder)};`,
    `    address internal constant AGENT_KEY = ${A(agentKey)};`,
    `    address internal constant PROVIDER = ${A(PROVIDER)};`,
    `    address internal constant E1 = ${A(E1)};`,
    `    address internal constant TOKEN = ${A(TOKEN)};`,
    `    uint64 internal constant EXPIRES = ${EXPIRES};`,
    `    uint256 internal constant T = ${T};`,
    `    uint256 internal constant CLOSE_AT = ${closeAt};`,
    `    uint256 internal constant PRICE = ${PRICE};`,
    `    uint256 internal constant CAP = ${CAP};`,
    `    // the limiter refused the next voucher (${refused}): no voucher above the cap was ever signed`,
    `    uint256 internal constant SIGNED = ${vouchers.length};`,
    ...txs('plan', plan.steps),
    `    function vouchers() internal pure returns (Voucher[] memory v) {`,
    `        v = new Voucher[](${vouchers.length});`,
    ...vouchers.map((x, i) => `        v[${i}] = Voucher(${x.cumulative}, ${x.expires}, hex"${x.sig.slice(2)}");`),
    '    }',
    ...txs('closeOut', close.steps),
    `    // scenario B (review p1m4): claimedAtCheck = BASE_B, the holder's own settlement before the plan; the limiter`,
    `    // refused the next voucher (${refusedB}) / 场景 B：开工时 claimedOf 为 BASE_B`,
    `    uint256 internal constant BASE_B = ${BASE_B};`,
    `    uint256 internal constant SIGNED_B = ${vouchersB.length};`,
    `    function holderOwnB() internal pure returns (Voucher memory) {`,
    `        return Voucher(${holderOwn.cumulative}, ${holderOwn.expires}, hex"${holderSig.slice(2)}");`,
    '    }',
    ...txs('planB', planB.steps),
    `    function vouchersB() internal pure returns (Voucher[] memory v) {`,
    `        v = new Voucher[](${vouchersB.length});`,
    ...vouchersB.map((x, i) => `        v[${i}] = Voucher(${x.cumulative}, ${x.expires}, hex"${x.sig.slice(2)}");`),
    '    }',
    `    // scenario R (phase 1, restart): ${vouchersR1.length} vouchers before the restart, ${vouchersR2.length} after it with the key resumed from its`,
    `    // sealed form; the resumed limiter refused the next (${refusedR}) / 场景 R：重启前后签出的凭证`,
    `    uint256 internal constant RESTART_AT = ${RESTART_AT};`,
    `    uint256 internal constant SIGNED_R1 = ${vouchersR1.length};`,
    `    uint256 internal constant SIGNED_R2 = ${vouchersR2.length};`,
    `    function vouchersR1() internal pure returns (Voucher[] memory v) {`,
    `        v = new Voucher[](${vouchersR1.length});`,
    ...vouchersR1.map((x, i) => `        v[${i}] = Voucher(${x.cumulative}, ${x.expires}, hex"${x.sig.slice(2)}");`),
    '    }',
    `    function vouchersR2() internal pure returns (Voucher[] memory v) {`,
    `        v = new Voucher[](${vouchersR2.length});`,
    ...vouchersR2.map((x, i) => `        v[${i}] = Voucher(${x.cumulative}, ${x.expires}, hex"${x.sig.slice(2)}");`),
    '    }',
    '}',
    '',
  ]
  return lines.join('\n')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(SPEND_FIXTURE_PATH, await phase1SpendFixture())
  console.log(' wrote ' + SPEND_FIXTURE_PATH)
}
