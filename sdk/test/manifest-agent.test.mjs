// The optional `agent` member of a manifest (container agents, 1.7, @experimental; Idea TapeOutProtocol/TAPs#41):
// validated on request only. validateManifest ignores it, so no 1.x resolution changes.
// 清单可选的 agent 成员：只在调用方请求时校验；validateManifest 忽略它，1.x 的解析行为不变。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { validateManifest, validateAgentMember } from '../src/manifest.js'

const AG = '0x' + 'a6'.repeat(20)
const CIRCUITS = '0x' + '50'.repeat(20)
const nowS = () => 1_791_000_000   // fixed: no wall clock / 固定时间
test('the manifest `agent` member: validated on request only; validateManifest ignores it (no 1.x resolution changes)', () => {
  const member = {
    capabilities: ['chain.read.bsc', 'report'],
    tasks: [
      { kind: 'report.attested-read', pricing: { mode: 'fixed', token: '0x' + 'b0'.repeat(20), amount: '1000000', unit: 'task' }, maxDurationS: 86400 },
      { kind: 'translate', pricing: { mode: 'quote' } },
      { kind: 'ping', pricing: { mode: 'free' }, extra: 'ignored' },
    ],
    mandates: { accepts: true, enforcement: ['none', 'voucher'] },
    terms: 'sha256:' + 'ab'.repeat(32),
    future: { anything: true },
  }
  const v = validateAgentMember(member)
  assert.deepEqual(v.mandates, { accepts: true, enforcement: ['none'] })
  assert.equal('future' in v, false); assert.equal('extra' in v.tasks[2], false)
  for (const bad of [
    { ...member, tasks: [] }, { ...member, mandates: {} }, { ...member, terms: 'md5:x' },
    { ...member, tasks: [{ kind: 'x', pricing: { mode: 'fixed', token: '0x' + 'b0'.repeat(20), amount: '1.5', unit: 'task' } }] },
    { ...member, tasks: [{ kind: 'x', pricing: { mode: 'free', amount: '1' } }] },
    { ...member, tasks: [{ kind: 'X Y', pricing: { mode: 'free' } }] },
    { ...member, capabilities: ['a', 'a'] },
  ]) assert.throws(() => validateAgentMember(bad), (e) => e.code === 'MANIFEST_INVALID')
  // a manifest whose agent member is garbage is still a valid manifest: clients ignore members they do not know
  const base = { tapeapi: '0.1', circuits: CIRCUITS, tokenId: '12', container: AG, signer: AG, delegation: { expires: nowS() + 100, sig: '0x' + '11'.repeat(65) }, endpoints: { live: ['https://a.example'], async: false }, methods: [{ name: 'm', priceBEM: '0', params: {}, returns: {} }] }
  assert.doesNotThrow(() => validateManifest({ ...base, agent: { tasks: 'nonsense' } }))
})

test('validateAgentMember and its constants are declared @experimental in the manifest subpath', () => {
  const md = readFileSync(new URL('../types/manifest.d.ts', import.meta.url), 'utf8')
  for (const n of ['validateAgentMember', 'AGENT_PRICING_MODES', 'AGENT_MAX_TASKS', 'AGENT_MAX_CAPABILITIES', 'AgentMember']) {
    const at = md.search(new RegExp(`^export (declare (const|function) |interface )${n}\\b`, 'm'))
    assert.ok(at > 0, n)
    const before = md.slice(0, at).trimEnd().split('\n').slice(-2).join('\n')
    assert.match(before, /@experimental/, n)
  }
})
