// Byte equality with release/2.4.0 for MCP clients of revisions 2025-11-25, 2025-06-18 and 2025-03-26. The fixture
// server/test/fixtures/mcp-legacy-2.4.0.json holds what the 2.4.0 tree (218901a8) answered, recorded with
// helpers/record-mcp-legacy.mjs; every exchange is replayed here against this tree and must match exactly: the HTTP
// status, every response header, and the body text byte for byte (signed envelopes, receipts and verify links included,
// time frozen). Entry points: createMcpServer (the core tapeapi-mcp runs on), createMcpEndpoint (plain and mcpResults),
// createMcpProxy, and the public Worker's /mcp and /mcp/pinned. No network: the Worker reads a fake chain on 127.0.0.1.
// 与 release/2.4.0 的逐字节一致：2025-11-25 / 2025-06-18 / 2025-03-26 版本的 MCP 客户端。夹具保存 2.4.0 代码树的回答；这里对
// 本代码树逐一回放，HTTP 状态、每个响应头、正文文本都必须完全相同（含签名信封、回执与核验链接，时间冻结）。不联网。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mcp, sig, MAINNET, TapeAPIError } from '@tapeapi/sdk'
import { createProvider, VERSION } from '../src/index.js'
import { createMcpEndpoint } from '../src/mcp.js'
import { createMcpProxy } from '../src/mcp-proxy.js'
import worker from '../../examples/public-api/worker.js'
import { buildTargets, runAll, FROZEN_MS } from './helpers/mcp-legacy-cases.mjs'

const asRecorded = (body) => (VERSION === '2.4.0' ? body : body.replace(/("serverInfo":\{"name":"[^"]*","title":"[^"]*","version":")([^"]*)(")/g, (m, a, v, b) => (v === VERSION ? `${a}2.4.0${b}` : m)))
const fixture = JSON.parse(readFileSync(new URL('./fixtures/mcp-legacy-2.4.0.json', import.meta.url), 'utf8'))

test('the fixture is the 2.4.0 recording: 290 exchanges over six entry points, time frozen as here', () => {
  assert.equal(fixture.recordedFrom, 'release/2.4.0 218901a8')
  assert.equal(fixture.serverVersion, '2.4.0')
  assert.equal(fixture.frozenMs, FROZEN_MS)
  assert.equal(fixture.exchanges.length, 290)
  assert.deepEqual([...new Set(fixture.exchanges.map((e) => e.target))], ['createMcpServer', 'createMcpEndpoint', 'createMcpEndpoint mcpResults', 'createMcpProxy', 'public Worker /mcp', 'public Worker /mcp/pinned'])
})

// CHANGED MR-2b: one HTTP case, on each of the five HTTP entry points, is answered differently on
// purpose. "POST ping with MCP-Protocol-Version 2026-07-28 but no _meta" is not a request of an earlier revision (none
// sends that header value): it is a 2026-07-28 request missing its required _meta field, now 400 with -32602 (basic/index
// "Per-request protocol fields"). The fixture keeps what 2.4.0 answered; here each such exchange must be that refusal,
// with the response headers 2.4.0 sent, and every other exchange must still match byte for byte.
// CHANGED MR-2b：有一个 HTTP 用例（在五个 HTTP 入口上各一次）有意改变：它不是旧版请求，而是缺必填 _meta 的新版请求，现为 400 -32602。
// 夹具保留 2.4.0 的回答；这里要求这些交换正是该拒绝、响应头与 2.4.0 相同，其余每次交换仍逐字节相同。
const CHANGED = new Map([['POST ping with MCP-Protocol-Version 2026-07-28 but no _meta', (e, was) => {
  assert.equal(was.status, 200)
  assert.equal(e.status, 400)
  assert.deepEqual(e.headers, was.headers, 'the same response headers')
  const b = JSON.parse(e.body)
  assert.deepEqual(Object.keys(b), ['jsonrpc', 'id', 'error']); assert.equal(b.id, 1); assert.equal(b.error.code, -32602)
}]])

test('every legacy exchange is answered byte for byte as release/2.4.0 answered it', async () => {
  const { targets, close } = await buildTargets({ mcp, sig, MAINNET, TapeAPIError, createProvider, createMcpEndpoint, createMcpProxy, worker })
  let now
  try { now = await runAll(targets) } finally { await close() }
  assert.equal(now.length, fixture.exchanges.length, 'the same exchanges')
  const differ = []
  let changed = 0, compared = 0
  now.forEach((e0, i) => {
    let e = e0
    const was = fixture.exchanges[i]
    assert.equal(`${e.target} / ${e.case}`, `${was.target} / ${was.case}`)
    // The proxy and the Worker put @tapeapi/server's VERSION in serverInfo.version (initialize). That one field may
    // differ after a version bump; it is mapped back to 2.4.0 there and nowhere else, so every other byte still counts.
    // 代理与 Worker 把 @tapeapi/server 的 VERSION 放进 serverInfo.version；只有这一处在版本号变化后可能不同，只在这里换回 2.4.0。
    if (e.body !== undefined) e = { ...e, body: asRecorded(e.body) }
    if (CHANGED.has(e.case)) { CHANGED.get(e.case)(e, was); changed++; return }
    compared++
    if (JSON.stringify(e) !== JSON.stringify(was)) differ.push(`${e.target} / ${e.case}`)
  })
  assert.deepEqual(differ, [], 'exchanges that changed since 2.4.0')
  assert.equal(changed, 5, 'the CHANGED case on each of the five HTTP entry points')
  assert.equal(compared, 285, 'every other exchange compared byte for byte')
})

test('the fixture covers signed answers: receipts recover to the signer and verify links are present', () => {
  const signed = fixture.exchanges.filter((e) => /"fun\.tapeapi\/receipt"/.test(e.body || e.answer || ''))
  assert.ok(signed.length >= 10, `${signed.length} signed answers`)
  for (const e of signed.filter((x) => x.body && x.status === 200)) {
    const msg = JSON.parse(e.body)
    for (const m of Array.isArray(msg) ? msg : [msg]) {
      const r = m.result?._meta?.[mcp.RECEIPT_META_KEY]
      if (!r || r.v !== 1) continue
      const who = sig.recoverResponseSigner({ container: r.service.container, id: r.id, method: r.method, params: r.params, ok: r.ok, body: r.ok ? r.result : r.error, ts: r.ts }, r.sig)
      assert.ok([sig.privateKeyToAddress('0x' + '42'.repeat(32)), sig.privateKeyToAddress('0x' + '22'.repeat(32))].includes(who), `${e.target} / ${e.case}: ${who}`)
      assert.ok(m.result.content.some((c) => /tapeapi\.fun\/verify\/#r=/.test(c.text || '')), 'verify link')
    }
  }
})
