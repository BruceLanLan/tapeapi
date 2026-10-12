// Container agents phase 1, M3 (experimental): the very transactions the SDK's escrowPlan and closeOutPlan
// build over spec/vectors/container-agent.json, written as Solidity constants for contracts/test/Phase1Plan.t.sol, which
// executes them on the unchanged v3 escrow (a test-local deployment, nothing broadcast). sdk/test/agent-phase1-plan.test.mjs
// checks that the file is what this script writes, so the plan the SDK builds and the plan forge executes cannot drift.
//   node scripts/gen-phase1-plan-fixture.mjs        writes contracts/test/Phase1PlanFixture.sol
// 阶段 1 的 M3：把 SDK 的 escrowPlan / closeOutPlan 在向量上构造的交易写成 Solidity 常量，供 Phase1Plan.t.sol 在未改的 v3 托管上执行。
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { escrowPlan, closeOutPlan, requireHistory } from '../sdk/src/agent-pay.js'
import { checksumAddress } from '../sdk/src/abi.js'

const ROOT = new URL('../', import.meta.url)
export const FIXTURE_PATH = fileURLToPath(new URL('contracts/test/Phase1PlanFixture.sol', ROOT))

export function phase1PlanFixture() {
  const v = JSON.parse(readFileSync(new URL('spec/vectors/container-agent.json', ROOT), 'utf8')).phase1
  const base = v.planBase
  const byName = (name) => { const c = v.plan.find((x) => x.name === name); if (!c) throw new Error(`no plan vector ${name}`); return c }
  const opts = (c) => ({ chainId: base.chainId, path: c.path, providers: c.providers, allowEscrows: base.allowEscrows, ...(c.path === 'holder' ? { holder: base.holder } : { executeFee: base.executeFee, maxExecuteFee: base.maxExecuteFee, holder: base.holder }) })
  const two = byName('holder path, two providers on one escrow, one channel partly funded: one approve of the sum')
  const twoEsc = byName('holder path, two providers on two escrows (one token each): two approves')
  const f1 = byName('container path: the same steps, each through the principal\'s execute with the caller\'s fee')
  const pTwo = escrowPlan(two.mandate, opts(two))
  const pTwoEsc = escrowPlan(twoEsc.mandate, opts(twoEsc))
  const pF1 = escrowPlan(f1.mandate, opts(f1))
  // review p1m3 B1: the one-provider plan (cap 1e8) made on a fresh escrow (claimedOf 0), then the plan run again over
  // the chain after it was applied, with that plan's record in the session history: after the key spent 6e7 (channel
  // 4e7), after a fund failed (channel 0, nothing spent), and after the key spent 6e7 and the channel holds 2e7
  // 审查 p1m3 B1：一个 provider 的计划（cap 1e8）在新托管上做出（claimedOf 0），计划应用后带着它的 record 重跑
  const one = byName('holder path, one provider, an empty channel')
  const cap1 = BigInt(one.mandate.scope[0].cap)
  const pOne = escrowPlan(one.mandate, { ...opts(one), providers: [{ ...one.providers[0], claimed: '0' }] })
  const rerun = (channel, claimed, history) => {
    const o = { ...opts(one), providers: [{ ...one.providers[0], channel: channel.toString(), session: one.mandate.expires, claimed: claimed.toString() }], now: one.mandate.notBefore, hub: base.hub, history }
    try { return escrowPlan(one.mandate, o) } catch (e) { return { refused: e.data?.reason ?? e.code } }
  }
  const spent = cap1 * 6n / 10n
  const rSpent = rerun(cap1 - spent, spent, pOne.record), rFailed = rerun(0n, 0n, pOne.record), rPartial = rerun(cap1 / 5n, spent, pOne.record)
  const rBare = rerun(cap1 - spent, spent, [])
  for (const r of [rSpent, rFailed, rPartial]) if (r.refused) throw new Error(`the re-run was refused: ${r.refused}`)
  // review p1m3 recheck CE-3 / CE-4: the one-provider mandate with a 10-day window (a withdraw takes 48 h), planned on E1;
  // the key spends SPENT; then the provider's manifest names E3 (same token), or the circuit changes hands. The SDK's
  // re-runs with the first plan's record: refused while E1 still holds money (or nothing says it is empty), and for
  // another consumer; once E1 is withdrawn to 0, E3 is funded to CAP1 - SPENT only
  // 复核 CE-3、CE-4：10 天窗口的单 provider 授权书在 E1 上计划；钥匙花掉 SPENT；随后清单改为 E3，或电路转手。带首次 record 重跑：
  // E1 仍有钱（或没有事实说明已空）时拒绝，别的 consumer 拒绝；E1 取回到 0 后 E3 只充 CAP1 − SPENT
  const E3 = '0x00000000000000000000000000000000000E5c73', STRANGER = '0x00000000000000000000000000000000000000Aa'
  const longM = { ...one.mandate, expires: one.mandate.notBefore + 10 * 86400 }
  const lOpts = { chainId: base.chainId, path: 'holder', holder: base.holder, allowEscrows: base.allowEscrows, hub: base.hub, now: one.mandate.notBefore }
  const pLong = escrowPlan(longM, { ...lOpts, providers: [{ ...one.providers[0], claimed: '0' }] })
  const P1one = one.providers[0].provider, E1one = one.providers[0].escrow, T1one = one.providers[0].token
  const tryPlan = (m, o) => { try { return escrowPlan(m, o) } catch (e) { return { refused: e.data?.reason ?? e.code } } }
  const old1 = (o) => [{ escrow: E1one, consumer: base.holder, channel: '0', pendingLive: false, claimed: spent.toString(), ...o }]
  const moved = (elsewhere) => tryPlan(longM, { ...lOpts, history: pLong.record, providers: [{ provider: P1one, escrow: E3, token: T1one, channel: '0', session: '0', claimed: '0', ...(elsewhere ? { elsewhere } : {}) }] })
  const movedRefused = [moved(undefined), moved(old1({ channel: (cap1 - spent).toString() })), moved(old1({ pendingLive: true }))].every((r) => r.refused === 'funded-elsewhere')
  const rMoved = moved(old1({}))
  if (rMoved.refused) throw new Error(`the released re-run on E3 was refused: ${rMoved.refused}`)
  const rNewHolder = tryPlan(longM, { ...lOpts, holder: STRANGER, history: pLong.record, providers: [{ provider: P1one, escrow: E1one, token: T1one, channel: '0', session: '0', claimed: '0', elsewhere: old1({}) }] })
  // review p1m3 recheck 3 (N1): the same move to E3, re-run WITHOUT a history: the kit refuses it before reading anything
  // (requireHistory is the kit's own check); with history [] (the console saying it has none while it had a record) the
  // plan is a whole cap on E3: the documented premise, not a rule / 复核 3：不带历史的重跑被 kit 拒绝；历史为 [] 时整笔 cap（前提，非规则）
  const noHistoryRefused = (() => { try { requireHistory({ holder: base.holder }, 'holderPlan'); return false } catch (e) { return e.code === 'INVALID_ARGUMENT' } })()
  const rEmpty = tryPlan(longM, { ...lOpts, history: [], providers: [{ provider: P1one, escrow: E3, token: T1one, channel: '0', session: '0', claimed: '0' }] })
  if (rEmpty.refused) throw new Error(`the re-run with history [] was refused: ${rEmpty.refused}`)
  const cLongE1 = closeOutPlan(longM, { chainId: base.chainId, holder: base.holder, now: one.mandate.notBefore, channels: [{ provider: P1one, escrow: E1one, channel: (cap1 - spent).toString() }], history: pLong.record })
  // the close-out of each plan's channels once funded, no request yet, the mandate expired / 计划充好之后、授权书到期时的收尾
  const now = two.mandate.expires + 600
  const P1 = two.providers[0].provider, P2 = two.providers[1].provider, E1 = two.providers[0].escrow
  const cTwo = closeOutPlan(two.mandate, { chainId: base.chainId, holder: base.holder, now, channels: [{ provider: P1, escrow: E1, channel: '100' }, { provider: P2, escrow: E1, channel: '50' }] })
  const cF1 = closeOutPlan(f1.mandate, { chainId: base.chainId, path: 'container', now, executeFee: base.executeFee, maxExecuteFee: base.maxExecuteFee, channels: [{ provider: f1.providers[0].provider, escrow: f1.providers[0].escrow, channel: f1.mandate.scope[0].cap }] })
  const A = (a) => checksumAddress(a)
  const txs = (name, steps) => [
    `    function ${name}() internal pure returns (Tx[] memory t) {`,
    `        t = new Tx[](${steps.length});`,
    ...steps.map((s, i) => `        t[${i}] = Tx(${A(s.tx.to)}, ${BigInt(s.tx.value)}, hex"${s.tx.data.slice(2)}"); // ${s.kind}${s.provider ? ` ${A(s.provider)}` : ''}${s.amount ? ` ${s.amount}` : ''}`),
    '    }',
  ]
  const lines = [
    '// SPDX-License-Identifier: MIT',
    'pragma solidity ^0.8.24;',
    '',
    '// GENERATED by scripts/gen-phase1-plan-fixture.mjs from the SDK\'s escrowPlan and closeOutPlan over',
    '// spec/vectors/container-agent.json (phase1.plan); do not edit. sdk/test/agent-phase1-plan.test.mjs checks it.',
    '// 由 scripts/gen-phase1-plan-fixture.mjs 生成，勿手改。',
    'library Phase1PlanFixture {',
    '    struct Tx { address to; uint256 value; bytes data; }',
    `    address internal constant HOLDER = ${A(base.holder)};`,
    `    address internal constant PRINCIPAL = ${A(two.mandate.principal)};`,
    `    address internal constant AGENT_KEY = ${A(two.mandate.agentKey)};`,
    `    address internal constant P1 = ${A(P1)};`,
    `    address internal constant P2 = ${A(P2)};`,
    `    address internal constant E1 = ${A(E1)};`,
    `    address internal constant E2 = ${A(twoEsc.providers[0].escrow)};`,
    `    address internal constant TOKEN1 = ${A(two.providers[0].token)};`,
    `    address internal constant TOKEN2 = ${A(twoEsc.providers[0].token)};`,
    `    uint64 internal constant NOT_BEFORE = ${two.mandate.notBefore};`,
    `    uint64 internal constant EXPIRES = ${two.mandate.expires};`,
    `    uint256 internal constant EXECUTE_FEE = ${BigInt(base.executeFee)};`,
    `    uint256 internal constant CLOSE_AT = ${now};`,
    `    uint256 internal constant CAP1 = ${cap1};`,
    `    uint256 internal constant SPENT = ${spent};`,
    `    // the agent key's private key in the vectors (0x77…77) / 向量里代理钥匙的私钥`,
    `    uint256 internal constant AGENT_KEY_PK = 0x${'77'.repeat(32)};`,
    `    // the re-run after the key spent SPENT, without the session history: the SDK refuses it (${rBare.refused ?? 'NOT REFUSED'})`,
    `    bool internal constant RERUN_WITHOUT_HISTORY_REFUSED = ${rBare.refused === 'channel-spent'};`,
    '    // holder path (F2): P1 cap 100, P2 cap 50 already holding 20, one escrow / 持有人路径：一个托管两个 provider',
    ...txs('holderTwoProviders', pTwo.steps),
    `    function holderTwoProvidersApproveZero() internal pure returns (Tx memory) { return Tx(${A(pTwo.checks[0].ifNot.tx.to)}, 0, hex"${pTwo.checks[0].ifNot.tx.data.slice(2)}"); }`,
    '    // holder path (F2): P1 on E1 (TOKEN1) cap 100, P2 on E2 (TOKEN2) cap 50 / 两个托管',
    ...txs('holderTwoEscrows', pTwoEsc.steps),
    `    // container path (F1): P1 cap ${f1.mandate.scope[0].cap} through the principal's execute, EXECUTE_FEE each / 容器路径`,
    ...txs('containerOne', pF1.steps),
    '    // holder path (F2): P1 cap CAP1 on E1, then the plan run again with its record (review p1m3 B1) / 重跑',
    ...txs('holderOne', pOne.steps),
    '    // ... after the key spent SPENT (channel CAP1 - SPENT): nothing to send / 钥匙花掉 SPENT 之后：无事可做',
    ...txs('holderOneRerunAfterSpend', rSpent.steps),
    '    // ... after a fund failed with the session sent (channel 0, nothing spent): funded to the cap / fund 失败之后：补到 cap',
    ...txs('holderOneRerunAfterFailedFund', rFailed.steps),
    '    // ... after the key spent SPENT and the channel holds CAP1 / 5: funded by CAP1 - SPENT - CAP1 / 5 only / 只补到预算',
    ...txs('holderOneRerunPartial', rPartial.steps),
    '    // review p1m3 recheck: the one-provider mandate with a 10-day window, E3 (TOKEN1) the escrow the provider moved to',
    `    uint64 internal constant EXPIRES_LONG = ${longM.expires};`,
    `    address internal constant E3 = ${A(E3)};`,
    `    address internal constant STRANGER = ${A(STRANGER)};`,
    '    // the re-runs on E3 with the first record while E1 holds CAP1 - SPENT, with no fact about E1, or with a live request on it',
    `    bool internal constant MOVED_RERUN_REFUSED = ${movedRefused};`,
    `    // the re-run for a new holder (STRANGER) with the old record, E1 emptied: ${rNewHolder.refused ?? 'NOT REFUSED'}`,
    `    bool internal constant NEW_HOLDER_RERUN_REFUSED = ${rNewHolder.refused === 'funded-elsewhere'};`,
    `    // the re-run on E3 WITHOUT a session history (review p1m3 recheck 3): the kit refuses it (INVALID_ARGUMENT)`,
    `    bool internal constant MOVED_RERUN_WITHOUT_HISTORY_REFUSED = ${noHistoryRefused};`,
    ...txs('holderLongOne', pLong.steps),
    ...txs('holderLongCloseOutE1', cLongE1.steps),
    '    // ... the re-run once E1 was withdrawn to 0 (claimedOf SPENT): E3 funded to CAP1 - SPENT / E1 取回到 0 后的重跑',
    ...txs('holderLongMovedToE3', rMoved.steps),
    '    // ... the re-run on E3 with history [] while the console had a record (the premise broken): a whole cap / 前提被破坏',
    ...txs('holderLongMovedToE3EmptyHistory', rEmpty.steps),
    '    // close-outs after the plans, at CLOSE_AT: requestWithdraw (whole channels), then withdraw / 收尾',
    ...txs('holderTwoProvidersCloseOut', cTwo.steps),
    ...txs('containerOneCloseOut', cF1.steps),
    '}',
    '',
  ]
  return lines.join('\n')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(FIXTURE_PATH, phase1PlanFixture())
  console.log(' wrote ' + FIXTURE_PATH)
}
