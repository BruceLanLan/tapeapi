// The TAP-10 conformance mode, in 1.5.0: resolve checks eth_chainId under strict agreement (as the messaging path does)
// and reads the holder and a contract holder's EIP-1271 answers under STRICT
// agreement (TAP-10 §5.2; TAP-11 §2.2 "SHOULD adopt ownerOf and the EIP-1271 call of §4.4 under strict agreement, since a
// forged answer to either would authorise a signer"; row 12 of the Opus draft's table). That is: ownerOf in identity (the
// manifest steps use that same answer and read none again), and eth_getCode + isValidSignature for the delegation (§4.4)
// and for contentSig (§5). Every other read of a resolution stays under default agreement, siteStatus included.
//
// What strict changes in this SDK: rpc.js round() asks EVERY node and rejects ANY split (RPC_DISAGREE) in both modes
// (TAPI-20 §3.2, no majority vote), so one node answering differently is refused with or without strict (tested below as
// a regression, not as the discriminating case). Strict adds (a) the operator count, max(2, min(3, operators)) = 3 of
// rpc1..rpc3 instead of the quorum 2, so one node that does not answer is `unavailable`; and (b) TAP-10 §1's answer rule
// (only a result or a revert is an answer). The tests that would go red without strict are the "one node does not
// answer" ones.
// TAP-10 一致模式（1.5.0 起）：resolve 用严格共识读取持有人与合约持有人的 EIP-1271 回答。本 SDK 的 round() 在两种模式下都问遍所有
// 节点、任何分歧都拒绝，所以"一个节点答得不同"有没有 strict 都被拒绝（下面作为回归测试，不是区分 strict 的用例）。strict 多出的是
// 运营方数（rpc1..rpc3 要 3 家，而不是法定数 2）与 TAP-10 §1 的回答规则；去掉 strict 会变红的是"一个节点不作答"的用例。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTapeAPI, MANIFEST_KEY, MAINNET, TapeAPIError, sig } from '../src/index.js'
import { createConformChain } from './helpers/conform-chain.mjs'
import { encodeReturn } from '../src/abi.js'

const HOLDER_KEY = '0x' + '11'.repeat(32), SIGNER_KEY = '0x' + '22'.repeat(32)
const holder = sig.privateKeyToAddress(HOLDER_KEY), signer = sig.privateKeyToAddress(SIGNER_KEY)
const SAFE = '0x' + '5a'.repeat(20)
const RPC = ['http://rpc1', 'http://rpc2', 'http://rpc3']
const T = 1_790_000_000
const EXPIRES = T + 30 * 86_400
const hexOf = (b) => (typeof b === 'string' ? b : '0x' + Buffer.from(b).toString('hex')).toLowerCase()

// A valid TAP-10 service (processor 7, #4246, opened, activated). `contract`: the holder is a smart account (SAFE) that
// approves the delegation, and the manifest's contentSig when `contentSig` is set, under EIP-1271; otherwise an EOA signs.
// 一个有效的 TAP-10 服务。contract：持有人是智能账户（SAFE），按 EIP-1271 认可委托（contentSig 为真时也认可内容签名）；否则由 EOA 签名。
function world({ chainId = 56, contract = false, contentSig = false } = {}) {
  const chain = createConformChain({ chainId })
  chain.state.headTime = T
  const c = chain.circuit(4246, { holder: contract ? SAFE : holder })
  const delegation = sig.delegationDigest(chainId, MAINNET.hub, { container: c.container, signer, expires: EXPIRES })
  const m = {
    tapeapi: '0.1', name: 'Strict', circuits: c.circuits, tokenId: c.tokenId, container: c.container, signer,
    delegation: { expires: EXPIRES, sig: contract ? '0x' + 'ab'.repeat(100) : sig.signDigest(delegation, HOLDER_KEY) },
    endpoints: { live: ['https://api.example.com/tapeapi/v1'], async: false }, methods: [{ name: 'ping', priceBEM: '0', params: {}, returns: {} }],
  }
  const content = sig.manifestContentDigest(chainId, MAINNET.hub, { container: c.container, contentHash: sig.manifestContentHash(m) })
  if (contentSig) m.contentSig = contract ? '0x' + 'cd'.repeat(100) : sig.signDigest(content, HOLDER_KEY)
  if (contract) chain.setContractHolder(SAFE, delegation, ...(contentSig ? [content] : []))
  chain.writeFile(c.container, MANIFEST_KEY, JSON.stringify(m))
  chain.setAccount(4246, c.container)   // the hub's derivation, for the default-mode controls / 默认模式对照用的 hub 推导
  return { chain, c, digests: { delegation: hexOf(delegation), content: hexOf(content) } }
}
const conformApi = (chain, o = {}) => createTapeAPI({ conform: 'tap10', rpcUrls: RPC, fetch: chain.fetch, clock: () => T, quiet: true, onWarning: () => {}, ...o })
const defaultApi = (chain, o = {}) => createTapeAPI({ rpcUrls: RPC, fetch: chain.fetch, clock: () => T, quiet: true, onWarning: () => {}, sentinel: 'off', ...o })
const isStatus = (code, status, re) => (e) => {
  assert.ok(e instanceof TapeAPIError, String(e)); assert.equal(e.code, code, e.message); assert.equal(e.data?.status, status, e.message)
  if (re) assert.match(e.message, re)
  return true
}
const since = (chain, from) => chain.conform.log.slice(from)
const OTHER_OWNER = { result: encodeReturn('ownerOf', ['0x' + '66'.repeat(20)]) }

// ── EOA holder: ownerOf / EOA 持有人：ownerOf ───────────────────────────────────────────────────────────────────────
test('ownerOf is strict on the conformance resolve: one node that does not answer it is unavailable, where the default mode and siteStatus go on with the quorum', async () => {
  const { chain, c } = world()
  chain.setCallFault('http://rpc3', 'ownerOf', 'http500')
  await assert.rejects(conformApi(chain).resolve('4246.7'), isStatus('RPC_UNAVAILABLE', 'unavailable', /ownerOf|only 2\/3/))
  await assert.rejects(conformApi(chain).resolve(c.container), isStatus('RPC_UNAVAILABLE', 'unavailable'))
  await assert.rejects(conformApi(chain).resolve({ circuits: c.circuits, tokenId: 4246 }), isStatus('RPC_UNAVAILABLE', 'unavailable'))
  // the default mode keeps default agreement (2 of 3) / 默认模式沿用默认共识
  const svc = await defaultApi(chain).resolve('4246.7')
  assert.equal(svc.container, c.container); assert.equal(svc.verified.holder, holder)
  // siteStatus authorises nothing and stays under default agreement, in both modes / siteStatus 不授权任何东西，两种模式都用默认共识
  assert.equal((await conformApi(chain).siteStatus('4246.7')).holder, holder)
  assert.equal((await defaultApi(chain).siteStatus('4246.7')).holder, holder)
  // a non-answer under TAP-10 §1 (a JSON-RPC error that is no revert) counts the same / TAP-10 §1 意义上的非回答同样处理
  chain.setCallFault('http://rpc3', 'ownerOf', 'rpcerror')
  await assert.rejects(conformApi(chain).resolve('4246.7'), isStatus('RPC_UNAVAILABLE', 'unavailable'))
  chain.setCallFault('http://rpc3', 'ownerOf', null)
  const ok = await conformApi(chain).resolve('4246.7')
  assert.equal(ok.verified.holder, holder); assert.equal(ok.conform.holder, holder)
})

test('FIXED Fable-1: with three operators, one node whose head is below the pinned block cannot answer ownerOf there ("no such block" is no answer, TAP-10 §1): resolve is unavailable, siteStatus and the default mode go on', async () => {
  const { chain, c } = world()
  chain.setHeadLag('http://rpc3', 5, { state: true })   // the pin is the second highest head minus 2: rpc3 is 3 blocks below it
  const api = conformApi(chain)
  const before = chain.conform.log.length
  await assert.rejects(api.resolve('4246.7'), isStatus('RPC_UNAVAILABLE', 'unavailable', /eth_call: only 2\/3 .*header for hash .*strict agreement \(TAP-10 §5.2\)/))
  // the default-agreement reads before it were adopted from the two nodes that have the block / 之前的默认共识读取由有该块的两个节点采用
  assert.ok(chain.conform.log.slice(before).some((x) => x.fn === 'isOpened'))
  const s = await api.siteStatus('4246.7')
  assert.equal(s.status, 'ok'); assert.equal(s.holder, holder)
  assert.equal(s.pinned.number, chain.state.block - 2)
  assert.equal((await defaultApi(chain).resolve('4246.7')).container, c.container)
  chain.setHeadLag('http://rpc3', 0)
  assert.equal((await conformApi(chain).resolve('4246.7')).verified.holder, holder)
})

test('only ownerOf and EIP-1271 are strict on the resolve path: one node not answering isOpened, fileInfo or accountOf still resolves (TAP-11 §2.2: default agreement)', async () => {
  for (const read of ['isOpened', 'fileInfo', 'accountOf', 'isContainerLive']) {
    const { chain, c } = world()
    chain.setCallFault('http://rpc3', read, 'http500')
    assert.equal((await conformApi(chain).resolve('4246.7')).container, c.container, read)
  }
})

test('one node answering ownerOf differently is refused in both modes (rpc.js never takes a majority, TAPI-20 §3.2): a regression check, not what strict adds', async () => {
  const { chain } = world()
  chain.setCallFault('http://rpc2', 'ownerOf', OTHER_OWNER)
  await assert.rejects(conformApi(chain).resolve('4246.7'), isStatus('RPC_DISAGREE', 'unavailable'))
  await assert.rejects(defaultApi(chain).resolve('4246.7'), (e) => e.code === 'RPC_DISAGREE')
  // every node agreeing on another holder: the delegation no longer verifies / 所有节点一致给出别的持有人：委托不再成立
  for (const u of RPC) chain.setCallFault(u, 'ownerOf', OTHER_OWNER)
  await assert.rejects(conformApi(chain).resolve('4246.7'), isStatus('DELEGATION_INVALID', 'delegation-invalid'))
})

test('the conformance resolve reads ownerOf once, from every node, at the pinned block hash; the manifest steps reuse that answer', async () => {
  const { chain } = world()
  const from = chain.conform.log.length
  const svc = await conformApi(chain).resolve('4246.7')
  const owners = since(chain, from).filter((x) => x.fn === 'ownerOf')
  assert.deepEqual(owners.map((x) => x.url).sort(), RPC)
  for (const x of owners) assert.deepEqual(x.block, { blockHash: svc.pinned.hash, requireCanonical: true })
})

// ── contract holder (EIP-1271): the delegation / 合约持有人：委托 ────────────────────────────────────────────────────
test('a contract holder: eth_getCode and isValidSignature for the delegation are strict, at the pinned block', async () => {
  const { chain, c } = world({ contract: true })
  const from = chain.conform.log.length
  const svc = await conformApi(chain).resolve('4246.7')
  assert.equal(svc.verified.holder.toLowerCase(), SAFE)
  const log = since(chain, from)
  for (const pick of [(x) => x.method === 'eth_getCode', (x) => x.fn === 'isValidSignature']) {
    const hits = log.filter(pick)
    assert.deepEqual(hits.map((x) => x.url).sort(), RPC)
    for (const x of hits) assert.deepEqual(x.block, { blockHash: svc.pinned.hash, requireCanonical: true })
  }
  for (const read of ['eth_getCode', 'isValidSignature']) {
    chain.setCallFault('http://rpc3', read, 'http500')
    await assert.rejects(conformApi(chain).resolve('4246.7'), isStatus('RPC_UNAVAILABLE', 'unavailable', /only 2\/3/), read)
    assert.equal((await defaultApi(chain).resolve('4246.7')).verified.holder.toLowerCase(), SAFE, `default mode, ${read}`)
    chain.setCallFault('http://rpc3', read, null)
  }
  // TAP-10 §1: a JSON-RPC error that is no revert is no answer, so it cannot be "does not approve" either
  // TAP-10 §1：不是回滚的 JSON-RPC 错误不是回答，也就不能当作"不认可"
  chain.setCallFault('http://rpc3', 'isValidSignature', 'rpcerror')
  await assert.rejects(conformApi(chain).resolve(c.container), isStatus('RPC_UNAVAILABLE', 'unavailable'))
  chain.setCallFault('http://rpc3', 'isValidSignature', null)
  // the holder no longer approves on every node: delegation-invalid / 所有节点上持有人都不再认可：delegation-invalid
  chain.state.contractHolders.set(SAFE, new Set())
  await assert.rejects(conformApi(chain).resolve('4246.7'), isStatus('DELEGATION_INVALID', 'delegation-invalid', /EIP-1271/))
})

test('isValidSignature reverting on one node while the others approve is refused (RPC_DISAGREE), never read as "does not approve" or as approval', async () => {
  const { chain } = world({ contract: true })
  chain.setCallFault('http://rpc2', 'isValidSignature', 'revert')
  await assert.rejects(conformApi(chain).resolve('4246.7'), isStatus('RPC_DISAGREE', 'unavailable'))
  // the default mode refuses the split too (no majority vote): not what strict adds / 默认模式同样拒绝分歧：不是 strict 多出的部分
  await assert.rejects(defaultApi(chain).resolve('4246.7'), (e) => e.code === 'RPC_DISAGREE')
  // every node reverting: the holder does not approve / 所有节点都回滚：持有人不认可
  for (const u of RPC) chain.setCallFault(u, 'isValidSignature', 'revert')
  await assert.rejects(conformApi(chain).resolve('4246.7'), isStatus('DELEGATION_INVALID', 'delegation-invalid'))
})

// ── contract holder (EIP-1271): contentSig (TAP-11 §5) / 合约持有人：内容签名 ─────────────────────────────────────────
test('a contract holder\'s contentSig is checked under strict agreement: one node not answering is CONTENT_SIG_UNCHECKED, or refused with requireContentSig', async () => {
  const { chain, digests } = world({ contract: true, contentSig: true })
  const warnings = []
  let svc = await conformApi(chain, { onWarning: (w) => warnings.push(w) }).resolve('4246.7')
  assert.deepEqual(svc.contentSig, { valid: true }); assert.deepEqual(warnings, [])
  // one node does not answer isValidSignature for the content digest only: the delegation still verifies
  // 一个节点只对内容摘要的 isValidSignature 不作答：委托照样成立
  chain.setCallFault('http://rpc3', 'isValidSignature', 'http500', { data: digests.content })
  svc = await conformApi(chain, { onWarning: (w) => warnings.push(w) }).resolve('4246.7')
  assert.deepEqual(svc.contentSig, { valid: false, checked: false })
  assert.equal(warnings.length, 1); assert.equal(warnings[0].code, 'CONTENT_SIG_UNCHECKED'); assert.equal(warnings[0].cause, 'RPC_UNAVAILABLE')
  await assert.rejects(conformApi(chain, { requireContentSig: true }).resolve('4246.7'), isStatus('RPC_UNAVAILABLE', 'unavailable', /only 2\/3/))
  // the default mode, default agreement: valid / 默认模式，默认共识：有效
  assert.deepEqual((await defaultApi(chain).resolve('4246.7')).contentSig, { valid: true })
  assert.deepEqual((await defaultApi(chain, { requireContentSig: true }).resolve('4246.7')).contentSig, { valid: true })
  // one node reverting it while the others approve: refused under requireContentSig / 一个节点回滚、其余认可：requireContentSig 下拒绝
  chain.setCallFault('http://rpc3', 'isValidSignature', 'revert', { data: digests.content })
  await assert.rejects(conformApi(chain, { requireContentSig: true }).resolve('4246.7'), isStatus('RPC_DISAGREE', 'unavailable'))
  chain.setCallFault('http://rpc3', 'isValidSignature', null)
  assert.deepEqual((await conformApi(chain, { requireContentSig: true }).resolve('4246.7')).contentSig, { valid: true })
})

test('an EOA holder\'s contentSig recovers by ECDSA and sends no EIP-1271 read in either mode', async () => {
  const { chain } = world({ contentSig: true })
  const from = chain.conform.log.length
  assert.deepEqual((await conformApi(chain, { requireContentSig: true }).resolve('4246.7')).contentSig, { valid: true })
  assert.ok(!since(chain, from).some((x) => x.method === 'eth_getCode' || x.fn === 'isValidSignature'))
})

// ── other chains / 其它链 ─────────────────────────────────────────────────────────────────────────────────────────
test('forChain passes it on: on Base and X Layer the holder and a contract holder\'s EIP-1271 answers are strict as well', async () => {
  const worlds = { 56: world(), 196: world({ chainId: 196, contract: true }), 8453: world({ chainId: 8453, contract: true }) }
  const fetch = (url, init) => worlds[Number(/^http:\/\/rpc(\d+)-/.exec(url)[1])].chain.fetch(url, init)
  const urls = (id) => ['a', 'b', 'c'].map((x) => `http://rpc${id}-${x}`)
  const chains = { 196: { rpcUrls: urls(196) }, 8453: { rpcUrls: urls(8453) } }
  const api = createTapeAPI({ conform: 'tap10', rpcUrls: urls(56), fetch, clock: () => T, quiet: true, onWarning: () => {}, chains })
  const plain = createTapeAPI({ rpcUrls: urls(56), fetch, clock: () => T, quiet: true, onWarning: () => {}, sentinel: 'off', chains })
  for (const [id, name] of [[8453, '4246.3.7'], [196, '4246.2.7']]) {
    const w = worlds[id]
    assert.equal((await api.resolve(name)).verified.holder.toLowerCase(), SAFE, `${id}`)
    for (const read of ['ownerOf', 'eth_getCode', 'isValidSignature']) {
      w.chain.setCallFault(`http://rpc${id}-c`, read, 'http500')
      await assert.rejects(api.resolve(name), isStatus('RPC_UNAVAILABLE', 'unavailable'), `${id} ${read}`)
      await assert.rejects(api.forChain(id).resolve(name), isStatus('RPC_UNAVAILABLE', 'unavailable'), `${id} ${read} forChain`)
      assert.equal((await plain.resolve(name)).verified.holder.toLowerCase(), SAFE, `${id} ${read} default mode`)
      w.chain.setCallFault(`http://rpc${id}-c`, read, null)
    }
    assert.equal((await api.forChain(id).resolve(name)).chainId, id)
  }
  assert.equal(worlds[56].chain.conform.log.length, 0, 'nothing was read on BNB Smart Chain')
})
