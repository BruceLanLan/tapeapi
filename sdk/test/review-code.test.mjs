// Code review of 2c9b825^..HEAD plus the older code it touches (rpc, bus/relay transports, relay core, provider
// runtime, tx builders, example settler/store). The findings have since been fixed: every `FIXED <id>` test replays
// the original scenario and asserts the CORRECT behaviour (the attack is refused, the right result happens).
// 对 2c9b825^..HEAD 及其涉及的旧代码（rpc、总线/中继传输、中继核心、提供者运行时、交易构造、示例结算器/存储）的代码审查。
// 发现项均已修复：每个 `FIXED <id>` 测试重放原场景，断言正确行为（攻击被拒、结果正确）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTapeAPI, channel, TapeAPIError, sig, abi, parseUnits } from '../src/index.js'
import { createRpc, isNodeLimit } from '../src/rpc.js'
import { createFakeChain, ADDR, eachCall } from './helpers/fake-chain.mjs'
import { createProvider } from '../../server/src/index.js'
import { createRelayCore, relayMethods } from '../../examples/relay-service/relay-core.mjs'
import { signTx } from '../../examples/_lib/sendtx.mjs'
import { fileStore } from '../../examples/_lib/store.mjs'
import { startProvider } from '../../examples/_lib/service.mjs'

const { busTransport } = channel
const { encodeParams, decodeParams, hexToBytes, bytesToHex, encodeCall, toHex } = abi
const nowS = () => Math.floor(Date.now() / 1000)
const b64 = (u8) => Buffer.from(u8).toString('base64')
const ROOM_IN = 'aa'.repeat(32), ROOM_OUT = 'bb'.repeat(32)
const BUS = '0x' + 'cb'.repeat(20)

// ------------------------------------------------------------------------------------------------ H-1 ----
test('FIXED H-1: tx.approve({ spender: svc }) requires an explicit, bounded amount: no unlimited allowance to a provider-named escrow', () => {
  const api = createTapeAPI({ escrow: ADDR.escrow })
  const EVIL = '0x' + 'e5'.repeat(20)   // any contract a hostile provider writes into payment.escrow / 恶意服务方写进清单的任意合约
  const svc = { manifest: { payment: { escrow: EVIL } }, container: ADDR.container }
  const abiErr = (re) => (e) => e instanceof TapeAPIError && e.code === 'INVALID_ARGUMENT' && re.test(e.message)
  assert.throws(() => api.tx.approve({ spender: svc }), abiErr(/needs an amount/), 'amount omitted, as a hurried integrator would: refused')
  assert.throws(() => api.tx.approve({ spender: svc, amount: 0n }), abiErr(/positive and bounded/))
  assert.throws(() => api.tx.approve({ spender: svc, amount: 2n ** 256n - 1n }), abiErr(/positive and bounded/), 'the old "unlimited" value is refused')
  assert.throws(() => api.tx.approve({ spender: svc, amount: 2n ** 255n }), abiErr(/positive and bounded/))
  const t = api.tx.approve({ spender: svc, amount: 1_000n })
  assert.equal(t.to.toLowerCase(), '0x5ce033b2bfca3af30b3e8c8457deaf776a8b695a', 'BEM token')
  const [spender, amount] = decodeParams(['address', 'uint256'], hexToBytes('0x' + t.data.slice(10)))
  assert.equal(spender.toLowerCase(), EVIL)
  assert.equal(amount, 1_000n, 'exactly what the caller will fund, nothing more')
})

// ------------------------------------------------------------------------------------------------ M-1 ----
test('FIXED M-1: busTransport reads each node on its own and splits a range the honest node refuses as too wide: the frame arrives', async () => {
  const FRAME_BLOCK = 1500
  const wire = Uint8Array.of(0x02, 9, 9, 9)
  const data = '0x' + bytesToHex(encodeParams(['bytes'], [wire]))
  const ranges = []
  const honest = {   // has the frame, but caps eth_getLogs at 50 blocks (1rpc.io style) / 有这帧，但每次最多 50 个区块
    call: async (_m, [f]) => {
      const lo = Number(f.fromBlock), hi = Number(f.toBlock)
      ranges.push(hi - lo + 1)
      // the shape rpc.js gives a node-limit answer: what the node said is in `refusals` (review R4-3: the scanner reads only that)
      // rpc.js 给节点限制类回答的形状：节点原话在 `refusals` 里（扫描器只看它）
      if (hi - lo + 1 > 50) throw new TapeAPIError('RPC_UNAVAILABLE', 'eth_getLogs: only 0/1 nodes answered (node cannot answer (-32005): block range limit 50 exceeded)', { refusals: [{ code: -32005, message: 'block range limit 50 exceeded' }] })
      return FRAME_BLOCK >= lo && FRAME_BLOCK <= hi ? [{ blockNumber: FRAME_BLOCK, logIndex: 0, data, removed: false }] : []
    },
  }
  const omitting = { call: async () => [] }   // a lagging load-balanced backend, or a node that simply omits / 落后或故意漏报的节点
  const rpc = { urls: ['http://honest', 'http://other'], blockNumber: async () => 2000, call: async () => { throw new Error('unused') }, single: (u) => (u === 'http://honest' ? honest : omitting) }
  // confirmations: 0 keeps this test's head at 2000, as when it was written (the default is 2 since arch B13)
  // confirmations: 0 让链头仍是 2000，与本测试编写时一致（arch B13 起默认为 2）
  const t = busTransport({ rpc, bus: BUS, inbound: ROOM_IN, outbound: ROOM_OUT, fromBlock: 1000, confirmations: 0 })
  const got = await t.poll()
  assert.equal(got.length, 1, 'the union includes the honest node\'s answer, read in pieces it accepts')
  assert.deepEqual(got[0], wire)
  assert.equal(t.cursor, 2001)
  assert.ok(ranges.some((n) => n <= 50), 'the honest node was asked narrower ranges')
  assert.deepEqual(await t.poll(), [], 'nothing new, nothing lost')
  // When no node answers at all, the poll fails and the cursor stays put / 所有节点都不回答时轮询失败，游标不动
  const down = { call: async () => { throw new Error('connection refused') } }
  const t2 = busTransport({ rpc: { ...rpc, single: () => down }, bus: BUS, inbound: ROOM_IN, outbound: ROOM_OUT, fromBlock: 1000 })
  await assert.rejects(t2.poll(), (e) => e.code === 'RPC_UNAVAILABLE')
  assert.equal(t2.cursor, 1000)
})

// ------------------------------------------------------------------------------------------------ M-2 ----
test('FIXED M-2: EIP-1271 requires the whole first word 0x1626ba7e‖0…0: a holder contract whose fallback echoes calldata approves nothing', async () => {
  const ECHO = '0x' + 'ec'.repeat(20)          // holder of the circuit: a contract whose fallback returns msg.data / 回显调用数据的持有人合约
  const CIRCUITS = '0x' + '50'.repeat(20)
  const CONTAINER = '0x' + '60'.repeat(20)
  const attackerSigner = sig.privateKeyToAddress('0x' + '42'.repeat(32))
  const expires = nowS() + 86400
  // A delegation signed by a random key that has nothing to do with the holder / 由与持有人无关的随机密钥签的委托
  const delegationSig = sig.signDigest(sig.delegationDigest(56, '0x' + '10'.repeat(20), { container: CONTAINER, signer: attackerSigner, expires }), '0x' + '99'.repeat(32))
  const ownerOfSel = encodeCall('ownerOf', [1n]).slice(0, 10)
  let echoed = null
  const fetch = async (_url, init) => {
    const req = JSON.parse(init.body)
    const reply = (result) => new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }))
    if (req.method === 'eth_getCode') return reply(String(req.params[0]).toLowerCase() === ECHO ? '0x6000' : '0x')
    if (req.method === 'eth_call') {
      const { to, data } = req.params[0]
      if (to.toLowerCase() === CIRCUITS && data.startsWith(ownerOfSel)) return reply('0x' + bytesToHex(encodeParams(['address'], [ECHO])))
      if (to.toLowerCase() === ECHO) { echoed = data; return reply(data) }   // echo fallback: returns the calldata, which starts 0x1626ba7e
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'nope' } }))
  }
  const api = createTapeAPI({ dev: true, rpcUrls: ['http://rpc1', 'http://rpc2'], quorum: 2, fetch, hub: '0x' + '10'.repeat(20) })
  const manifest = {
    tapeapi: '0.1', circuits: CIRCUITS, tokenId: '1', container: CONTAINER, signer: attackerSigner,
    delegation: { expires, sig: delegationSig },
    endpoints: { live: ['http://127.0.0.1:9/tapeapi/v1'], async: false },
    methods: [{ name: 'x', priceBEM: '0', params: {}, returns: {} }],
  }
  await assert.rejects(api.resolve({ dev: manifest }), (e) => e.code === 'DELEGATION_INVALID', 'forged delegation refused')
  assert.equal(echoed.slice(0, 10), '0x1626ba7e', 'the echo contract was asked, and its answer starts with the selector')
  assert.notEqual(echoed.slice(0, 66), '0x1626ba7e' + '0'.repeat(56), 'but the word is selector ‖ digest, not the padded magic value')
})

// ------------------------------------------------------------------------------------------------ M-3 ----
test('FIXED M-3: provider tracks EVERY in-flight reservation per consumer: a failed later call does not free an earlier one, so no cumulative is served twice', async () => {
  const chain = createFakeChain()
  const CONSUMER_KEY = '0x' + '33'.repeat(32), SIGNER_KEY = '0x' + '22'.repeat(32)
  const consumer = sig.privateKeyToAddress(CONSUMER_KEY), signer = sig.privateKeyToAddress(SIGNER_KEY)
  chain.setChannel(consumer, ADDR.container, 1_000_000n)
  let open; const gate = new Promise((r) => { open = r })
  let entered; const inSlow = new Promise((r) => { entered = r })
  const manifest = {
    tapeapi: '0.1', name: 'T', circuits: ADDR.circuits, tokenId: '1', container: ADDR.container, signer, delegation: null, dev: true,
    endpoints: { live: ['http://127.0.0.1/tapeapi/v1'], async: false },
    methods: [{ name: 'work', priceBEM: '0.00000001', params: {}, returns: {} }],
    payment: { escrow: ADDR.escrow, unit: 'BEM', decimals: 8 },
  }
  const provider = createProvider({
    manifest, signerKey: SIGNER_KEY, rpcUrls: ['http://rpc1', 'http://rpc2'], quorum: 2, fetch: chain.fetch, escrowCacheMs: 0, minVoucherLifeS: 0, rateLimit: false, allowHttp: true,
    methods: {
      work: async ({ mode }) => {
        if (mode === 'fail') throw Object.assign(new TapeAPIError('BAD_REQUEST', 'handler refused'))
        if (mode === 'slow') { entered(); await gate }
        return { served: mode }
      },
    },
  })
  const voucher = (c) => { const v = { consumer, provider: ADDR.container, cumulative: String(c), expires: nowS() + 3600 }; return { ...v, sig: sig.signDigest(sig.voucherDigest(56, ADDR.escrow, v), CONSUMER_KEY) } }
  const call = (id, mode, c) => provider.invoke({ id, method: 'work', params: { mode }, voucher: voucher(c) })
  const pA = call('a', 'slow', 1)        // reserves cumulative 1, still running / 预留累计额 1，仍在运行
  await inSlow
  const b = await call('b', 'fail', 2)   // reserves 2, fails, and releases ONLY its own reservation / 预留 2、失败，只释放自己的预留
  assert.equal(b.env.ok, false)
  const c = await call('c', 'fast', 1)   // cumulative 1 AGAIN: A still holds it / 再次使用累计额 1：A 仍占着
  assert.equal(c.env.ok, false, 'no second delivery on cumulative 1')
  assert.equal(c.env.error.code, 'BAD_VOUCHER')
  assert.equal(c.env.error.data.lastCumulative, '1', 'the in-flight reservation is what the consumer must exceed')
  const c2 = await call('c2', 'fast', 2)
  assert.equal(c2.env.ok, true, 'the next unit is served')
  open()
  const a = await pA
  assert.equal(a.env.ok, true, 'first delivery on cumulative 1')
  const rec = await provider.store.get(consumer, ADDR.container)
  assert.equal(rec.cumulative, '2', 'two paid results delivered, two units billed')
})

// ------------------------------------------------------------------------------------------------ M-4 ----
test('FIXED M-4: on a PRICED relay, free relayHandshake carries only small accept/ready messages and its rooms have their own cap and TTL', async () => {
  let t = 1_000_000
  const core = createRelayCore({ maxRooms: 10, maxHandshakeRooms: 3, now: () => t })
  const m = relayMethods(core)
  const hs = (kind) => b64(new Uint8Array([0x01, ...new TextEncoder().encode(JSON.stringify({ t: kind, x: 'y' }))]))
  const isBad = (e) => e.code === 'BAD_REQUEST'
  // The original junk: 16 KB of 0x01-prefixed bytes that are not a handshake / 原攻击：16 KB、以 0x01 开头但不是握手的字节
  const junk = new Uint8Array(16_000).fill(0x41); junk[0] = 0x01
  await assert.rejects(m.relayHandshake({ room: '0'.repeat(64), frame: b64(junk) }), isBad)
  const smallJunk = new Uint8Array(60).fill(0x41); smallJunk[0] = 0x01
  await assert.rejects(m.relayHandshake({ room: '0'.repeat(64), frame: b64(smallJunk) }), isBad, 'small but not an accept/ready JSON object')
  await assert.rejects(m.relayHandshake({ room: '0'.repeat(64), frame: b64(new Uint8Array([0x01, ...new TextEncoder().encode('{"t":"frame"}')])) }), isBad)
  assert.equal(core.size, 0, 'no room was created by junk')
  // Real handshakes fill only the handshake-room budget; paying senders still get rooms / 真握手只占握手房间额度，付费发送仍有房间
  for (let i = 0; i < 3; i++) await m.relayHandshake({ room: String(i).repeat(64), frame: hs('accept') })
  await assert.rejects(m.relayHandshake({ room: '9'.repeat(64), frame: hs('ready') }), (e) => e.code === 'UNAVAILABLE' && /handshake-only/.test(e.message))
  await m.relaySend({ room: 'f'.repeat(64), frame: b64(Uint8Array.of(0x02, 1, 2)) })
  assert.equal(core.size, 4, 'the paid send is not refused as "relay is full"')
  // A paid post adopts a handshake room, freeing a handshake slot / 付费消息接管握手房间，腾出一个握手名额
  await m.relaySend({ room: '0'.repeat(64), frame: b64(Uint8Array.of(0x02, 3, 4)) })
  await m.relayHandshake({ room: '9'.repeat(64), frame: hs('ready') })
  // Handshake-only rooms expire after 10 min; paid rooms after the normal 15 / 握手房间 10 分钟过期，付费房间按正常 15 分钟
  t += 10 * 60 * 1000 + 1
  core.sweep()
  assert.equal(core.size, 2, 'only the two paid rooms remain')
  await m.relayHandshake({ room: 'e'.repeat(64), frame: hs('accept') })
})

// ------------------------------------------------------------------------------------------------ M-5 ----
function rlpDecode(b, at = 0) {
  const p = b[at]
  if (p < 0x80) return [b.subarray(at, at + 1), at + 1]
  if (p < 0xb8) { const n = p - 0x80; return [b.subarray(at + 1, at + 1 + n), at + 1 + n] }
  if (p < 0xc0) { const l = p - 0xb7; const n = Number(BigInt(toHex(b.subarray(at + 1, at + 1 + l)))); return [b.subarray(at + 1 + l, at + 1 + l + n), at + 1 + l + n] }
  const [len, start] = p < 0xf8 ? [p - 0xc0, at + 1] : (() => { const l = p - 0xf7; return [Number(BigInt(toHex(b.subarray(at + 1, at + 1 + l)))), at + 1 + l] })()
  const out = []; let i = start
  while (i < start + len) { const [item, next] = rlpDecode(b, i); out.push(item); i = next }
  return [out, start + len]
}
function rlpEncode(item) {
  const len = (n, off) => (n < 56 ? [off + n] : (() => { const h = n.toString(16); const b = hexToBytes('0x' + (h.length % 2 ? '0' + h : h)); return [off + 55 + b.length, ...b] })())
  if (Array.isArray(item)) { const body = item.flatMap((x) => [...rlpEncode(x)]); return Uint8Array.from([...len(body.length, 0xc0), ...body]) }
  if (item.length === 1 && item[0] < 0x80) return Uint8Array.from(item)
  return Uint8Array.from([...len(item.length, 0x80), ...item])
}
test('FIXED M-5: signTx RLP-encodes r and s as canonical integers (no leading zero bytes), and the short ones still recover the sender', () => {
  const KEY = '0x' + '77'.repeat(32)
  let short = null
  for (let nonce = 0n; nonce < 5000n; nonce++) {
    const raw = hexToBytes(signTx({ chainId: 56, nonce, maxPriorityFeePerGas: 1n, maxFeePerGas: 2n, gas: 100_000n, to: '0x' + '11'.repeat(20), data: '0x' }, KEY))
    const [f] = rlpDecode(raw, 1)
    for (const x of [f[10], f[11]]) assert.ok(x.length === 0 || x[0] !== 0, `nonce ${nonce}: leading zero byte in r or s`)
    if (!short && (f[10].length < 32 || f[11].length < 32)) short = f
  }
  assert.ok(short, 'a shorter r or s occurs within a few hundred nonces (the case that used to be non-canonical)')
  // The stripped values still verify: re-pad them and recover the signer / 去零后的值仍然有效：补齐后恢复出签名者
  const pad = (x) => bytesToHex(x).replace(/^0x/, '').padStart(64, '0')
  const unsigned = Uint8Array.from([0x02, ...rlpEncode(short.slice(0, 9))])
  const yParity = short[9].length ? short[9][0] : 0
  const recovered = sig.recoverAddress(abi.keccak256(unsigned), '0x' + pad(short[10]) + pad(short[11]) + (27 + yParity).toString(16))
  assert.equal(recovered.toLowerCase(), sig.privateKeyToAddress(KEY).toLowerCase())
})

// ------------------------------------------------------------------------------------------------ L-1 ----
test('FIXED L-1: SIGTERM closes the server first and flushes the meter after, so vouchers committed during close() reach the disk', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'review-meter-'))
  const path = join(dir, 'meter.json')
  const store = fileStore(path)
  const record = { consumer: '0x' + '01'.repeat(20), provider: '0x' + '02'.repeat(20), cumulative: '777', expires: nowS() + 3600, sig: '0x' }
  let exitedWith = null, fileAtExit = null
  const fakeServer = { address: () => ({ port: 1 }) }
  const provider = {
    manifest: { name: 't', dev: true, methods: [], endpoints: { live: [] } }, signer: '0x', container: '0x', store,
    listen: async () => fakeServer,
    close: async () => { await store.advance(record.consumer, record.provider, record) },   // an in-flight paid call finishes during drain / 在途付费调用在排空时完成
  }
  const before = { SIGINT: process.listeners('SIGINT'), SIGTERM: process.listeners('SIGTERM') }
  const realExit = process.exit, realLog = console.log
  console.log = () => {}
  let done; const exited = new Promise((r) => { done = r })
  process.exit = (code) => { exitedWith = code; fileAtExit = existsSync(path) ? readFileSync(path, 'utf8') : null; done() }
  try {
    await startProvider(provider, { tag: 't', PORT: 0, HOST: '127.0.0.1', env: {} })
    process.emit('SIGTERM')
    await exited
  } finally {
    process.exit = realExit; console.log = realLog
    for (const s of ['SIGINT', 'SIGTERM']) for (const l of process.listeners(s)) if (!before[s].includes(l)) process.removeListener(s, l)
  }
  assert.equal(exitedWith, 0)
  assert.ok(fileAtExit && fileAtExit.includes('"777"'), 'the voucher committed during close() is on disk when the process exits')
  rmSync(dir, { recursive: true, force: true })
})

// ------------------------------------------------------------------------------------------------ L-2 ----
test('FIXED L-2: a failed fileStore flush is logged and retried, never thrown, and later meter updates are still written', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'review-store-'))
  const path = join(dir, 'sub', 'meter.json')
  const store = fileStore(path)      // creates dir/sub / 创建 dir/sub
  rmSync(join(dir, 'sub'), { recursive: true, force: true })   // transient failure: the directory is gone (or ENOSPC) / 暂时故障
  const realErr = console.error, logged = []
  console.error = (...a) => { logged.push(a.join(' ')) }
  try {
    await store.set('0x' + '01'.repeat(20), '0x' + '02'.repeat(20), { consumer: '0x' + '01'.repeat(20), provider: '0x' + '02'.repeat(20), cumulative: '1' })
    assert.equal(store.flush(), false, 'reported, not thrown (inside the 50 ms timer a throw would be an uncaughtException)')
    assert.ok(logged.some((l) => /cannot write/.test(l)))
    mkdirSync(join(dir, 'sub'))         // the disk recovers / 磁盘恢复
    await store.advance('0x' + '03'.repeat(20), '0x' + '02'.repeat(20), { consumer: '0x' + '03'.repeat(20), provider: '0x' + '02'.repeat(20), cumulative: '5' })
    await new Promise((r) => setTimeout(r, 1300))   // the retry runs after 1 s / 1 秒后重试
  } finally { console.error = realErr }
  assert.equal(existsSync(path), true, 'the retry wrote the meter')
  const rows = JSON.parse(readFileSync(path, 'utf8'))
  assert.deepEqual(rows.map((r) => r.cumulative).sort(), ['1', '5'], 'both updates, including the one made after the failure')
  rmSync(dir, { recursive: true, force: true })
})

// ------------------------------------------------------------------------------------------------ L-3 ----
test('FIXED L-3: busTransport validates chunk/minChunk: minChunk 0 (and other nonsense) is refused up front instead of looping for ever', async () => {
  let calls = 0
  const node = { call: async () => { calls++; return [] } }
  const rpc = { urls: ['http://n'], blockNumber: async () => 2000, call: node.call, single: () => node }
  const base = { rpc, bus: BUS, inbound: ROOM_IN, outbound: ROOM_OUT, fromBlock: 1000, confirmations: 0 }   // head 2000 as written (default 2 since arch B13)
  const invalid = (e) => e instanceof TapeAPIError && e.code === 'CHANNEL_INVALID' && /chunk and minChunk/.test(e.message)
  for (const bad of [{ chunk: 0, minChunk: 0 }, { chunk: 100, minChunk: 0 }, { chunk: 10, minChunk: 20 }, { chunk: 100, minChunk: 1.5 }, { chunk: '100', minChunk: 10 }]) {
    assert.throws(() => busTransport({ ...base, ...bad }), invalid, JSON.stringify(bad))
  }
  assert.equal(calls, 0, 'refused before any read')
  const t = busTransport({ ...base, chunk: 500, minChunk: 1 })
  assert.deepEqual(await t.poll(), [])
  assert.equal(t.cursor, 2001, 'a valid configuration reads to the head')
  assert.equal(calls, 3)
})

// ------------------------------------------------------------------------------------------------ L-4 ----
test('FIXED L-4: isNodeLimit no longer takes chain answers about gas/allowance/revert for node limits: RPC_ERROR, not RPC_UNAVAILABLE', async () => {
  const outOfGas = { code: -32000, message: 'gas required exceeds allowance (30000000)' }
  assert.equal(isNodeLimit(outOfGas), false)
  assert.equal(isNodeLimit({ code: -32000, message: 'exceeds block gas limit' }), false)
  assert.equal(isNodeLimit({ code: -32000, message: 'execution reverted: limit exceeded' }), false)
  assert.equal(isNodeLimit({ code: -32000, message: 'block range limit exceeded' }), true, 'real node limits are still recognised')
  assert.equal(isNodeLimit({ code: -32005, message: 'anything' }), true)
  const fetch = async (_u, init) => { const req = JSON.parse(init.body); return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: outOfGas })) }
  const rpc = createRpc({ urls: ['http://a', 'http://b'], quorum: 2, fetch })
  await assert.rejects(rpc.ethCall('0x' + '11'.repeat(20), '0x12345678'), (e) => e.code === 'RPC_ERROR', 'every node gave the same deterministic answer: it is an answer')
})

// ------------------------------------------------------------------------------------------------ L-5 ----
test('FIXED L-5: dueSettlements skips a consumer whose escrow state cannot be read and still returns everyone else', async () => {
  const chain = createFakeChain()
  const SIGNER_KEY = '0x' + '22'.repeat(32), signer = sig.privateKeyToAddress(SIGNER_KEY)
  const good = '0x' + 'a1'.repeat(20), bad = '0x' + 'b2'.repeat(20)
  chain.setChannel(good, ADDR.container, 1000n)
  const fetch = async (url, init) => {
    const req = JSON.parse(init.body)
    if (Array.isArray(req)) return eachCall(url, init, fetch)   // a JSON-RPC batch: call by call / 批量请求：逐个处理
    if (req.method === 'eth_call' && req.params[0].data.toLowerCase().includes('b2'.repeat(20))) {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32000, message: 'missing trie node' } }))
    }
    return chain.fetch(url, init)
  }
  const manifest = {
    tapeapi: '0.1', name: 'T', circuits: ADDR.circuits, tokenId: '1', container: ADDR.container, signer, delegation: null, dev: true,
    endpoints: { live: ['http://127.0.0.1/tapeapi/v1'], async: false },
    methods: [{ name: 'work', priceBEM: '0.00000001', params: {}, returns: {} }],
    payment: { escrow: ADDR.escrow, unit: 'BEM', decimals: 8 },
  }
  const logged = []
  const provider = createProvider({ manifest, signerKey: SIGNER_KEY, rpcUrls: ['http://rpc1', 'http://rpc2'], quorum: 2, fetch, escrowCacheMs: 0, allowHttp: true, log: (...a) => logged.push(a.join(' ')), methods: { work: async () => ({}) } })
  const soon = nowS() + 60
  await provider.store.set(bad, ADDR.container, { consumer: bad, provider: ADDR.container, cumulative: '5', expires: soon, sig: '0x' + '00'.repeat(65), signer: bad })
  await provider.store.set(good, ADDR.container, { consumer: good, provider: ADDR.container, cumulative: '5', expires: soon, sig: '0x' + '00'.repeat(65), signer: good })
  const due = await provider.dueSettlements()
  assert.equal(due.length, 1, 'the good consumer\'s voucher, 60 s from expiry, is returned')
  assert.equal(due[0].consumer.toLowerCase(), good)
  assert.equal(due[0].reason, 'deadline')
  assert.ok(logged.some((l) => l.toLowerCase().includes(bad) && /skipped/.test(l)), 'the unreadable consumer is reported, not silently dropped')
})

// Reference scale: parseUnits is exported and used above only through manifests; keep the import honest.
// 参考刻度：parseUnits 只经由清单间接使用；保留此测试让导入名副其实。
test('sanity: 1 unit = 0.00000001 BEM', () => { assert.equal(parseUnits('0.00000001'), 1n) })
