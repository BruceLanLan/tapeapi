// T8 (the registration file tapeapi init writes) and T9 (the A2A card, display only), on the draft's synthetic chain.
// T8：tapeapi init 写出的登记文件；T9：A2A 名片（只用于显示）。用草案的合成链。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as P from '../src/passport-core.js'
import { buildRegistrationFile, checkRegistrationFile, canonicalAgentUri, preparePassportRegistration, agentCardFromPassport, DISPLAY_FORBIDDEN } from '../src/passport-public.js'
import { toolsDigest } from '@tapeapi/sdk/mcp'
import { V, withRegistrationFile } from './helpers/extra-cases.mjs'
import { fakeChain } from './helpers/fake-chain.mjs'

const base = V.resolution.find((c) => c.id === 'confirmed-by-agent').snapshot
const MANIFEST_SHA = '0x' + base.answers[`${base.config.siteRegistry}.fileInfo(0x2737ba45df033da7be7d329e13e0898ebeb1c97c,.well-known/tapeapi.json)`].slice(2 + 128, 2 + 192)
const FACTS = { agentId: 1001n, processor: '0xf8c2c2e6fac0cb46b5771ecad7d5d52aa84c6af9', tokenId: 7n, container: '0x2737ba45df033da7be7d329e13e0898ebeb1c97c', name: '7.2.tape' }

test('T8: buildRegistrationFile writes canonical JSON that its own check accepts and that resolves CONFIRMED on the synthetic chain', async () => {
  const f = buildRegistrationFile({ ...FACTS, manifestSha256: MANIFEST_SHA, description: 'Example.', gatewayDomain: 'gateway.example' })
  assert.deepEqual(f.problems, [])
  assert.ok(f.bytes.length <= 65_536)
  assert.equal(f.text, P.canonicalJson(JSON.parse(f.text)), 'canonical form')
  assert.equal(f.agentUri, 'https://7-2.gateway.example/.well-known/agent-registration.json')
  assert.equal(f.key, '.well-known/agent-registration.json')
  assert.deepEqual(checkRegistrationFile(f.bytes, FACTS), { ok: true })
  const doc = JSON.parse(f.text)
  assert.deepEqual(doc.registrations, [{ agentId: 1001, agentRegistry: 'eip155:56:0x8004a169fb4a3325136eb29fa0ceb6d2e539a432' }])
  assert.deepEqual(doc.services[0], { endpoint: 'tape://7.2.tape', name: 'tape', version: '1' })
  assert.deepEqual(doc.tap, { chainId: 56, container: FACTS.container, manifest: { path: '/.well-known/tapeapi.json', sha256: MANIFEST_SHA }, processor: FACTS.processor, tokenId: '7', v: 1 })
  const snap = withRegistrationFile(base, f.text)
  const r = await P.resolve(P.snapshotReads(snap), snap.input, snap.config)
  assert.deepEqual([r.state, r.reasons, r.warnings], ['CONFIRMED', [], []])
  // The file's own check: another identity, another circuit, a forbidden name. / 自检：别的身份、别的电路、禁用名。
  assert.equal(checkRegistrationFile(f.bytes, { ...FACTS, agentId: 7n }).reason, 'not-listed')
  assert.equal(checkRegistrationFile(f.bytes, { ...FACTS, tokenId: 8n }).reason, 'file-chain-mismatch')
  assert.equal(checkRegistrationFile(new TextEncoder().encode(f.text.replace('"v":1', '"v":1,"reward":1'))).reason, 'forbidden-name')
  assert.throws(() => buildRegistrationFile({ ...FACTS, name: '8.2.tape' }), /on-chain name/)
  assert.throws(() => canonicalAgentUri(7n, 2, 'not a domain'), /gatewayDomain/)
})

test('T8: preparePassportRegistration reads only (fake chain), stops at the first failing check, and builds the file from chain reads', async () => {
  const w = fakeChain(base)
  const r = await preparePassportRegistration({ rpc: w.rpc(), config: base.config, agentId: '1001', name: '7.2.tape', gatewayDomain: 'gateway.example' })
  assert.equal(r.status, 'ready')
  assert.deepEqual(r.checks.map((c) => [c.id, c.ok]), [['chain', true], ['circuit', true], ['identity', true], ['key', true], ['manifest', true], ['file', true]])
  assert.equal(r.holder, '0x4f09d00967a87548a911ba8727b1cb4636afd063'); assert.equal(r.name, '7.2.tape')
  assert.equal(r.file.text, buildRegistrationFile({ ...FACTS, manifestSha256: MANIFEST_SHA }).text)
  assert.equal(r.agentUri, 'https://7-2.gateway.example/.well-known/agent-registration.json')
  assert.ok(r.steps.length >= 3)
  assert.ok(w.calls.every((c) => ['eth_blockNumber', 'eth_getBlockByNumber', 'eth_chainId', 'eth_getStorageAt', 'eth_call'].includes(c.method)), 'reads only')
  const cases = [['identity-changed-hands', 'fail', 'holder-mismatch'], ['not-opened', 'fail', 'not-opened'], ['no-passport-key', 'fail', 'no-passport-key'], ['registry-changed', 'unavailable', 'registry-changed'], ['key-chain-mismatch', 'fail', 'chain-mismatch']]
  for (const [id, status, reason] of cases) {
    const snap = V.resolution.find((c) => c.id === id).snapshot
    const agentId = snap.input.agentId ?? '1001'
    const name = id === 'not-opened' || id === 'no-passport-key' ? null : '7.2.tape'
    const circuit = name ? undefined : await (async () => { const k = Object.keys(snap.answers).find((x) => x.includes('.isOpened(')); const m = /isOpened\((0x[0-9a-f]{40}),([0-9]+)\)/.exec(k); return { processor: m[1], tokenId: m[2] } })()
    const got = await preparePassportRegistration({ rpc: fakeChain(snap).rpc(), config: snap.config, agentId, ...(name ? { name } : { circuit }) })
    assert.deepEqual([got.status, got.reason], [status, reason], id)
    assert.equal(got.file, undefined)
  }
})

const manifest = { tapeapi: '0.1', name: 'digits-agent ‮evil', endpoints: { live: ['https://agent.example/a2a', 'https://agent.example/rpc'], async: false },
  agent: { capabilities: ['vision'], tasks: [{ kind: 'classify-digits', pricing: { mode: 'free' }, description: 'One 8x8 image in, one digit out.' }], mandates: { accepts: false } } }
const confirmedResult = async () => P.resolve(P.snapshotReads(base), base.input, base.config)

test('T9: the A2A card only for CONFIRMED, every A2A 1.0 member Appendix B names, no signatures, holder text as plain text', async () => {
  const result = await confirmedResult()
  const { card, notes } = agentCardFromPassport({ result, manifest, manifestSha256: MANIFEST_SHA, registrationFile: { description: 'Classifies 8x8 digit images.' }, a2aEndpoints: ['https://agent.example/a2a'] })
  assert.deepEqual(Object.keys(card).sort(), ['capabilities', 'defaultInputModes', 'defaultOutputModes', 'description', 'name', 'skills', 'supportedInterfaces', 'version'])
  assert.equal(card.name, 'digits-agent evil', 'the bidi override is removed')
  assert.equal(card.version, `0.1+${MANIFEST_SHA.slice(2, 10)}`)
  assert.deepEqual(card.supportedInterfaces, [{ url: 'https://agent.example/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }])
  assert.deepEqual(card.skills, [{ id: 'classify-digits', name: 'classify-digits', description: 'One 8x8 image in, one digit out.', tags: ['vision'] }])
  assert.equal(card.signatures, undefined)
  assert.ok(notes.some((n) => /never a source of signers/.test(n.en)))
  for (const t of [JSON.stringify(card), ...notes.flatMap((n) => [n.en, n.zh])]) for (const bad of DISPLAY_FORBIDDEN) assert.ok(!t.toLowerCase().includes(bad), bad)
  // No card for any other state, nor without an A2A endpoint the manifest lists. / 其它状态、没有清单所列的 A2A 端点：没有名片。
  for (const id of ['stale-agent-wallet', 'registration-file-missing', 'double-registration-both-listed', 'registry-changed', 'transferred-in-wallet-unset']) {
    const snap = V.resolution.find((c) => c.id === id).snapshot
    const r = await P.resolve(P.snapshotReads(snap), snap.input, snap.config)
    assert.deepEqual(agentCardFromPassport({ result: r, manifest, manifestSha256: MANIFEST_SHA, registrationFile: {}, a2aEndpoints: ['https://agent.example/a2a'] }).card, null, id)
  }
  assert.equal(agentCardFromPassport({ result, manifest, manifestSha256: MANIFEST_SHA, registrationFile: {}, a2aEndpoints: [] }).why, 'no-a2a-endpoint')
  assert.equal(agentCardFromPassport({ result, manifest, manifestSha256: MANIFEST_SHA, registrationFile: {}, a2aEndpoints: ['https://elsewhere.example/'] }).why, 'a2a-endpoint-not-in-manifest')
})

test("T9: with the manifest's mcp member, #16's digest check applies and the card never replaces it", async () => {
  const result = await confirmedResult()
  const tools = [{ name: 'classify', description: 'Classify one image', inputSchema: { type: 'object' } }]
  const m = { ...manifest, mcp: { endpoint: 'https://agent.example/mcp', toolsSha256: toolsDigest(tools) } }
  const p = { result, manifest: m, manifestSha256: MANIFEST_SHA, registrationFile: {}, a2aEndpoints: ['https://agent.example/a2a'] }
  let out = agentCardFromPassport({ ...p, tools })
  assert.ok(out.card); assert.ok(out.notes.some((n) => /toolsSha256/.test(n.en)))
  assert.equal(JSON.stringify(out.card).includes('classify"'), false, 'no tool list in the card')
  out = agentCardFromPassport({ ...p, tools: [{ ...tools[0], description: 'changed' }] })
  assert.deepEqual([out.card, out.why], [null, 'mcp-digest-mismatch'])
})
