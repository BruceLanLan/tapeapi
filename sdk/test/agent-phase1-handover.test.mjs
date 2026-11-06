// Container agents, phase 1 (experimental): the buyer's scan before funding (session-key handover design (d); plan B
// §2.2 P-9; known limitation "session keys survive the NFT transfer"). The escrow binds a session to the consumer
// ADDRESS: on the container path that is the principal container, so every session a previous holder authorised there
// lives until its expires and spends what the new holder funds. kit.inheritedSessions scans the SessionAuthorized logs
// (from a block at least MAX_SESSION old to the pin) and reports the live sessions the console's history does not record;
// holderPlan({ sessionScan }) refuses on them, on logs it cannot read, and on a scan that starts too late. Nothing here
// makes a session end: it only makes the exposure visible (the escrow has no revoke). Fake chain, fixed clock. Every case
// named FIXED P1HO-xx was checked by removing the line that implements it.
// 阶段 1（实验）：买家出资前的扫描（会话钥匙转手设计 (d)）。托管把会话绑在 consumer 地址上：容器路径上就是委托方容器，前持有人在那里
// 授权的会话在到期前一直有效，会花掉新持有人充的钱。kit.inheritedSessions 扫 SessionAuthorized 日志，报告历史里没有的存活会话；
// holderPlan({ sessionScan }) 遇到它们、日志读不到、扫描起点太晚都拒绝。这里没有任何东西能让会话失效，只是让暴露可见。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as agent from '@tapeapi/sdk/agent'
import { keccak256, toHex } from '../src/abi.js'
import { standardWorld, mandateOf, KEYS, addrOf, P, S, S2, RPC, NOW, HEAD_TIME, BEM_TOKEN, nameEscrow, escrowContract } from './helpers/agent-chain.mjs'

const { createAgentKit, sessionHistory, MAX_SESSION_S } = agent
const HOLDER = addrOf(KEYS.principalHolder)
const OLD_KEY = addrOf(KEYS.stranger)          // a key the previous holder authorised / 前持有人授权的钥匙
const E1 = '0x' + 'e1'.repeat(20)
const E2 = '0x' + 'e2'.repeat(20)
// review OPS-A5: an escrow's constructor log, TreasuryChanged(0, treasury), at its deployment block: the probe that
// proves the nodes' log window reaches back / 托管构造函数的日志（部署块上）：证明节点日志窗口回得到那么远的探针
const TREASURY_CHANGED = toHex(keccak256('TreasuryChanged(address,address)'))
const pad = (a) => '0x' + '00'.repeat(12) + a.slice(2).toLowerCase()
function deployLog(x, escrow, block) {
  x.st.logs.push({ address: escrow.toLowerCase(), topics: [TREASURY_CHANGED, '0x' + '00'.repeat(32), pad('0x' + '7e'.repeat(20))], data: '0x', blockNumber: block, logIndex: x.st.logs.length, transactionHash: '0x' + String(x.st.logs.length).padStart(64, 'd') })
}
const FEE = 200000000000000n
const EXPIRES = NOW + 86400
const m1 = (o = {}) => mandateOf({ mode: 1, expires: EXPIRES, scope: [{ provider: S, token: BEM_TOKEN, cap: '100' }], ...o })
// the container path's world: P deployed and opened, its execute the holder's and taking FEE; S on E1 holding BEM
// 容器路径的世界：P 已部署并开通，execute 归持有人、收 FEE；S 在 E1 上，托管 BEM
function world() {
  const x = standardWorld()
  nameEscrow(x, S, E1); nameEscrow(x, S2, E1); escrowContract(x, E1, BEM_TOKEN)
  x.chain.setCode(P); x.setExecute(P, { fee: FEE, owner: HOLDER })
  deployLog(x, E1, DEPLOY(x)); deployLog(x, E2, DEPLOY(x))
  return x
}
// a previous holder's session on (P, provider): its log, and the escrow's sessionExpiry / 前持有人在 (P, provider) 上的会话：日志与托管读数
function oldSession(x, { provider = S, key = OLD_KEY, expires = NOW + 10 * 86400, block = x.st.block - 1000, onChain = expires } = {}) {
  x.sessionLog({ escrow: E1, consumer: P, provider, key, expires, block })
  x.chain.setSession(P, provider, key, onChain)
}
// the block whose time is `t` on this fake chain (one block a second, the head at HEAD_TIME) / 本假链上时间为 t 的块
const blockAt = (x, t) => x.st.block - (HEAD_TIME - t)
const FROM = (x) => blockAt(x, NOW - MAX_SESSION_S) - 10
const DEPLOY = (x) => FROM(x) - 100
const DB = (x) => ({ [E1]: DEPLOY(x), [E2]: DEPLOY(x) })
const kitOf = (x) => createAgentKit(x.api(), { clock: () => NOW, allowEscrows: [E1] })
const kitReason = async (p) => { try { await p; return 'ACCEPTED' } catch (e) { return e.data?.reason ?? e.code } }
const plan = (x, o = {}) => kitOf(x).holderPlan(m1(), { history: [], holder: HOLDER, path: 'container', maxExecuteFee: FEE, ...o })

test('FIXED P1HO-01: a previous holder\'s live session on the principal\'s channel is found and reported as facts (not in this console\'s history; the log names no holder)', async () => {
  const x = world()
  oldSession(x)
  const r = await kitOf(x).inheritedSessions(m1(), { path: 'container', history: [], fromBlock: FROM(x), deployBlocks: DB(x) })
  assert.equal(r.ok, false); assert.equal(r.status, 'inherited'); assert.equal(r.reason, 'inherited-session-live')
  assert.equal(r.consumer, P)
  assert.deepEqual(r.sessions.map((s) => [s.escrow.toLowerCase(), s.consumer, s.provider.toLowerCase(), s.key, s.expires, s.block]), [[E1, P, S, OLD_KEY, NOW + 10 * 86400, x.st.block - 1000]])
  assert.match(r.message, /history does not record/); assert.match(r.message, /cannot be revoked/)
  assert.ok(r.fromTime <= NOW - MAX_SESSION_S)
  assert.deepEqual(r.escrows.map((e) => e.toLowerCase()), [E1])
})

test('FIXED P1HO-02: holderPlan with sessionScan refuses inherited-session-live with the sessions; refuse: false returns the plan with the facts and a note', async () => {
  const x = world()
  oldSession(x)
  const e = await plan(x, { sessionScan: { fromBlock: FROM(x), deployBlocks: DB(x) } }).catch((err) => err)
  assert.equal(e.code, 'INVALID_ARGUMENT'); assert.equal(e.data.reason, 'inherited-session-live')
  assert.deepEqual(e.data.sessions.map((s) => s.key), [OLD_KEY])
  assert.match(e.message, /nothing was planned/)
  const p = await plan(x, { sessionScan: { fromBlock: FROM(x), deployBlocks: DB(x), refuse: false } })
  assert.equal(p.sessionScan.status, 'inherited')
  assert.ok(p.steps.length > 0)
  assert.ok(p.notes.some((n) => /^sessionScan \(refuse: false\)/.test(n)))
  // without sessionScan, the container path says the logs were not scanned; the holder path does not
  // 不给 sessionScan：容器路径写明没有扫日志；持有人路径不写
  const bare = await plan(x)
  assert.equal(bare.sessionScan, null)
  assert.ok(bare.notes.some((n) => /were not scanned/.test(n) && /previous holder/.test(n)))
  const holderPath = await kitOf(x).holderPlan(m1(), { history: [], holder: HOLDER })
  assert.ok(!holderPath.notes.some((n) => /were not scanned/.test(n)))
})

test('FIXED P1HO-03: what is not inherited: a session the history records, an ended one, one on a provider without a cap; the escrow\'s own reading wins', async () => {
  const x = world()
  // the console's own session (in its history) / 控制台自己的会话（在历史里）
  oldSession(x, { key: addrOf(KEYS.agentSigner) })
  const h = sessionHistory([{ chainId: 56, escrow: E1, consumer: P, provider: S, key: addrOf(KEYS.agentSigner), expires: NOW + 5 * 86400, mandateHash: null }])
  // ended: the log says so and the escrow agrees / 已结束
  oldSession(x, { key: addrOf(KEYS.providerHolder), expires: NOW - 1 })
  // on S2, not a capped provider of this mandate / 在 S2 上：不是本授权书带金额的 provider
  oldSession(x, { provider: S2 })
  const clear = await kitOf(x).inheritedSessions(m1(), { path: 'container', history: h.entries(), fromBlock: FROM(x), deployBlocks: DB(x) })
  assert.equal(clear.ok, true); assert.equal(clear.status, 'clear'); assert.equal(clear.reason, null); assert.deepEqual(clear.sessions, [])
  assert.match(clear.message, /after the pin is not seen/)
  // a session the history records is the history's rule, channel-session-live (draft §2.3 rule 3), not the scan's
  // 历史记着的会话归历史的规则管（channel-session-live），不归扫描
  assert.equal(await kitReason(plan(x, { history: h.entries(), sessionScan: { fromBlock: FROM(x), deployBlocks: DB(x) } })), 'channel-session-live')
  // extended since its log: the escrow's sessionExpiry at the pin is reported / 日志之后又延长过：报告钉块上的 sessionExpiry
  const y = world()
  oldSession(y, { expires: NOW + 86400, onChain: NOW + 20 * 86400 })
  const r = await kitOf(y).inheritedSessions(m1(), { path: 'container', history: [], fromBlock: FROM(y), deployBlocks: DB(y) })
  assert.deepEqual(r.sessions.map((s) => s.expires), [NOW + 20 * 86400])
  // two logs of one key (an extension): one session, the latest / 同一钥匙两条日志（延长）：一个会话，取最新
  const z = world()
  // (the later log first: the latest is chosen by expiry, not by the order the nodes return logs in / 后一条先给：按到期取最新，不按节点返回顺序)
  oldSession(z, { expires: NOW + 3 * 86400, block: z.st.block - 1500 }); oldSession(z, { expires: NOW + 86400, block: z.st.block - 2000, onChain: NOW + 3 * 86400 })
  const two = await kitOf(z).inheritedSessions(m1(), { path: 'container', history: [], fromBlock: FROM(z), deployBlocks: DB(z) })
  assert.deepEqual(two.sessions.map((s) => [s.expires, s.block]), [[NOW + 3 * 86400, z.st.block - 1500]])
})

test('FIXED P1HO-04: logs that cannot be read refuse funding (session-logs-unavailable), never "no keys"; a scan that starts less than MAX_SESSION ago is session-scan-short', async () => {
  const x = world()
  oldSession(x)
  // one node answers no logs: the nodes disagree / 一个节点不给日志：节点不一致
  x.lie(RPC[1], (method, params, honest) => (method === 'eth_getLogs' ? [] : honest))
  const u = await kitOf(x).inheritedSessions(m1(), { path: 'container', history: [], fromBlock: FROM(x), deployBlocks: DB(x) })
  assert.equal(u.ok, false); assert.equal(u.status, 'unavailable'); assert.equal(u.reason, 'session-logs-unavailable')
  assert.match(u.message, /do not fund/); assert.deepEqual(u.sessions, [])
  assert.equal(await kitReason(plan(x, { sessionScan: { fromBlock: FROM(x), deployBlocks: DB(x) } })), 'session-logs-unavailable')
  // a node that refuses eth_getLogs outright, as BNB Chain's dataseed nodes do / 像 dataseed 那样直接拒绝 eth_getLogs
  x.lie(RPC[1], (method, params, honest) => { if (method === 'eth_getLogs') throw new Error('limit exceeded'); return honest })
  assert.equal(await kitReason(plan(x, { sessionScan: { fromBlock: FROM(x), deployBlocks: DB(x) } })), 'session-logs-unavailable')
  x.lie(RPC[1], null)
  // too recent: a session authorised before fromBlock may still be live / 起点太近：起点之前授权的会话可能仍有效
  const short = await kitOf(x).inheritedSessions(m1(), { path: 'container', history: [], fromBlock: blockAt(x, NOW - MAX_SESSION_S) + 60 })
  assert.equal(short.status, 'short'); assert.equal(short.reason, 'session-scan-short')
  assert.equal(await kitReason(plan(x, { sessionScan: { fromBlock: x.st.block - 100 } })), 'session-scan-short')
  // refuse: false does not hide it either: the plan carries it / refuse: false 也不隐藏：计划里带着
  assert.equal((await plan(x, { sessionScan: { fromBlock: x.st.block - 100, refuse: false } })).sessionScan.status, 'short')
})

test('FIXED P1HO-05: the scan is chunked as asked, reads every escrow the history names for a capped provider, and checks its arguments', async () => {
  const x = world()
  oldSession(x)
  const asked = []
  for (const u of RPC) x.lie(u, (method, params, honest) => { if (method === 'eth_getLogs' && String(params[0].topics?.[0]).toLowerCase() !== TREASURY_CHANGED) asked.push([Number(BigInt(params[0].fromBlock)), Number(BigInt(params[0].toBlock)), params[0].address]); return honest })
  const from = FROM(x)
  const r = await kitOf(x).inheritedSessions(m1(), { path: 'container', history: [], fromBlock: from, deployBlocks: DB(x), chunk: 4_000_000 })
  assert.equal(r.status, 'inherited')
  const ranges = [...new Set(asked.map((a) => `${a[0]}-${a[1]}`))]
  assert.equal(ranges.length, Math.ceil((r.toBlock - from + 1) / 4_000_000))
  assert.equal(Math.min(...asked.map((a) => a[0])), from); assert.equal(Math.max(...asked.map((a) => a[1])), r.toBlock)
  for (const u of RPC) x.lie(u, null)
  // an escrow the provider no longer names, recorded in the history: scanned too / provider 已不再写明、历史里记着的托管：也扫
  escrowContract(x, E2, BEM_TOKEN)
  x.sessionLog({ escrow: E2, consumer: P, provider: S, key: addrOf(KEYS.providerSigner), expires: NOW + 86400, block: x.st.block - 500 })
  x.chain.setSession(P, S, addrOf(KEYS.providerSigner), NOW + 86400)
  const hist = [{ chainId: 56, escrow: E2, consumer: P, provider: S, key: addrOf(KEYS.agentSigner), expires: NOW + 60, mandateHash: null }]
  const both = await kitOf(x).inheritedSessions(m1(), { path: 'container', history: hist, fromBlock: from, deployBlocks: DB(x) })
  assert.deepEqual(both.escrows.map((e) => e.toLowerCase()).sort(), [E1, E2].sort())
  assert.deepEqual(both.sessions.map((s) => s.key).sort(), [OLD_KEY, addrOf(KEYS.providerSigner)].sort())
  // arguments / 参数
  const k = kitOf(x)
  for (const bad of [{ history: [] }, { history: [], fromBlock: -1 }, { history: [], fromBlock: from, chunk: 0 }, { fromBlock: from }, { history: [], fromBlock: x.st.block + 10 }]) {
    assert.equal(await kitReason(k.inheritedSessions(m1(), { path: 'container', ...bad })), 'INVALID_ARGUMENT', JSON.stringify(bad))
  }
  assert.equal(await kitReason(k.inheritedSessions(m1(), { path: 'holder', history: [], fromBlock: from })), 'INVALID_ARGUMENT', 'the holder path needs holder')
  assert.equal(await kitReason(plan(x, { sessionScan: 5 })), 'INVALID_ARGUMENT')
  assert.equal(await kitReason(plan(x, { sessionScan: { fromBlock: from, refuse: 'no' } })), 'INVALID_ARGUMENT')
})

// ---- review 2026-10-22: coverage and boundaries of the scan / 审查：扫描的覆盖与边界 ----
test('FIXED OPS-A5: nodes whose log window does not reach back answer an EMPTY list; that is session-logs-unavailable, never "clear"', async () => {
  const x = world()
  oldSession(x)
  // every node keeps the last 1,000 blocks of logs and answers [] (no error) for anything older, as pruned nodes do
  // 每个节点只保留最近 1,000 块的日志，更早的答空列表（不报错），像裁剪过的节点那样
  const head = x.st.block
  for (const u of RPC) x.lie(u, (method, params, honest) => (method === 'eth_getLogs' && Number(BigInt(params[0].fromBlock)) < head - 1000 ? [] : honest))
  const r = await kitOf(x).inheritedSessions(m1(), { path: 'container', history: [], fromBlock: FROM(x), deployBlocks: DB(x) })
  assert.equal(r.status, 'unavailable', 'before the fix: clear (the empty answers read as no sessions)'); assert.equal(r.reason, 'session-logs-unavailable')
  assert.match(r.message, /constructor log/); assert.match(r.message, /do not fund/)
  assert.equal(await kitReason(plan(x, { sessionScan: { fromBlock: FROM(x), deployBlocks: DB(x) } })), 'session-logs-unavailable')
  for (const u of RPC) x.lie(u, null)
  // no deployment block for a scanned escrow: coverage not proven / 被扫托管没有部署块：覆盖未证明
  const n = await kitOf(x).inheritedSessions(m1(), { path: 'container', history: [], fromBlock: FROM(x) })
  assert.equal(n.reason, 'session-logs-unavailable'); assert.match(n.message, /not proven/)
  assert.equal(await kitReason(plan(x, { sessionScan: { fromBlock: FROM(x) } })), 'session-logs-unavailable')
  // a wrong deployment block (no constructor log there) is unavailable too; a malformed map is INVALID_ARGUMENT
  // 部署块写错（那里没有构造函数日志）也是 unavailable；格式不对是 INVALID_ARGUMENT
  assert.equal((await kitOf(x).inheritedSessions(m1(), { path: 'container', history: [], fromBlock: FROM(x), deployBlocks: { [E1]: DEPLOY(x) + 1 } })).reason, 'session-logs-unavailable')
  assert.equal(await kitReason(kitOf(x).inheritedSessions(m1(), { path: 'container', history: [], fromBlock: FROM(x), deployBlocks: { [E1]: -1 } })), 'INVALID_ARGUMENT')
  // the honest archive case still finds the session / 诚实的归档节点照样找到会话
  assert.equal((await kitOf(x).inheritedSessions(m1(), { path: 'container', history: [], fromBlock: FROM(x), deployBlocks: DB(x) })).status, 'inherited')
})

test('FIXED OPS-A4: a session whose expiry IS now is live (settle accepts sessionExpiry >= block.timestamp); a scan from a block of exactly now − 30 days is short', async () => {
  const x = world()
  oldSession(x, { expires: NOW })
  const r = await kitOf(x).inheritedSessions(m1(), { path: 'container', history: [], fromBlock: FROM(x), deployBlocks: DB(x) })
  assert.equal(r.status, 'inherited', 'before the fix: clear'); assert.deepEqual(r.sessions.map((s) => s.expires), [NOW])
  const y = world()
  oldSession(y, { expires: NOW - 1 })
  assert.equal((await kitOf(y).inheritedSessions(m1(), { path: 'container', history: [], fromBlock: FROM(y), deployBlocks: DB(y) })).status, 'clear')
  // fromTime == now − MAX_SESSION exactly: a block of that same second may precede it / 恰好 30 天：同一秒里更早的块可能在它之前
  const at = await kitOf(y).inheritedSessions(m1(), { path: 'container', history: [], fromBlock: blockAt(y, NOW - MAX_SESSION_S), deployBlocks: DB(y) })
  assert.equal(at.status, 'short', 'before the fix: clear'); assert.match(at.message, /not earlier than/)
  assert.equal((await kitOf(y).inheritedSessions(m1(), { path: 'container', history: [], fromBlock: blockAt(y, NOW - MAX_SESSION_S) - 1, deployBlocks: DB(y) })).status, 'clear')
})

test('FIXED OPS-A6 (decision 5): the scan judges liveness by the chain\'s time when the caller\'s clock is ahead of it', async () => {
  const x = world()
  x.chain.state.headTime = NOW - 100   // the chain is 100 s behind the console's clock / 链比控制台时钟慢 100 秒
  oldSession(x, { expires: NOW - 50 })
  const r = await kitOf(x).inheritedSessions(m1(), { path: 'container', history: [], fromBlock: FROM(x), deployBlocks: DB(x) })
  assert.equal(r.status, 'inherited', 'before the fix: clear (the clock called a session the chain still honours ended)')
})
