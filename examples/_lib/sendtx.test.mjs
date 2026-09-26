// The piece that turns a built transaction into a settled one: RLP, EIP-1559 signing, the send loop and the
// settler. RLP is checked against the examples in the Ethereum yellow paper / devp2p RLP spec; the signed
// transaction is decoded back independently here and its signer recovered.
// 把"构造好的交易"变成"已结算"的那一段：RLP、EIP-1559 签名、发送与结算循环。RLP 用以太坊 RLP 规范里的
// 例子校验；签好的交易在这里独立解码回来，并恢复出签名者。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rlp, signTx, createSender, createSettler } from './sendtx.mjs'
import { abi, sig } from '@tapeapi/sdk'

const { toHex, hexToBytes, keccak256 } = abi
const KEY = '0x' + '77'.repeat(32)
const ADDR_TO = '0x' + '11'.repeat(20)

test('RLP matches the specification examples', () => {
  assert.equal(toHex(rlp(new TextEncoder().encode('dog'))), '0x83646f67')
  assert.equal(toHex(rlp([])), '0xc0')
  assert.equal(toHex(rlp(['cat', 'dog'].map((s) => new TextEncoder().encode(s)))), '0xc88363617483646f67')
  assert.equal(toHex(rlp(new Uint8Array(0))), '0x80')
  assert.equal(toHex(rlp(Uint8Array.of(0x0f))), '0x0f')
  assert.equal(toHex(rlp(1024n)), '0x820400')
  const long = new TextEncoder().encode('Lorem ipsum dolor sit amet, consectetur adipisicing elit')   // 56 bytes
  assert.equal(toHex(rlp(long)).slice(0, 6), '0xb838')
})

// A small independent RLP decoder, so the test does not trust the encoder it is checking.
// 一个独立的小 RLP 解码器，使测试不依赖被检查的编码器。
function rlpDecode(b, at = 0) {
  const p = b[at]
  if (p < 0x80) return [b.subarray(at, at + 1), at + 1]
  if (p < 0xb8) { const n = p - 0x80; return [b.subarray(at + 1, at + 1 + n), at + 1 + n] }
  if (p < 0xc0) { const l = p - 0xb7; const n = Number(BigInt(toHex(b.subarray(at + 1, at + 1 + l)))); return [b.subarray(at + 1 + l, at + 1 + l + n), at + 1 + l + n] }
  const [len, start] = p < 0xf8 ? [p - 0xc0, at + 1] : (() => { const l = p - 0xf7; return [Number(BigInt(toHex(b.subarray(at + 1, at + 1 + l)))), at + 1 + l] })()
  const out = []
  let i = start
  while (i < start + len) { const [item, next] = rlpDecode(b, i); out.push(item); i = next }
  return [out, start + len]
}

test('a signed EIP-1559 transaction carries the fields it was given and recovers to the signing key', () => {
  const tx = { chainId: 56, nonce: 7n, maxPriorityFeePerGas: 1_000_000_000n, maxFeePerGas: 3_000_000_000n, gas: 120_000n, to: ADDR_TO, value: 0n, data: '0xdeadbeef' }
  const raw = hexToBytes(signTx(tx, KEY))
  assert.equal(raw[0], 0x02, 'type 2')
  const [fields] = rlpDecode(raw, 1)
  assert.equal(fields.length, 12, 'nine payload fields plus y, r, s')
  const num = (f) => (f.length ? BigInt(toHex(f)) : 0n)
  assert.equal(num(fields[0]), 56n)
  assert.equal(num(fields[1]), 7n)
  assert.equal(num(fields[2]), 1_000_000_000n)
  assert.equal(num(fields[3]), 3_000_000_000n)
  assert.equal(num(fields[4]), 120_000n)
  assert.equal(toHex(fields[5]), ADDR_TO)
  assert.equal(num(fields[6]), 0n)
  assert.equal(toHex(fields[7]), '0xdeadbeef')
  assert.deepEqual(fields[8], [], 'no access list')
  // the signature covers 0x02 ‖ rlp(the nine fields) / 签名覆盖 0x02 ‖ rlp(前九个字段)
  const unsigned = new Uint8Array([0x02, ...hexToBytes(toHex(rlp(fields.slice(0, 9))))])
  const signature = toHex(new Uint8Array([...fields[10], ...fields[11], 27 + Number(num(fields[9]))]))
  assert.equal(sig.recoverAddress(keccak256(unsigned), signature).toLowerCase(), sig.privateKeyToAddress(KEY).toLowerCase())
})

// A node that accepts one transaction, then reports a receipt for it. / 一个接受交易并给出回执的节点。
function fakeNode({ status = '0x1', chainId = 56 } = {}) {
  const sent = []
  let asked = 0
  const fetch = async (_url, init) => {
    const { id, method, params } = JSON.parse(init.body)
    const reply = (result) => new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { headers: { 'content-type': 'application/json' } })
    switch (method) {
      case 'eth_getTransactionCount': return reply('0x3')
      case 'eth_gasPrice': return reply('0x2540be400')          // 10 gwei
      case 'eth_maxPriorityFeePerGas': return reply('0x3b9aca00')
      case 'eth_estimateGas': return reply('0x1d4c0')
      case 'eth_sendRawTransaction': { sent.push(params[0]); return reply('0x' + 'ab'.repeat(32)) }
      case 'eth_getTransactionReceipt': return reply(asked++ === 0 ? null : { status, blockNumber: '0x64', gasUsed: '0x1abc' })
      default: return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: method } }), { headers: { 'content-type': 'application/json' } })
    }
  }
  return { fetch, sent, chainId }
}

test('the sender fills in nonce, fees and gas, waits for the receipt and reports a revert', async () => {
  const node = fakeNode()
  const sender = createSender({ rpcUrl: 'http://node', privateKey: KEY, fetch: node.fetch, confirmMs: 5000 })
  const r = await sender.send({ to: ADDR_TO, data: '0x1234' })
  assert.equal(r.blockNumber, 100)
  assert.equal(node.sent.length, 1)
  const [fields] = rlpDecode(hexToBytes(node.sent[0]), 1)
  assert.equal(BigInt(toHex(fields[1])), 3n, 'the nonce the node reported')
  assert.ok(BigInt(toHex(fields[3])) > BigInt(toHex(fields[2])), 'max fee above the tip')
  const reverted = createSender({ rpcUrl: 'http://node', privateKey: KEY, fetch: fakeNode({ status: '0x0' }).fetch, confirmMs: 5000 })
  await assert.rejects(reverted.send({ to: ADDR_TO, data: '0x1234' }), /reverted/)
})

test('the settler sends what dueSettlements returns, survives a failure and reports it', async () => {
  const due = [
    { consumer: '0x' + 'c1'.repeat(20), cumulative: '10', reason: 'deadline' },
    { consumer: '0x' + 'c2'.repeat(20), cumulative: '20', reason: 'withdraw-requested' },
  ]
  const sentFor = []
  const provider = {
    dueSettlements: async () => due,
    settleTx: (v) => ({ to: '0x' + 'e5'.repeat(20), data: '0x' + v.cumulative.padStart(4, '0'), value: '0x0' }),
  }
  const sender = { send: async (tx) => { if (tx.data.endsWith('20')) throw new Error('node down'); sentFor.push(tx.data); return { blockNumber: 1, hash: '0x', gasUsed: 1 } } }
  const lines = []
  const settler = createSettler({ provider, sender, log: (l) => lines.push(l) })
  const stats = await settler.runOnce()
  assert.deepEqual(sentFor, ['0x0010'])
  assert.equal(stats.settled, 1)
  assert.equal(stats.failed, 1, 'the failure is counted, the loop goes on')
  assert.ok(lines.some((l) => /settle failed/.test(l)))
  settler.stop()
})
