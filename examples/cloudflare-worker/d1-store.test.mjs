// d1-store.js 的 SQL 以前一次都没被执行过。这里用 Node 自带的 SQLite（D1 底层就是 SQLite）真跑它。
// The SQL in d1-store.js had never been executed. D1 is SQLite underneath, so run it on Node's built-in SQLite
// behind a thin shim with D1's API shape: prepare().bind().first() / .run() -> { meta: { changes } } / .all().
import test from 'node:test'
import assert from 'node:assert/strict'
import { d1Store } from './d1-store.js'

let DatabaseSync = null
try { ({ DatabaseSync } = await import('node:sqlite')) } catch { /* older Node: tests skip */ }
const SCHEMA = `CREATE TABLE IF NOT EXISTS meter (
  consumer TEXT NOT NULL, provider TEXT NOT NULL,
  cumulative TEXT NOT NULL, expires INTEGER NOT NULL, sig TEXT NOT NULL,
  signer TEXT NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (consumer, provider))`

function d1(db) {
  return {
    prepare(sql) {
      const st = db.prepare(sql)
      let args = []
      const api = {
        bind: (...a) => { args = a; return api },
        first: async () => st.get(...args) ?? null,
        run: async () => { const r = st.run(...args); return { success: true, meta: { changes: Number(r.changes) } } },
        all: async () => ({ results: st.all(...args) }),
      }
      return api
    },
  }
}
const C = '0x00000000000000000000000000000000000000C0', P = '0x00000000000000000000000000000000000000B0'
const rec = (cum) => ({ consumer: C, provider: P, cumulative: String(cum), expires: 1790000000, sig: '0x' + 'ab'.repeat(65), signer: C, updatedAt: 1 })
const fresh = () => { const db = new DatabaseSync(':memory:'); db.exec(SCHEMA); return { db, store: d1Store(d1(db)) } }

test('advance() inserts, only ever moves up, and says whether it moved', { skip: !DatabaseSync && 'node:sqlite unavailable' }, async () => {
  const { store } = fresh()
  assert.equal(await store.get(C, P), null)
  assert.equal(await store.advance(C, P, rec(100)), true, 'first write inserts')
  assert.equal(await store.advance(C, P, rec(250)), true)
  assert.equal(await store.advance(C, P, rec(200)), false, 'a lower cumulative must not win')
  assert.equal(await store.advance(C, P, rec(250)), false, 'nor an equal one')
  assert.equal((await store.get(C, P)).cumulative, '250')
})

test('cumulative is TEXT, yet compared as a number: "10" beats "9"', { skip: !DatabaseSync && 'node:sqlite unavailable' }, async () => {
  // Without the CAST, SQLite would compare the TEXT column as text, "9" > "10", and a provider's meter would
  // freeze the first time a cumulative gained a digit.
  // 没有 CAST 的话，SQLite 会按文本比较 TEXT 列，"9" > "10"，计量在累计额多出一位数时就会卡住。
  const { store } = fresh()
  assert.equal(await store.advance(C, P, rec(9)), true)
  assert.equal(await store.advance(C, P, rec(10)), true)
  assert.equal(await store.advance(C, P, rec(99)), true)
  assert.equal(await store.advance(C, P, rec(100)), true)
  assert.equal((await store.get(C, P)).cumulative, '100')
  // The largest cumulative BEM can reach: supply ~2.05e13 base units (8 decimals), far inside int64.
  // BEM 能达到的最大累计额约 2.05e13 个最小单位，远在 int64 以内。
  assert.equal(await store.advance(C, P, rec('20466844665222')), true)
  assert.equal(await store.advance(C, P, rec('20466844665223')), true)
  assert.equal(await store.advance(C, P, rec('20466844665222')), false)
})

test('two "isolates" racing on one database leave exactly the highest cumulative', { skip: !DatabaseSync && 'node:sqlite unavailable' }, async () => {
  const { db } = fresh()
  const isolateA = d1Store(d1(db)), isolateB = d1Store(d1(db))
  const values = [...Array(300)].map((_, i) => i + 1).sort(() => Math.random() - 0.5)
  const wins = await Promise.all(values.map((v, i) => (i % 2 ? isolateA : isolateB).advance(C, P, rec(v))))
  assert.equal((await isolateA.get(C, P)).cumulative, '300')
  // every value that "won" was higher than everything recorded before it: the recorded sequence is monotonic
  // 每个"赢了"的值都高于此前记录的一切：记录序列单调递增
  const winners = values.filter((_, i) => wins[i])
  for (let i = 1; i < winners.length; i++) assert.ok(winners[i] > winners[i - 1])
})

test('set() overwrites, all() lists, and keys are case-insensitive addresses', { skip: !DatabaseSync && 'node:sqlite unavailable' }, async () => {
  const { store } = fresh()
  await store.set(C, P, rec(5))
  await store.set(C.toUpperCase().replace('0X', '0x'), P, rec(7))
  assert.equal((await store.get(C, P.toUpperCase().replace('0X', '0x'))).cumulative, '7')
  assert.equal((await store.all()).length, 1)
})

test('a provider running on the D1 store is instance-safe and records its meter there', { skip: !DatabaseSync && 'node:sqlite unavailable' }, async () => {
  const { createProvider } = await import('../../server/src/index.js')
  const { createFakeChain, ADDR } = await import('../../sdk/test/helpers/fake-chain.mjs')
  const { privateKeyToAddress, signDigest, delegationDigest, voucherDigest } = await import('../../sdk/src/sig.js')
  const { parseUnits } = await import('../../sdk/src/index.js')
  const HOLDER = '0x' + '11'.repeat(32), SIGNER = '0x' + '22'.repeat(32), CONSUMER = '0x' + '33'.repeat(32)
  const signer = privateKeyToAddress(SIGNER), consumer = privateKeyToAddress(CONSUMER)
  const exp = Math.floor(Date.now() / 1000) + 86400
  const manifest = {
    tapeapi: '0.1', name: 'D1 metered', circuits: ADDR.circuits, tokenId: '4246', container: ADDR.container, signer,
    delegation: { expires: exp, sig: signDigest(delegationDigest(56, ADDR.hub, { container: ADDR.container, signer, expires: exp }), HOLDER) },
    endpoints: { live: ['https://d1.example/tapeapi/v1'], async: false },
    methods: [{ name: 'q', priceBEM: '0.0001', params: {}, returns: {} }],
    payment: { escrow: ADDR.escrow, unit: 'BEM', decimals: 8 },
  }
  const chain = createFakeChain(); chain.setChannel(consumer, ADDR.container, parseUnits('1'))
  const { db, store } = fresh()
  const p = createProvider({ minVoucherLifeS: 0, manifest, signerKey: SIGNER, rpcUrls: ['http://rpc1', 'http://rpc2'], quorum: 2, chainId: 56, fetch: chain.fetch, escrowCacheMs: 0, log: () => {}, store, methods: { q: () => ({ ok: 1 }) } })
  assert.equal(p.stats().singleInstance, false, 'a store with advance() is flagged instance-safe')
  const price = parseUnits('0.0001')
  for (let i = 1; i <= 3; i++) {
    const v = { consumer, provider: ADDR.container, cumulative: (BigInt(i) * price).toString(), expires: exp }
    v.sig = signDigest(voucherDigest(56, ADDR.escrow, { ...v, cumulative: BigInt(v.cumulative) }), CONSUMER)
    const r = await p.invoke({ id: `d${i}`, method: 'q', params: {}, voucher: v })
    assert.equal(r.env.ok, true, JSON.stringify(r.env.error))
  }
  const row = db.prepare('SELECT cumulative FROM meter').get()
  assert.equal(row.cumulative, (3n * price).toString(), 'the meter lives in D1, not in process memory')
})
