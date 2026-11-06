// A unit per asset (Policy Circuit Gate draft, TAPs pull request #84 at 0b73174, §3.1, §3.3): beyond the draft's vectors,
// the rules the vectors name only by example. 每种资产一个单位（草稿 §3.1、§3.3）：向量只举例的规则，这里逐条断言。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as pc from '@tapeapi/policy-circuit'

const A18 = '0x' + 'aa'.repeat(20), A6 = '0x' + 'bb'.repeat(20), NONE = '0x' + 'cc'.repeat(20), P1 = '0x' + '11'.repeat(20)
const tables = (a = {}, b = {}) => ({ assets: { [A18]: { class: 1, unit: '1000000000000000', ...a }, [A6]: { class: 2, unit: '1000000', ...b } }, counterparties: { [P1]: 1 } })
const req = (asset, amount) => ({ amount, asset, counterparty: P1, kind: 1, ts: 1793008800 })
const code = (fn) => { try { fn(); return null } catch (e) { return e.code } }

test('each asset is counted in its own unit, never in another asset\'s (the 10^9 base units of the draft\'s example)', () => {
  const t = tables()
  assert.equal(pc.policyRequestFields(req(A18, '1000000000'), t).amount, 1, '10^9 base units: one unit of the 10^15-unit asset')
  assert.equal(pc.policyRequestFields(req(A6, '1000000000'), t).amount, 1000, '...and 1,000 units of the 10^6-unit asset')
  assert.equal(toHex(pc.policyRequestWord(req(A6, '1000000000'), t)), '0xe80300000002010110510a0000000000')
  assert.equal(toHex(pc.policyRequestWord(req(A18, '1000000000000000'), t)), '0x010000000001010110510a0000000000')
})

test('an asset the tables do not list is an overflow with a saturated amount and class 0, zero included (fail closed)', () => {
  for (const amount of ['0', '1', (2n ** 255n).toString()]) {
    const f = pc.policyRequestFields(req(NONE, amount), tables())
    assert.deepEqual([f.amount, f.overflow, f.asset], [0xffffffff, 1, 0], `amount ${amount}`)
  }
  assert.deepEqual(pc.policyRequestWord(req(NONE, '0'), tables()), pc.policyRequestWord(req(NONE, '5'), tables()))
})

test('one unit of change is another tablesHash; the earlier single amountUnit form and bare classes are tables-malformed', () => {
  assert.notEqual(pc.policyTablesHash(tables()), pc.policyTablesHash(tables({}, { unit: '1000' })))
  const t = tables()
  const bad = {
    'amountUnit form': { amountUnit: '1000', assets: { [A18]: 1 }, counterparties: t.counterparties },
    'bare class': { assets: { [A18]: 1 }, counterparties: t.counterparties },
    'unit missing': tables({ unit: undefined }),
    'unit 0': tables({ unit: '0' }),
    'unit 2^256': tables({ unit: (2n ** 256n).toString() }),
    'unit a number': tables({ unit: 1000 }),
    'unit a bigint': tables({ unit: 1000n }),
    'unit leading zero': tables({ unit: '01' }),
    'unit negative': tables({ unit: '-1' }),
    'entry with another member': tables({ extra: 1 }),
    'class 0': tables({ class: 0 }),
    'class 256': tables({ class: 256 }),
  }
  for (const [name, x] of Object.entries(bad)) assert.equal(code(() => pc.checkPolicyTables(x)), 'tables-malformed', name)
  assert.equal(code(() => pc.checkPolicyTables(tables({ unit: (2n ** 256n - 1n).toString() }))), null, '2^256 - 1 is the largest unit')
  assert.equal(pc.checkPolicyTables(t).assets.get(A6).unit, 1000000n)
  assert.equal(pc.checkPolicyTables(t).assets.get(A6).class, 2)
})

function toHex(b) { return '0x' + Buffer.from(b).toString('hex') }
