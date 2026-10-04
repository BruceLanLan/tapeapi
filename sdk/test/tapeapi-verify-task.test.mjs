// `tapeapi-verify task <thread.json> [--payment <recipient> <index>]` (1.7, EXPERIMENTAL): the container-agent thread check as a subcommand
// of the existing CLI, run in-process on the fake chain (runTask, as the AI part of this file's neighbour exports routesOf / route), and the
// differential that nothing else in the CLI changed: the 1.6 behaviour captured verbatim before the subcommand existed
// (fixtures/tapeapi-verify-1.6-baseline.json) is compared byte for byte with the real binary, spawned.
// Adversarial cases are named FIXED TV-xx; each was checked by removing the line that implements it (the test turns red).
// `task` 子命令：容器代理线程核验，在假链上进程内运行；以及"其余一切逐字不变"的差分：1.6 的行为在子命令出现之前原样记录，与真实二进制逐字节对比。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as A from '../src/agent-public.js'
import { runTask } from '../bin/tapeapi-verify.js'
import { PROCESSORS_SNAPSHOT } from '../src/processors-snapshot.js'
import { standardWorld, happyThread, mandateOf, mandateMsg, revocationMsg, revocationFile, deliverMsg, KEYS, addrOf, P, AG, S, TOKEN, ADDR, nowS, NOW } from './helpers/agent-chain.mjs'

const BIN = fileURLToPath(new URL('../bin/tapeapi-verify.js', import.meta.url))
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const TMP = mkdtempSync(join(tmpdir(), 'tapeapi-verify-task-'))
test.after(() => rmSync(TMP, { recursive: true, force: true }))
const file = (name, v) => { const p = join(TMP, name); writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v)); return p }
const spawn = (args) => { const r = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', timeout: 30_000 }); return { code: r.status, stdout: r.stdout, stderr: r.stderr } }
async function run(x, args) {
  let stdout = '', stderr = ''
  const code = await runTask(args, { api: x.api(), clock: () => NOW, out: (t) => { stdout += t }, err: (t) => { stderr += t } })
  return { code, stdout, stderr }
}
const HP = addrOf(KEYS.principalHolder)
const HEAD = 62_000_000
const MB = HEAD - 100

test('FIXED TV-01: nothing outside `task` changed: the 1.6 output, stderr and exit status are byte for byte the same, and --help only gained the task text', () => {
  const base = JSON.parse(readFileSync(new URL('./fixtures/tapeapi-verify-1.6-baseline.json', import.meta.url), 'utf8'))
  assert.equal(base.cases.length, 10)
  const put = (s) => s.replaceAll('@VERSION@', VERSION)
  for (const c of base.cases) {
    const r = spawn(c.args)
    const what = JSON.stringify(c.args)
    assert.equal(r.code, c.code, `${what}: exit status`)
    if (c.args.includes('--help') || c.args.includes('-h')) {
      // the 1.6 help, verbatim, then the new text and nothing else
      assert.ok(r.stdout.startsWith(put(c.stdout)), `${what}: the 1.6 help is the beginning, unchanged`)
      const extra = r.stdout.slice(put(c.stdout).length)
      assert.match(extra, /^\ntapeapi-verify task \(experimental, 1\.7; not covered by the 1\.x compatibility promise\)/)
      assert.match(extra, /tapeapi-verify task（实验性，1\.7/)
      assert.equal(r.stderr, '')
    } else {
      assert.equal(r.stdout, put(c.stdout), `${what}: stdout`)
      assert.equal(r.stderr, put(c.stderr), `${what}: stderr`)
    }
  }
})

test('the task usage: `task --help` prints only the task text and exits 0; `task` alone is a usage mistake (2)', () => {
  const h = spawn(['task', '--help'])
  assert.equal(h.code, 0)
  assert.match(h.stdout, /^tapeapi-verify task \(experimental, 1\.7/)
  assert.doesNotMatch(h.stdout, /a local proxy that verifies/)
  assert.match(h.stdout, /enforcement: none/)
  assert.match(h.stdout, /Exit status: 0 the thread verifies/)
  const none = spawn(['task'])
  assert.equal(none.code, 2)
  assert.match(none.stderr, /name the thread file/)
  assert.equal(none.stdout, '')
})

test('exit 2 is a usage mistake and exit 1 a runtime failure, and no chain is read for either', async () => {
  const x = standardWorld()
  const f = file('a.json', happyThread().messages)
  for (const args of [['--bogus'], [f, '--bogus'], ['a.json', 'b.json'], [f, '--payment'], [f, '--payment', AG], [f, '--payment', 'nope', '1'], [f, '--payment', AG, 'x'], [f, '--payment', AG, '-1'], [f, '--rpc']]) {
    const r = await run(x, args)
    assert.equal(r.code, 2, JSON.stringify(args))
    assert.match(r.stderr, /tapeapi-verify task:/)
    assert.equal(r.stdout, '')
  }
  assert.equal((await run(x, [file('notjson.json', 'not json')])).code, 2)
  assert.equal((await run(x, [file('obj.json', { a: 1 })])).code, 2)
  assert.equal((await run(x, [file('empty.json', [])])).code, 2)
  assert.equal((await run(x, [file('nums.json', [1, 2])])).code, 2)
  const missing = await run(x, [join(TMP, 'missing.json')])
  assert.equal(missing.code, 1)
  assert.match(missing.stderr, /cannot read .*missing\.json: ENOENT/)
  // the binary: --rpc with fewer than two operators is refused before anything is read, as for the proxy
  assert.equal(spawn(['task', f, '--rpc', 'http://a.example,http://a.example']).code, 2)
  assert.equal(spawn(['task', join(TMP, 'missing.json')]).code, 1)
  // a chain that cannot be read is a failure, never a verdict
  const dead = await runTask([f], { api: standardWorld().api({ fetch: async () => { throw new Error('connect ECONNREFUSED') } }), clock: () => NOW, out: () => {}, err: () => {} })
  assert.equal(dead, 1)
})

test('a thread that verifies: state, ok, enforcement none, not a self-hire, both parties as container and on-chain name, the manifest name marked untrusted', async () => {
  const real = PROCESSORS_SNAPSHOT[56].list[7]
  const evil = 'Official TapeAPI Agent' + String.fromCharCode(0x202e) + 'tnega' + String.fromCharCode(0x200b)
  const x = standardWorld({ circuits: real, agentName: evil })
  const r = await run(x, [file('ok.json', happyThread().messages)])
  assert.equal(r.code, 0, r.stdout + r.stderr)
  assert.equal(r.stderr, '')
  assert.match(r.stdout, /^state: {7}Settled$/m)
  assert.match(r.stdout, /^result: {6}ok$/m)
  assert.match(r.stdout, /^enforcement: none \(phase 0/m)
  assert.match(r.stdout, /^self-hire: {3}no$/m)
  assert.match(r.stdout, new RegExp(`^principal: {3}${P} {2}name 11\\.7\\.tape {2}holder 0x[0-9a-fA-F]{40}$`, 'm'))
  assert.match(r.stdout, new RegExp(`^agent: {7}${AG} {2}name 12\\.7\\.tape {2}signer 0x[0-9a-fA-F]{40}$`, 'mi'))
  assert.match(r.stdout, /manifest name \(untrusted: the agent wrote it, it is not an identity\): "Official TapeAPI Agenttnega"/)
  assert.doesNotMatch(r.stdout, /[‮​]/)
  assert.match(r.stdout, /^revocation: {2}none$/m)
  assert.match(r.stdout, /^problems: {4}none$/m)
  assert.match(r.stdout, /does NOT prove: that the calls were needed; that the answers were right/)
  assert.doesNotMatch(r.stdout, /badge|verified by|certified/i)
  // without the processor on the chain's table the container is still shown, never the manifest name as a name
  const y = standardWorld({ agentName: 'Official TapeAPI Agent' })
  const r2 = await run(y, [file('ok2.json', happyThread().messages)])
  assert.match(r2.stdout, /name \(none on the chain's processor table\)/)
  assert.doesNotMatch(r2.stdout, /name Official/)
})

test('FIXED TV-02: a self-hire is printed as such (exit status still follows the thread: ok is 0)', async () => {
  const x = standardWorld({ agentHolderKey: KEYS.principalHolder })
  const r = await run(x, [file('self.json', happyThread().messages)])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /^self-hire: {3}YES \(same-holder\): reputation rules should leave this thread out$/m)
})

test('FIXED TV-03: a thread that does not verify exits 1 and says why, in order: forged signature, delivered after a revocation, cap above 0, out of order', async () => {
  const x = standardWorld()
  const t = happyThread()
  const forged = { ...t.mandate, sig: mandateMsg(mandateOf(), KEYS.stranger).sig }
  const a = await run(x, [file('forged.json', [t.offer, t.accept, forged, t.deliver])])
  assert.equal(a.code, 1)
  assert.match(a.stdout, /^result: {6}NOT ok$/m)
  assert.match(a.stdout, /- not-signed-by-holder: /)
  const c = happyThread({ m: mandateOf({ scope: [{ provider: S, token: '0x' + '00'.repeat(20), cap: '7' }] }) })
  const b = await run(x, [file('cap.json', c.messages)])
  assert.equal(b.code, 1)
  assert.match(b.stdout, /- phase0-no-funds: /)
  // a site revocation issued before the delivery: the delivery is refused (draft §7.5; mandate-revoked is not a thread
  // problem); one issued after the delivery and before the verdict leaves the thread Settled
  const y = standardWorld()
  revocationFile(y, { mandateHashes: [t.mandateHash], issued: t.deliver.receipt.ts - 30 })
  const d = await run(y, [file('revoked.json', t.messages)])
  assert.equal(d.code, 1)
  assert.match(d.stdout, /- message-after-revocation: /)
  assert.doesNotMatch(d.stdout, /mandate-revoked/)
  // the accept itself was signed after R: the second pass refuses it, so the mandate is never applied and the
  // thread ends Cancelled / accept 也签在 R 之后：第二遍拒收，授权书未应用，线程最后为 Cancelled
  assert.match(d.stdout, /^state: {7}Cancelled$/m)
  assert.match(d.stdout, /^revocation: {2}at \d+ \(site\); agent messages signed after it are refused$/m)
  const z = standardWorld()
  revocationFile(z, { mandateHashes: [t.mandateHash], issued: t.deliver.receipt.ts })
  const g = await run(z, [file('revoked-late.json', t.messages)])
  assert.equal(g.code, 0)
  assert.match(g.stdout, /^state: {7}Settled$/m)
  const e = await run(x, [file('order.json', [t.accept, t.offer])])
  assert.equal(e.code, 1)
  assert.match(e.stdout, /- out-of-order: /)
  // a revocation message in the thread is printed as the cancelled state
  const f = await run(standardWorld(), [file('cancel.json', [t.offer, t.accept, t.mandate, revocationMsg({ mandateHashes: [t.mandateHash] })])])
  assert.equal(f.code, 0)
  assert.match(f.stdout, /^state: {7}Cancelled$/m)
  assert.match(f.stdout, /^revocation: {2}at \d+ \(message\); agent messages signed after it are refused$/m)
})

// a payment for the thread: the transfer, then the message that attaches it
function paid(x, { from = P, to = AG, wallet = HP, amount = '1000', body, attachments, tb = MB - 10, mb = MB, thread = happyThread() } = {}) {
  const verdictHash = A.verdictHashOf(56, ADDR.hub, thread.acceptance.verdict)
  const tx = x.erc20Transfer({ payer: HP, to: AG, amount, block: tb })
  const list = attachments ?? [{ type: 'erc20', chainId: 56, token: TOKEN.toLowerCase(), amount, tx }]
  const sent = x.send({ from, wallet, to, content: A.encodeContent({ body: body ?? `payment for the verdict ${verdictHash}`, attachments: list }), block: mb })
  return { index: sent.index, thread, verdictHash }
}

test('--payment: the thread and its payment are both ok: exit 0, the §19 result per attachment, and whether the message names the verdict', async () => {
  const x = standardWorld()
  const { index, thread } = paid(x)
  const r = await run(x, [file('p.json', thread.messages), '--payment', AG, String(index)])
  assert.equal(r.code, 0, r.stdout + r.stderr)
  assert.match(r.stdout, new RegExp(`^payment: {5}message ${index} in the inbox of ${AG}: ok$`, 'm'))
  assert.match(r.stdout, /erc20 0x[0-9a-f]{40} 1000 in 0x[0-9a-f]{64}: ok/)
  assert.match(r.stdout, /the message body names the thread's verdictHash \(information only\)/)
  const x2 = standardWorld()
  const p2 = paid(x2, { body: 'thanks' })
  const r2 = await run(x2, [file('p2.json', p2.thread.messages), '--payment', AG, String(p2.index)])
  assert.equal(r2.code, 0)
  assert.match(r2.stdout, /does not name the thread's verdictHash \(information only\)/)
})

test('FIXED TV-04: --payment is not ok when the message is for someone else than the agent, from someone else than the principal, carries no attachment, or the §19 check says anything but ok', async () => {
  const OTHER = '0x' + 'c9'.repeat(20)
  const cases = [
    ['a message to the provider, not the agent', (x) => { const p = paid(x, { to: S }); return { ...p, recipient: S } }, /is not the thread's agent/],
    ['a message from another container', (x) => paid(x, { from: OTHER }), /not the thread's principal/],
    ['no asset attachment', (x) => paid(x, { attachments: [] }), /carries no asset attachment/],
    ['a transfer more than an hour older than the message', (x) => paid(x, { tb: MB - 3700 }), /: stale \(step 12\)/],
    ['an amount that is not the one transferred', (x) => paid(x, { attachments: [{ type: 'erc20', chainId: 56, token: TOKEN.toLowerCase(), amount: '999', tx: x.erc20Transfer({ payer: HP, to: AG, amount: '1000', block: MB - 10 }) }] }), /: mismatch \(step 6\)/],
  ]
  for (const [what, make, re] of cases) {
    const x = standardWorld()
    const p = make(x)
    const r = await run(x, [file('p.json', p.thread.messages), '--payment', p.recipient ?? AG, String(p.index)])
    assert.equal(r.code, 1, what)
    assert.match(r.stdout, /: NOT ok$/m, what)
    assert.match(r.stdout, re, what)
    assert.match(r.stdout, /^result: {6}ok$/m, `${what}: the thread itself is fine`)
  }
  // a thread that is not ok does not become ok because its payment is
  const x = standardWorld()
  const t = happyThread()
  const p = paid(x, { thread: t })
  const bad = file('bad.json', [t.offer, t.accept, { ...t.mandate, sig: mandateMsg(mandateOf(), KEYS.stranger).sig }, t.deliver])
  const r = await run(x, [bad, '--payment', AG, String(p.index)])
  assert.equal(r.code, 1)
  assert.match(r.stdout, /^payment: {5}message \d+ in the inbox of \S+: ok$/m)
  // a message that is not there / a sealed one cannot be read: not ok, not a crash
  const r2 = await run(standardWorld(), [file('p.json', t.messages), '--payment', AG, '5'])
  assert.equal(r2.code, 1)
})

test('FIXED TV-05: --payment is not ok when the agent is not a minted #ID (nobody could ever move what is sent to its address)', async () => {
  const x = standardWorld()
  const p = paid(x)
  x.chain.state.owners.delete('12')   // the agent's circuit has no holder: ownerOf reverts
  const r = await run(x, [file('unminted.json', p.thread.messages), '--payment', AG, String(p.index)])
  assert.equal(r.code, 1)
  assert.match(r.stdout, /^result: {6}NOT ok$/m)
  assert.match(r.stdout, /- agent-unresolvable: .*ownerOf/)
  assert.match(r.stdout, /not a minted TapeOut container/)
  assert.match(r.stdout, /^payment: {5}message \d+ in the inbox of \S+: NOT ok$/m)
})

test('the new thread problems are printed: an agent that does not resolve, a delivery signed before the accept', async () => {
  const t = happyThread()
  // the agent's manifest is gone from its site
  const x = standardWorld()
  x.chain.state.files.delete(`${AG.toLowerCase()}:.well-known/tapeapi.json`)
  const a = await run(x, [file('unres.json', t.messages)])
  assert.equal(a.code, 1)
  assert.match(a.stdout, /- agent-unresolvable: /)
  // a delivery whose signing time is before the accept's
  const y = standardWorld()
  const early = deliverMsg({ mandateHash: t.mandateHash, ts: nowS() - 30 })
  const accept = { ...t.accept }
  const b = await run(y, [file('early.json', [t.offer, accept, t.mandate, early])])
  assert.equal(b.code, 1)
  assert.match(b.stdout, /- deliver-before-accept: /)
})

test('the thread is judged at the injected clock, never the wall clock: a delivery nobody accepted is "unaccepted" only once its own exp has passed', async () => {
  const t = happyThread()
  const f = file('undecided.json', [t.offer, t.accept, t.mandate, t.deliver])
  const at = async (clock) => { let stdout = ''; const code = await runTask([f], { api: standardWorld().api(), clock, out: (x) => { stdout += x }, err: () => {} }); return { code, stdout } }
  const now = await at(() => NOW)
  assert.equal(now.code, 0)
  assert.doesNotMatch(now.stdout, /^unaccepted:/m)
  const later = await at(() => NOW + 2 * 3600)
  assert.match(later.stdout, /^unaccepted: {2}yes/m)
})
