// reconcile <-> new-api, end to end on 127.0.0.1 with the FAKE new-api: its /api/pricing converted to the price table,
// the sidecar (FORMATS=openai-chat) in front of it, tapeapi-verify --log in front of the sidecar, four calls, then the
// mock's GET /api/log/self pulled as a buyer would and `tapeapi reconcile --preset new-api --amount-scale
// <quota_per_unit>` run on the two files through the real binary. Covered: every row matched by upstream_request_id
// (exit 0, amounts compared), then a row without that id (joined by time, model and tokens), a row that differs, a
// receipt with no row, a row with no receipt (a call that went to new-api directly, not through the sidecar), and the
// same rows from GET /api/log/token (a bare data array). Nothing here touches a real new-api: the field names are the
// preset's, read in new-api's source, not checked against an instance.
// reconcile 与 new-api 的端到端（只用回环地址与模拟 new-api）：价目转换 -> 旁路 -> tapeapi-verify --log -> 四次调用 -> 像买家那样
// 拉取 GET /api/log/self -> 用真实二进制跑 tapeapi reconcile --preset new-api --amount-scale <quota_per_unit>。覆盖：全部按
// upstream_request_id 对上（退出 0，比较金额）、缺 id 的行按时间 / 模型 / token 数对上、一行不一致、一张回执没有行、一行没有回执
// （绕过旁路直接打到 new-api 的调用），以及 GET /api/log/token 给出的同样的行。不碰真实 new-api：字段名是预设的，取自源码，未用实例核对。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sig, MAINNET } from '@tapeapi/sdk'
import { createConformChain } from '../../sdk/test/helpers/conform-chain.mjs'
import { DEMO_KEY } from '../ai-proxy/fake-upstream.mjs'
import { runReconcile } from '../../sdk/src/reconcile-cli.js'
import { startSidecar } from './server.mjs'
import { startFakeNewApi, USER_TOKEN, DEFAULT_QUOTA_PER_UNIT, usageOfAnswer, quotaOf } from './fake-new-api.mjs'

const here = (p) => fileURLToPath(new URL(p, import.meta.url))
const TAPEAPI_BIN = here('../../sdk/bin/tapeapi.js')
const VERIFY_BIN = here('../../sdk/bin/tapeapi-verify.js')
const CONVERT = here('pricing-convert.mjs')
const MODEL_A = 'vendor-a-chat-3.2', MODEL_C = 'vendor-c/model-c-3', MODEL_D = 'Model-D-5.3'

let dir, upstream, sidecar, receiptsLog, verifyUrl, quotaPerUnit, selfExport, tokenExport
const closers = []
const headers = { authorization: `Bearer ${DEMO_KEY}`, 'content-type': 'application/json' }
const save = (name, text) => { const p = join(dir, name); writeFileSync(p, text); return p }
const pull = async (path, token) => { const r = await fetch(upstream.url + path, { headers: token ? { authorization: `Bearer ${token}` } : {} }); return { status: r.status, text: await r.text() } }
/** The real binary: node sdk/bin/tapeapi.js reconcile ... in `dir`. / 真实二进制。 */
const reconcileBin = (args) => { const p = spawnSync(process.execPath, [TAPEAPI_BIN, 'reconcile', ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' }, timeout: 300_000, killSignal: 'SIGKILL' }); return { code: p.status, out: p.stdout, err: p.stderr } }
/** In process (the file functions passed as sdk/bin/tapeapi.js passes them), no network. / 进程内（文件函数照 tapeapi.js 传入），不联网。 */
const HOST = { readFileSync, readdirSync, statSync, writeFileSync, join, dirname, relative, isAbsolute }
async function reconcileIn(args) {
  let out = '', err = ''
  const { exitCode } = await runReconcile(args, { host: HOST, cmd: 'tapeapi', version: '0.0.0-test', env: {}, cwd: dir, stdout: (s) => { out += s }, stderr: (s) => { err += s }, isTTY: false })
  return { code: exitCode, out, err }
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tapeapi-reconcile-newapi-'))
  // 1. The fake new-api, its price list converted as an operator does. / 模拟 new-api，价目像运营者那样转换。
  upstream = await startFakeNewApi()
  closers.push(() => upstream.close())
  const pricing = save('pricing.json', (await pull('/api/pricing')).text), status = save('status.json', (await pull('/api/status')).text)
  quotaPerUnit = JSON.parse(readFileSync(status, 'utf8')).data.quota_per_unit
  assert.equal(quotaPerUnit, DEFAULT_QUOTA_PER_UNIT)
  const modelsFile = join(dir, 'models.json')
  const conv = spawnSync(process.execPath, [CONVERT, pricing, '--status', status, '--usd-exchange-rate', '7', '--out', modelsFile], { encoding: 'utf8', timeout: 300_000, killSignal: 'SIGKILL' })
  assert.equal(conv.status, 0, conv.stderr)
  // 2. The sidecar, openai-chat only, with a fake identity (the chain is never read: tapeapi-verify runs in --dev).
  // 旁路，只开 openai-chat，假身份（不读链：tapeapi-verify 以 --dev 运行）。
  const holderKey = sig.randomPrivateKey(), signerKey = sig.randomPrivateKey()
  const expires = Math.floor(Date.now() / 1000) + 90 * 86_400
  const c = createConformChain().circuit(42, { holder: sig.privateKeyToAddress(holderKey) })
  const delegationSig = sig.signDigest(sig.delegationDigest(56, MAINNET.hub, { container: c.container, signer: sig.privateKeyToAddress(signerKey), expires }), holderKey)
  sidecar = await startSidecar({
    env: { UPSTREAM_BASE_URL: upstream.baseUrl, MODELS_FILE: modelsFile, FORMATS: 'openai-chat', SERVICE_NAME: 'Reconcile test relay', CIRCUITS: c.circuits, TOKEN_ID: '42', CONTAINER: c.container, DELEGATION_EXPIRES: String(expires), DELEGATION_SIG: delegationSig, SIGNER_KEY: signerKey },
    port: 0, host: '127.0.0.1', quiet: true, localPublicUrl: true, log: () => {},
  })
  closers.push(() => sidecar.close())
  assert.ok(sidecar.state.ok, JSON.stringify(sidecar.state))
  // 3. tapeapi-verify --log in front of it, four calls through it (two models, one streamed). / tapeapi-verify --log 在前，四次调用。
  receiptsLog = join(dir, 'receipts.jsonl')
  const child = spawn(process.execPath, [VERIFY_BIN, '--dev', sidecar.url, '--port', '0', '--log', receiptsLog], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 300_000, killSignal: 'SIGKILL' })
  closers.push(() => new Promise((r) => { if (child.exitCode !== null || child.signalCode !== null) return r(); child.once('exit', r); child.kill('SIGKILL') }))
  let text = ''
  child.stderr.setEncoding('utf8')
  verifyUrl = await new Promise((ok, no) => {
    const t = setTimeout(() => no(new Error(`tapeapi-verify did not start:\n${text}`)), 20_000)
    child.stderr.on('data', (d) => { text += d; const m = /listening on (http:\/\/\S+)/.exec(text); if (m) { clearTimeout(t); ok(m[1]) } })
    child.once('exit', (code) => { clearTimeout(t); no(new Error(`tapeapi-verify exited ${code}:\n${text}`)) })
  })
  const call = async (body) => { const r = await fetch(`${verifyUrl}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) }); await r.arrayBuffer(); assert.equal(r.status, 200) }
  await call({ model: MODEL_A, messages: [{ role: 'user', content: 'Hello from the reconcile test' }] })
  await call({ model: MODEL_A, stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'Stream this one please, a few more words' }] })
  await call({ model: MODEL_C, messages: [{ role: 'user', content: 'one two three four five' }] })
  await call({ model: MODEL_D, messages: [{ role: 'user', content: 'the fourth call, through the sidecar' }] })
  // Every verdict written before the log is read. / 读日志前，每条结论都已写下。
  for (let i = 0; i < 500 && (text.match(/\] OK/g) || []).length < 4; i++) await new Promise((r) => setTimeout(r, 10))
  await new Promise((r) => { child.once('exit', r); child.kill('SIGTERM') })
  // 4. The buyer's export, as a file: the mock's GET /api/log/self (dashboard credential) and GET /api/log/token (the
  // relay key). / 买家的导出文件：GET /api/log/self（用户级凭据）与 GET /api/log/token（转发密钥）。
  selfExport = save('log-self.json', (await pull('/api/log/self?p=1&page_size=100&type=2', USER_TOKEN)).text)
  tokenExport = save('log-token.json', (await pull('/api/log/token', DEMO_KEY)).text)
})

after(async () => {
  for (const c of closers.reverse()) await c()
  rmSync(dir, { recursive: true, force: true })
})

test('fake new-api: the log has the preset fields, one row per answered call, quota from its own ratios; the credentials', async () => {
  const lines = readFileSync(receiptsLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(lines.length, 4); assert.ok(lines.every((l) => l.ok === true && l.receipt), 'tapeapi-verify verified all four')
  const self = JSON.parse(readFileSync(selfExport, 'utf8'))
  assert.equal(self.success, true); assert.deepEqual(Object.keys(self.data).sort(), ['items', 'page', 'page_size', 'total']); assert.equal(self.data.total, 4)
  const items = self.data.items
  for (const key of ['upstream_request_id', 'model_name', 'prompt_tokens', 'completion_tokens', 'quota', 'created_at']) assert.ok(items.every((r) => r[key] !== undefined), key)
  // newest first; the same answers the receipts carry, same tokens / 最新在前；与回执相同的回答与 token 数
  const byId = new Map(items.map((r) => [r.upstream_request_id, r]))
  for (const l of lines) {
    const row = byId.get(l.receipt.id)
    assert.ok(row, `a row for ${l.receipt.id}`)
    assert.equal(row.model_name, l.receipt.result.model); assert.equal(row.prompt_tokens, l.receipt.result.usage.prompt_tokens); assert.equal(row.completion_tokens, l.receipt.result.usage.completion_tokens)
    assert.ok(Number.isInteger(row.quota) && row.quota >= 1 && Number.isInteger(row.created_at) && row.type === 2)
    // The receipt's USD, in quota: within one quota of the integer the mock billed. / 回执的美元折成额度，与账单整数相差不到 1。
    assert.ok(Math.abs(Number(l.receipt.result.prices[0].amount) * quotaPerUnit - row.quota) < 1, `${l.receipt.result.prices[0].amount} USD vs quota ${row.quota}`)
  }
  assert.equal(items.filter((r) => r.is_stream).length, 1)
  const token = JSON.parse(readFileSync(tokenExport, 'utf8'))
  assert.ok(Array.isArray(token.data)); assert.deepEqual(token.data.map((r) => r.id), items.map((r) => r.id))
  // A relay key is refused on the user route and the other way round; no credential is 401. / 凭据用错即 401。
  assert.equal((await pull('/api/log/self', DEMO_KEY)).status, 401); assert.equal((await pull('/api/log/self')).status, 401)
  assert.equal((await pull('/api/log/token', USER_TOKEN)).status, 401)
  // Paging and the time filter. / 翻页与时间过滤。
  const p2 = JSON.parse((await pull('/api/log/self?p=2&page_size=3', USER_TOKEN)).text).data
  assert.equal(p2.items.length, 1); assert.equal(p2.page, 2); assert.equal(p2.total, 4)
  assert.equal(JSON.parse((await pull(`/api/log/self?end_timestamp=${items[3].created_at - 1}`, USER_TOKEN)).text).data.total, 0)
  // The helpers on their own. / 两个辅助函数。
  assert.deepEqual(usageOfAnswer(Buffer.from('data: {"id":"x","model":"m","choices":[]}\n\ndata: {"id":"x","model":"m","choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\ndata: [DONE]\n\n'), 'text/event-stream'), { id: 'x', model: 'm', prompt: 3, completion: 2 })
  assert.equal(usageOfAnswer(Buffer.from('{"id":"y","choices":[]}'), 'application/json'), null)
  assert.deepEqual(quotaOf({ data: [{ model_name: 'm', model_ratio: 2, completion_ratio: 4, enable_groups: ['g'] }], group_ratio: { g: 1.5 } }, 'm', 10, 5), { quota: 90, model_ratio: 2, completion_ratio: 4, group_ratio: 1.5 })
  assert.equal(quotaOf({ data: [{ model_name: 'm', model_ratio: 0.001 }] }, 'm', 1, 0).quota, 1, 'at least 1 when the ratio is not 0')
  assert.equal(quotaOf({ data: [] }, 'unknown', 1, 1).quota, 0)
})

test('reconcile --preset new-api --amount-scale <quota_per_unit> on the pulled export: every row matched by upstream_request_id, amounts compared, exit 0 (real binary)', async () => {
  const r = reconcileBin(['--receipts', 'receipts.jsonl', '--bill', 'log-self.json', '--preset', 'new-api', '--amount-scale', String(quotaPerUnit), '--json', '--lang', 'en'])
  assert.equal(r.code, 0, r.out + r.err)
  const j = JSON.parse(r.out)
  assert.equal(j.ok, true); assert.deepEqual(j.counts, { match: 4, missing: { receiptsOnly: 0, billOnly: 0 }, mismatch: 0 })
  assert.equal(j.bill.kind, 'JSON'); assert.equal(j.bill.rows, 4); assert.equal(j.bill.preset, 'new-api'); assert.equal(j.bill.presetUnverified, true); assert.deepEqual(j.bill.droppedPresetColumns, [])
  assert.equal(j.amounts.compared, true)
  assert.deepEqual(j.items.map((x) => x.basis), ['id', 'id', 'id', 'id'])
  assert.ok(j.items.every((x) => x.amount && x.amount.bill !== null && x.differences.length === 0), JSON.stringify(j.items[0]))
  // The text output says what the preset is and is not. / 文本输出说明预设是什么、不是什么。
  const t = reconcileBin(['--receipts', 'receipts.jsonl', '--bill', 'log-self.json', '--preset', 'new-api', '--amount-scale', String(quotaPerUnit), '--lang', 'en'])
  assert.equal(t.code, 0, t.out + t.err)
  assert.match(t.out, /MATCH +4/); assert.match(t.out, /new-api preset/); assert.match(t.out, /not yet checked against a real instance/); assert.match(t.out, /web CSV export is not that file/)
  // The same rows from GET /api/log/token (a bare data array) and without --preset (found in the header). / /api/log/token 的同样的行；不写 --preset 也能认出。
  const k = await reconcileIn(['--receipts', 'receipts.jsonl', '--bill', 'log-token.json', '--amount-scale', String(quotaPerUnit), '--json', '--lang', 'en'])
  assert.equal(k.code, 0, k.out + k.err)
  const kj = JSON.parse(k.out)
  assert.deepEqual(kj.counts, { match: 4, missing: { receiptsOnly: 0, billOnly: 0 }, mismatch: 0 }); assert.equal(kj.bill.preset, 'new-api'); assert.equal(kj.bill.presetDetected, true)
})

test('reconcile: a row without upstream_request_id is joined by time, model and tokens; a differing row, a receipt with no row and a call that bypassed the sidecar are each listed with their lines; exit 1', async () => {
  // A fifth call straight to new-api, not through the sidecar: new-api bills it, no receipt exists. / 第五次调用绕过旁路：有账单行，没有回执。
  const direct = await fetch(`${upstream.baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: MODEL_C, messages: [{ role: 'user', content: 'straight to new-api, no sidecar' }] }) })
  assert.equal(direct.status, 200); await direct.arrayBuffer()
  const exported = JSON.parse((await pull('/api/log/self?p=1&page_size=100', USER_TOKEN)).text)
  assert.equal(exported.data.total, 5)
  const items = exported.data.items   // newest first: [direct, D, C, A-stream, A] / 最新在前
  const receipts = readFileSync(receiptsLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l).receipt)
  const rowOf = (receipt) => items.find((r) => r.upstream_request_id === receipt.id)
  const streamed = rowOf(receipts[1]), modelC = rowOf(receipts[2]), modelD = rowOf(receipts[3])
  streamed.upstream_request_id = ''                                   // no id: time, model and tokens / 没有 id
  modelC.completion_tokens += 3; modelC.quota += 7                    // differs from the receipt / 与回执不一致
  exported.data.items = items.filter((r) => r !== modelD)             // the fourth receipt has no row / 第四张回执没有行
  exported.data.total = 4
  save('log-self-edited.json', JSON.stringify(exported))
  const r = reconcileBin(['--receipts', 'receipts.jsonl', '--bill', 'log-self-edited.json', '--preset', 'new-api', '--amount-scale', String(quotaPerUnit), '--json', '--lang', 'en'])
  assert.equal(r.code, 1, r.out + r.err)
  const j = JSON.parse(r.out)
  assert.deepEqual(j.counts, { match: 2, missing: { receiptsOnly: 1, billOnly: 1 }, mismatch: 1 })
  const joined = j.items.filter((x) => x.basis).map((x) => [x.class, x.basis, x.receipt.source, x.bill.source])
  const idx = (row) => `log-self-edited.json:[${exported.data.items.indexOf(row)}]`
  assert.deepEqual(joined, [
    ['mismatch', 'id', 'receipts.jsonl:3', idx(modelC)],
    ['match', 'id', 'receipts.jsonl:1', idx(rowOf(receipts[0]))],
    ['match', 'time-model-tokens', 'receipts.jsonl:2', idx(streamed)],
  ])
  const mm = j.items.find((x) => x.class === 'mismatch')
  assert.deepEqual(mm.differences.map((d) => d.field), ['completion_tokens', 'amount'])
  assert.equal(mm.differences[0].receipt, receipts[2].result.usage.completion_tokens); assert.equal(mm.differences[0].bill, receipts[2].result.usage.completion_tokens + 3)
  const only = j.items.filter((x) => x.class === 'missing')
  assert.deepEqual(only.map((x) => x.side), ['receipts-only', 'bill-only'])
  assert.equal(only[0].receipt.source, 'receipts.jsonl:4'); assert.equal(only[0].receipt.id, receipts[3].id)
  assert.equal(only[1].bill.source, 'log-self-edited.json:[0]'); assert.equal(only[1].bill.model, MODEL_C)
  assert.ok(/decides nothing/.test(j.notes.facts))
  // The text output names both lines of each fact. / 文本输出给出每条事实的两边出处。
  const t = reconcileBin(['--receipts', 'receipts.jsonl', '--bill', 'log-self-edited.json', '--preset', 'new-api', '--amount-scale', String(quotaPerUnit), '--lang', 'en'])
  assert.equal(t.code, 1)
  assert.match(t.out, /MISMATCH +1/); assert.ok(t.out.includes(`receipt receipts.jsonl:3`) && t.out.includes(`bill ${idx(modelC)}`), t.out)
  assert.ok(t.out.includes('receipts.jsonl:4') && t.out.includes(receipts[3].id), 'the receipt with no row, by its line')
  assert.ok(t.out.includes('log-self-edited.json:[0]'), 'the row with no receipt, by its index')
})

test('reconcile: the web CSV export is another file: the preset does not match its headers (exit 2, the header shown)', async () => {
  // The headers of new-api's web export are display titles (localized), not the JSON field names. / 网页导出的表头是显示标题。
  save('web-export.csv', 'Time,Model,Input Tokens,Output Tokens,Cost,request_id\n2026-10-21 10:00:00,vendor-a-chat-3.2,10,5,$0.000003,2026102100001\n')
  const r = await reconcileIn(['--receipts', 'receipts.jsonl', '--bill', 'web-export.csv', '--preset', 'new-api', '--lang', 'en'])
  assert.equal(r.code, 2, r.out + r.err)
  assert.match(r.err, /the bill has no column model=model_name, prompt=prompt_tokens, completion=completion_tokens, time=created_at/)
  assert.match(r.err, /its header: Time, Model, Input Tokens, Output Tokens, Cost, request_id/)
})
