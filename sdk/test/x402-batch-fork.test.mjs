// @experimental prototype, OPTIONAL: enforcement 'x402-batch' against the REAL deployed contracts, on a local anvil fork
// of BNB Smart Chain. Skipped unless BSC_FORK_RPC names that local fork (127.0.0.1 / localhost only: this test never
// talks to any other host). The drill's setup (internal notes X402-FORK-DRILL §1, §2, §9):
//   anvil --fork-url <a public BSC node> --fork-block-number 129111153 --port 8546 --host 127.0.0.1
//   BSC_FORK_RPC=http://127.0.0.1:8546 node --test sdk/test/x402-batch-fork.test.mjs
// On the fork only: anvil's public test accounts (their EIP-7702 code cleared with anvil_setCode, as the drill did), a
// real BEM holder impersonated to fund the payer (no key), and time moved with evm_increaseTime. Not an audit.
// 可选：在本机 anvil 分叉上对真实部署的合约跑一圈；不设 BSC_FORK_RPC（且只能是本机地址）即跳过。只在分叉上动作，不是审计。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as X from '../src/agent-public.js'
import { encodeParams, decodeParams, selector, bytesToHex, toHex, eqAddr } from '../src/abi.js'
import { signDigest, privateKeyToAddress } from '../src/sig.js'

const RPC = process.env.BSC_FORK_RPC
const local = (() => { try { return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(RPC).hostname) } catch { return false } })()
const skip = !RPC ? 'BSC_FORK_RPC is not set (an anvil fork of BSC at block 129111153)' : !local ? 'BSC_FORK_RPC must be a local anvil (127.0.0.1 / localhost)' : false
const BEM = '0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a'
const BEM_SOURCE = '0x86a41524cb61edd8b115a72ad9735f8068996688'   // a real BEM holder, impersonated on the fork only
const CONTAINER = '0x86DDaEF00401E3F10418398D67D7189fc458eA95'    // circuit 4246's TapeOut container
const PK = ['0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a', '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a', '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba']
const [, PAYER, SESSION, RECEIVER, RECEIVER_AUTH, RELAYER] = PK.map(privateKeyToAddress)
let id = 1
async function rpc(method, params = []) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: id++, method, params }) })
  const j = await r.json()
  if (j.error) { const e = new Error(`${method}: ${j.error.message}`); e.data = j.error.data; throw e }
  return j.result
}
const call = (to, data) => rpc('eth_call', [{ to, data }, 'latest'])
async function send(from, tx) {
  const h = await rpc('eth_sendTransaction', [{ from, to: tx.to, data: tx.data, value: tx.value ?? '0x0' }])
  let rc = null
  for (let i = 0; i < 100 && !rc; i++) { rc = await rpc('eth_getTransactionReceipt', [h]); if (!rc) await new Promise((ok) => setTimeout(ok, 50)) }
  assert.equal(rc.status, '0x1', `${tx.data.slice(0, 10)} from ${from} reverted`)
  return rc
}
const bal = async (who) => decodeParams(['uint256'], await call(BEM, selector('balanceOf(address)') + bytesToHex(encodeParams(['address'], [who]))))[0]
const CFG_T = { type: 'tuple', components: ['address', 'address', 'address', 'address', 'address', 'uint40', 'bytes32'] }
const cfgArr = (c) => [c.payer, c.payerAuthorizer, c.receiver, c.receiverAuthorizer, c.token, c.withdrawDelay, c.salt]

test('x402-batch fork: the SDK\'s digests equal the deployed contract\'s views; deposit, vouchers, claim, settle and a timed withdrawal on the real contracts', { skip }, async () => {
  assert.equal(Number(await rpc('eth_chainId')), 56)
  for (const a of [PAYER, SESSION, RECEIVER, RECEIVER_AUTH, RELAYER]) await rpc('anvil_setCode', [a, '0x'])   // the drill's 7702 clearing
  await rpc('anvil_impersonateAccount', [BEM_SOURCE]); await rpc('anvil_setBalance', [BEM_SOURCE, '0xde0b6b3a7640000'])
  await send(BEM_SOURCE, { to: BEM, data: selector('transfer(address,uint256)') + bytesToHex(encodeParams(['address', 'uint256'], [PAYER, 10n ** 9n])) })
  // a TapeOut container is refused before any transaction / 容器在任何交易之前被拒绝
  const code = await rpc('eth_getCode', [CONTAINER, 'latest'])
  assert.throws(() => X.x402CheckPayer(CONTAINER, code), (e) => e.data.reason === 'x402-payer-not-eoa', 'the real container has code')
  X.x402CheckPayer(PAYER, await rpc('eth_getCode', [PAYER, 'latest']))
  const svc = { container: RECEIVER, manifest: { payment: { escrow: X.X402_SETTLEMENT } } }
  const terms = { [RECEIVER]: { receiver: RECEIVER, receiverAuthorizer: RECEIVER_AUTH, token: BEM, withdrawDelay: 900 } }
  const t0 = Number((await rpc('eth_getBlockByNumber', ['latest', false])).timestamp)   // the fork's time / 分叉的时间
  const payer = X.x402Payer({ chainId: 56, consumer: PAYER, sessionKey: PK[2], terms, sessionExpiry: t0 + 3600, clock: () => t0 })
  const { config, channelId } = payer.channelOf(svc)
  assert.equal(await call(X.X402_SETTLEMENT, selector('getChannelId((address,address,address,address,address,uint40,bytes32))') + bytesToHex(encodeParams([CFG_T], [cfgArr(config)]))), channelId)
  assert.equal(await call(X.X402_SETTLEMENT, selector('getVoucherDigest(bytes32,uint128)') + bytesToHex(encodeParams(['bytes32', 'uint128'], [channelId, 12345n]))), toHex(X.x402VoucherDigest(56, X.X402_SETTLEMENT, channelId, 12345n)))
  assert.equal(await call(X.PERMIT2, selector('DOMAIN_SEPARATOR()')), toHex(X.permit2DomainSeparator(56)))
  // the payer's own approve, then a deposit it signs, sent by a relayer / 付款方自己 approve；它签的存款由第三方代交
  await send(PAYER, X.x402Tx.approvePermit2(BEM))
  const now = Number((await rpc('eth_getBlockByNumber', ['latest', false])).timestamp)
  const amount = 10n ** 8n
  await send(RELAYER, X.x402Tx.deposit(X.X402_SETTLEMENT, config, { amount, nonce: 0, deadline: now + 3600, signature: signDigest(X.x402DepositDigest(56, { token: BEM, amount, nonce: 0, deadline: now + 3600, channelId }), PK[1]) }))
  const read = (to, data) => call(to, data)
  assert.equal((await X.x402ChannelState(read, X.X402_SETTLEMENT, channelId)).balance, amount)
  const acc = X.x402Acceptance({ chainId: 56, container: RECEIVER, receiverAuthorizer: RECEIVER_AUTH, token: BEM, withdrawDelay: 900, read })
  for (let i = 0; i < 3; i++) { const l = await payer.reserve(svc, 1_000_000n); const ok = await acc.verifyVoucher(l.voucher, 1_000_000n); await ok.commit(); await l.commit() }
  const rows = await acc.claimRows()
  const rc = await send(RECEIVER, acc.claimTx(rows))
  assert.ok(rc.logs.length > 0, 'a Claimed log')
  const again = await send(RECEIVER, acc.claimTx(rows))
  assert.equal(again.logs.length, 0, 'the same claim again: a silent no-op on the real contract')
  const r0 = await bal(RECEIVER)
  await send(RELAYER, acc.settleTx())
  assert.equal(await bal(RECEIVER) - r0, 3_000_000n)
  // a timed withdrawal started by the session key, finished after the service's 900 s, to the payer only
  await send(SESSION, X.x402Tx.initiateWithdraw(X.X402_SETTLEMENT, config, amount - 3_000_000n))
  await rpc('evm_increaseTime', [900]); await rpc('anvil_mine', ['0x1'])
  const p0 = await bal(PAYER)
  await send(SESSION, X.x402Tx.finalizeWithdraw(X.X402_SETTLEMENT, config))
  assert.equal(await bal(PAYER) - p0, amount - 3_000_000n)
  assert.ok(eqAddr(config.payerAuthorizer, SESSION))
})
