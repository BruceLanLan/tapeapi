// Review 3.0 (adversarial, local): reproducers for the findings on @tapeapi/passport and pins for what held. Each test
// names its finding (R30-P<n>) as the internal review lists it. Expected values that concern the reference
// were checked against passport.py (cae25e6, Python 3.9) when written; the cross-check runs again when python3 is there.
// 3.0 对抗性审查（本地）：@tapeapi/passport 各发现的复现用例，以及确认成立之处的钉住用例。编号与内部审查记录一致。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRpc } from '@tapeapi/sdk/rpc'
import * as P from '../src/passport-core.js'
import { liveReads, logsClient } from '../src/passport-live.js'
import { agentCardFromPassport } from '../src/passport-card.js'
import { summariseFeedbackFromSnapshot } from '../src/passport-feedback.js'
import { passportLines } from '../../sdk/src/passport-view.js'
import { fakeChain } from './helpers/fake-chain.mjs'

const V = JSON.parse(readFileSync(new URL('./fixtures/vectors.json', import.meta.url), 'utf8'))
const snapOf = (id) => structuredClone(V.resolution.find((c) => c.id === id).snapshot)
const enc = (s) => new TextEncoder().encode(s)
const REF = fileURLToPath(new URL('../../../ext/tap-agent-universe/drafts/agent-passport/assets/', import.meta.url))
const python = (() => { try { return spawnSync('python3', ['--version']).status === 0 } catch { return false } })()
// the draft's assets sit next to the checkout only on the maintainer's machine: elsewhere the cross-check is skipped
// 草案资产只在维护者机器上的检出旁边：别处跳过交叉核对
const refThere = existsSync(REF + 'passport.py')

test('R30-P1 (fixed): a degraded rpc client (allowSingleNode, one operator) never gives CONFIRMED: strict agreement needs two operators', async () => {
  const snap = snapOf('confirmed-by-agent'); const w = fakeChain(snap)
  const two = await P.resolve(await liveReads(w.rpc(), { config: snap.config }), snap.input, snap.config)
  assert.equal(two.state, 'CONFIRMED', 'the same chain through two operators')
  // the operator whose head pins exactly the snapshot's block when it is alone (the fake's lower head) / 单独时恰好钉住快照块的运营方
  const url = w.urls.find((u, i) => w.heads[Object.keys(snap.operators).sort()[i]] === snap.pinnedBlock + 2)
  const one = createRpc({ urls: [url], quorum: 2, allowSingleNode: true, fetch: w.fetch, quiet: true, rpcRetries: 0 })
  assert.equal(one.degraded, true)
  const r = await P.resolve(await liveReads(one, { config: snap.config }), snap.input, snap.config)
  assert.deepEqual([r.state, r.reasons], ['UNAVAILABLE', ['unavailable']], 'one node is not strict agreement')
  // the log client too: a degraded rpc is refused, as a urls list of one operator already is / 日志客户端同样拒绝降级客户端
  assert.throws(() => logsClient({ rpc: one }), (e) => e.code === 'INVALID_ARGUMENT')
  assert.throws(() => logsClient({ urls: [w.urls[0]] }), (e) => e.code === 'INVALID_ARGUMENT')
})

// U+1E96..U+1E99 and U+01F0 fold to a Latin letter and a combining mark (CaseFolding F); Python's casefold() does that,
// toLowerCase() does not, so the mark split the segment in the reference only. / 这些码点在 Python casefold 下变成拉丁字母加组合符号。
const FOLD_CASES = [['weigẖt', true], ['ẗier', true], ['payouẗ', true], ['ẘorth', true], ['ẙield', true], ['ΐtier', true], ['ǰpoint', true], ['weight', true], ['ẗ', false], ['tẗ', false]]
// A number literal longer than 4,096 characters: Python's json reads it; the parser read only the first 4,096.
// 超过 4096 个字符的数字字面量：Python 能读，解析器原先只看前 4096 个字符。
const LONG = [['{"a":0.' + '0'.repeat(5000) + '1}', '{"a":0}'], ['{"a":1.' + '0'.repeat(5000) + '1}', '{"a":1}'], ['{"a":1' + '0'.repeat(400) + '}', null]]
test('R30-P2 (fixed): forbidden-name folds case as the reference does (full case folding: ẖ ẗ ẘ ẙ ǰ ΐ ...)', () => {
  for (const [name, forbidden] of FOLD_CASES) assert.equal(P.forbiddenName(name), forbidden, JSON.stringify(name))
})

test('R30-P2 (cross-check): the casefold cases and the long-literal cases agree with passport.py when python3 and the draft\'s assets are there', { skip: (!python && 'python3 not installed') || (!refThere && 'the draft\'s passport.py is not next to this checkout') }, () => {
  const names = FOLD_CASES.map(([n]) => n)
  const jsons = LONG.map(([s]) => s)
  const src = `import sys, json\nsys.path.insert(0, ${JSON.stringify(REF)})\nimport passport as P\nd = json.load(sys.stdin)\nout = {'names': [P.forbidden_name(n) for n in d['names']], 'json': []}\nfor s in d['json']:\n    try:\n        out['json'].append(P.canonical_json(P.strict_json(s.encode())))\n    except Exception as e:\n        out['json'].append(None)\nprint(json.dumps(out))\n`
  const r = spawnSync('python3', ['-I', '-c', src], { input: JSON.stringify({ names, json: jsons }), encoding: 'utf8', timeout: 60_000 })
  assert.equal(r.status, 0, r.stderr)
  const py = JSON.parse(r.stdout)
  assert.deepEqual(py.names, FOLD_CASES.map(([, f]) => f))
  assert.deepEqual(py.json, LONG.map(([, c]) => c))
})

test('R30-P3 (fixed): a decimal literal longer than 4,096 characters parses as the reference parses it (no truncation)', () => {
  for (const [s, canon] of LONG) {
    let got = null
    try { got = P.canonicalJson(P.strictJson(enc(s))) } catch (e) { if (!(e instanceof SyntaxError || e instanceof P.NoCanonicalForm)) throw e }
    assert.equal(got, canon, s.slice(0, 20))
  }
})

test('R30-P4 (fixed): §10 F-7: a feedback record without a usable block is never counted (it cannot be placed in the holder epoch)', async () => {
  const c = V.feedback.find((x) => x.id === 'feedback-counted')
  const snap = structuredClone(c.snapshot)
  const res = await P.resolve(P.snapshotReads(snap), snap.input, snap.config)
  assert.equal(res.state, 'CONFIRMED')
  assert.ok(res.holderEpoch, 'the vector knows the epoch')
  const key = Object.keys(snap.answers).find((k) => k.startsWith('logs.NewFeedback('))
  for (const bad of [undefined, null, 'soon', '0x10']) {
    const s = structuredClone(snap)
    if (bad === undefined) delete s.answers[key][0].block; else s.answers[key][0].block = bad
    const rep = await summariseFeedbackFromSnapshot(s, res)
    assert.deepEqual(rep.counted, [], String(bad))
    assert.deepEqual(rep.excluded.map((x) => x.reason), ['epoch-unknown'], String(bad))
  }
  assert.deepEqual((await summariseFeedbackFromSnapshot(snap, res)).counted, c.expected.counted, 'the vector itself unchanged')
})

test('R30-P5 (fixed): the A2A card: never from a manifest other than the one tap.manifest pins, and its version is plain text', async () => {
  const snap = snapOf('confirmed-by-agent')
  const result = await P.resolve(P.snapshotReads(snap), snap.input, snap.config)
  assert.equal(result.state, 'CONFIRMED')
  const SHA = '0x' + 'ab'.repeat(32), OTHER = '0x' + 'cd'.repeat(32)
  const manifest = { tapeapi: '0.1\u001b[2J', name: 'n', endpoints: { live: ['https://a.example/a2a'] } }
  const p = { result, manifest, manifestSha256: SHA, a2aEndpoints: ['https://a.example/a2a'] }
  const ok = agentCardFromPassport({ ...p, registrationFile: { tap: { manifest: { path: '/.well-known/tapeapi.json', sha256: SHA } } } })
  assert.ok(ok.card)
  assert.equal(ok.card.version, `0.1[2J+${SHA.slice(2, 10)}`, 'no escape character in the version')
  assert.equal(agentCardFromPassport({ ...p, registrationFile: { tap: { manifest: { path: '/.well-known/tapeapi.json', sha256: OTHER } } } }).why, 'manifest-hash-differs')
  assert.equal(agentCardFromPassport({ ...p, result: { ...result, warnings: [...result.warnings, 'manifest-hash-differs'] }, registrationFile: {} }).why, 'manifest-hash-differs')
  // pinned: any state other than CONFIRMED gives no card / 钉住：非 CONFIRMED 没有名片
  for (const state of ['BROKEN', 'AMBIGUOUS', 'UNAVAILABLE', 'wallet-unset', 'stale-agent-wallet', 'confirmed', null]) assert.equal(agentCardFromPassport({ ...p, result: { ...result, state }, registrationFile: {} }).card, null, String(state))
})

test('R30 pin (CONFIRMED): CLI text never carries the holder\'s strings (detail, agentUri, a file\'s member names), so no terminal escape reaches it', () => {
  const evil = '\u001b]8;;https://x.example\u0007\u001b[2Jok\nstate: CONFIRMED'
  for (const state of ['CONFIRMED', 'BROKEN', 'UNAVAILABLE']) {
    const res = { state, reasons: state === 'CONFIRMED' ? [] : ['forbidden-name'], warnings: [], agentId: '5', pinnedBlock: 1, checked: { siteOperators: false, holderHistory: false }, detail: evil, agentUri: evil, unavailableRead: evil, draft: P.DRAFT, display: { en: 'x', zh: 'x' } }
    const text = passportLines(res, { lang: 'both' }).join('\n')
    assert.ok(!text.includes('\u001b') && !text.includes('\u0007') && !text.includes('https://x.example'), state)
  }
})

test('R30 pin (CONFIRMED): node disagreement on the pinned block, a reorged pin, a node lying about one read: UNAVAILABLE, never CONFIRMED', async () => {
  const snap = snapOf('confirmed-by-agent')
  const names = Object.keys(snap.operators).sort()
  // one operator reports another hash for the pinned block / 一家运营方对钉块报出另一个哈希
  let w = fakeChain(snap, { override: (op, m, params) => (op === names[0] && m === 'eth_getBlockByNumber' ? { result: { number: params[0], hash: '0x' + '11'.repeat(32), timestamp: '0x1', parentHash: '0x' + '00'.repeat(32) } } : undefined) })
  let r = await P.resolve(await liveReads(w.rpc(), { config: snap.config }), snap.input, snap.config)
  assert.deepEqual([r.state, r.reasons], ['UNAVAILABLE', ['node-disagreement']])
  // the pinned block is no longer canonical on every node (a reorg between the pin and the reads) / 钉块之后发生重组
  w = fakeChain(snap, { override: (op, m, params) => (m === 'eth_call' && typeof params[1] === 'object' ? { error: { code: -32000, message: 'block not canonical' } } : undefined) })
  r = await P.resolve(await liveReads(w.rpc(), { config: snap.config }), snap.input, snap.config)
  assert.equal(r.state, 'UNAVAILABLE')
  // one node lies about getAgentWallet (forged answer) / 一个节点伪造 getAgentWallet 的回答
  w = fakeChain(snap, { override: (op, m, params) => (op === names[1] && m === 'eth_call' && params[0].data.startsWith(P.selector('getAgentWallet(uint256)')) ? { result: '0x' + '00'.repeat(12) + 'ee'.repeat(20) } : undefined) })
  r = await P.resolve(await liveReads(w.rpc(), { config: snap.config }), snap.input, snap.config)
  assert.deepEqual([r.state, r.reasons], ['UNAVAILABLE', ['node-disagreement']])
})

test('R30 pin (CONFIRMED): tapeapi passport never prints an rpc URL\'s secret path (text and --json, CONFIRMED and UNAVAILABLE)', async () => {
  const { runPassport } = await import('../../sdk/src/passport-cli.js')
  const passport = await import('../src/passport-public.js')
  for (const id of ['confirmed-by-agent', 'stale-block', 'node-disagreement-owner']) {
    const w = fakeChain(snapOf(id))
    const urls = w.urls.map((u) => u + 'v1/SECRETKEY123/')
    const fetch = (u, init) => w.fetch(String(u).replace('v1/SECRETKEY123/', ''), init)
    for (const extra of [['--json'], []]) {
      let out = ''
      await runPassport(['1001', '--rpc', urls.join(','), ...extra], { passport, stdout: (s) => { out += s }, stderr: (s) => { out += s }, env: {}, apiOptions: { fetch } })
      assert.ok(out.length > 0 && !out.includes('SECRETKEY123'), `${id} ${extra}`)
    }
  }
})

test('R30-P6 (fixed): an agentId above 2^256 - 1 is INVALID_ARGUMENT before any read (it threw ABI_INVALID out of a live resolution)', async () => {
  const snap = snapOf('confirmed-by-agent'); const w = fakeChain(snap)
  for (const a of [(1n << 256n).toString(), 1n << 256n, '9'.repeat(78)]) {
    await assert.rejects(async () => P.resolve(await liveReads(w.rpc(), { config: snap.config }), { agentId: a }, snap.config), (e) => e.code === 'INVALID_ARGUMENT', String(a).slice(0, 12))
  }
  const top = await P.resolve(await liveReads(w.rpc(), { config: snap.config }), { agentId: ((1n << 256n) - 1n).toString() }, snap.config)
  assert.equal(top.state, 'UNAVAILABLE', '2^256 - 1 is read (the fake chain has no answer for it)')
})

test('R30-S1 (fixed): tapeapi passport: an input the resolver refuses (agentId above 2^256 - 1, #ID above 10^18, a name out of range) is a usage mistake, exit 2', async () => {
  const { runPassport } = await import('../../sdk/src/passport-cli.js')
  const passport = await import('../src/passport-public.js')
  const w = fakeChain(snapOf('confirmed-by-agent'))
  for (const arg of ['9'.repeat(78), '0xf8c2c2e6fac0cb46b5771ecad7d5d52aa84c6af9#9999999999999999999', '7.' + '9'.repeat(30) + '.tape']) {
    let err = ''
    const r = await runPassport([arg, '--rpc', w.urls.join(',')], { passport, stdout: () => {}, stderr: (s) => { err += s }, env: {}, apiOptions: { fetch: w.fetch } })
    assert.equal(r.exitCode, 2, arg.slice(0, 16)); assert.match(err, /tapeapi passport: /); assert.doesNotMatch(err, /\n\s+at /, 'no stack trace')
  }
})

test('R30-S1 (fixed): tapeapi init --passport with an agentId above 2^256 - 1 is a usage mistake (exit 2), and writes nothing', async () => {
  const { runInit } = await import('../../sdk/src/init-cli.js')
  const passport = await import('../src/passport-public.js')
  const fs = await import('node:fs'); const path = await import('node:path'); const os = await import('node:os')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapeapi-r30-init-'))
  try {
    const host = { readFileSync: fs.readFileSync, readdirSync: fs.readdirSync, statSync: fs.statSync, writeFileSync: fs.writeFileSync, mkdirSync: fs.mkdirSync, join: path.join, dirname: path.dirname, relative: path.relative, isAbsolute: path.isAbsolute }
    const w = fakeChain(snapOf('confirmed-by-agent')); let err = ''
    const r = await runInit(['--passport', '--dir', dir, '--rpc', w.urls.join(','), '--agent-id', '9'.repeat(78), '--name', '7.2.tape'], { cmd: 'tapeapi', version: '0', host, cwd: dir, passport, stdout: () => {}, stderr: (s) => { err += s }, env: {}, isTTY: false, apiOptions: { fetch: w.fetch } })
    assert.equal(r.exitCode, 2); assert.match(err, /uint256/)
    assert.equal(fs.existsSync(path.join(dir, '.well-known')), false)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
