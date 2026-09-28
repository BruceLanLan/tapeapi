// The sidecar's session-header switch: the clients' session headers (x-claude-code-session-id, session-id, thread-id)
// reach the upstream by default, as before; forwardSessionHeaders: false (FORWARD_SESSION_HEADERS=0 in the Worker and
// the new-api sidecar) leaves them out and nothing else. No network.
// 旁路的会话头开关：客户端的会话头默认照旧转发给上游；forwardSessionHeaders: false 只去掉它们。不联网。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAIProxy } from '../src/ai-proxy.js'
import { ai } from '@tapeapi/sdk'
import { build } from '../../examples/ai-proxy/worker.js'
import { readConfig, buildProxy } from '../../examples/new-api-sidecar/server.mjs'
import { throwawayIdentity, EXAMPLE_MODELS } from '../../examples/new-api-sidecar/smoke.mjs'

const KEY = '0x' + '42'.repeat(32)
const CIRCUITS = '0xe02c26c7432A7121168AA9B610DE24eCf9a1a414', CONTAINER = '0x1b2A657BcBa9D3229f57aC2f4FcbEE2AA756aAe8'
const BASE = 'https://ai.example'
const MODELS = [{ id: 'demo-chat', prices: [{ currency: 'USDT', unit: '1M tokens', input: '1', output: '2' }] }]
const CLIENT = {
  'content-type': 'application/json', authorization: 'Bearer sk-caller', 'user-agent': 'claude-cli/2.1', 'x-app': 'cli',
  'x-claude-code-session-id': 'cc-session-1', 'session-id': 's-1', 'thread-id': 't-1', originator: 'codex_exec', 'x-stainless-lang': 'js',
}
function upstream() {
  const seen = []
  const fetch = async (url, init) => { seen.push(Object.fromEntries(new Headers(init.headers))); return new Response('{"id":"chatcmpl-B9MHDbslfkBeAs8l4bebGdFOJ6PeG","model":"demo-chat"}', { headers: { 'content-type': 'application/json' } }) }
  return { fetch, seen }
}
const make = (fetch, extra = {}) => createAIProxy({ upstream: { baseUrl: 'https://up.example/v1' }, manifestBase: { name: 'AI', circuits: CIRCUITS, tokenId: '11', container: CONTAINER, delegation: null, endpoints: { live: [`${BASE}/tapeapi/v1`], async: false } }, signerKey: KEY, models: MODELS, fetch, log: () => {}, ...extra })
const call = (p) => p.handleRequest(new Request(`${BASE}/v1/chat/completions`, { method: 'POST', headers: CLIENT, body: '{"model":"demo-chat","messages":[]}' }), { clientIp: '1.1.1.1' })

test('by default the session headers reach the upstream, as before', async () => {
  const up = upstream()
  const p = make(up.fetch)
  await (await call(p)).text()
  for (const h of ai.SESSION_HEADERS) assert.equal(up.seen[0][h], CLIENT[h], h)
  assert.equal(p.stats().forwardSessionHeaders, true)
  assert.deepEqual([...ai.SESSION_HEADERS], ['x-claude-code-session-id', 'session-id', 'thread-id'])
})

test('forwardSessionHeaders: false leaves out exactly the session headers; the receipt is unaffected', async () => {
  const up = upstream()
  const p = make(up.fetch, { forwardSessionHeaders: false })
  const res = await call(p)
  await res.text()
  for (const h of ai.SESSION_HEADERS) assert.equal(up.seen[0][h], undefined, h)
  for (const h of ['authorization', 'user-agent', 'x-app', 'originator', 'x-stainless-lang', 'content-type']) assert.equal(up.seen[0][h], CLIENT[h], h)
  assert.ok(ai.decodeReceiptHeader(res.headers.get(ai.RECEIPT_HEADER)).sig)
  assert.equal(p.stats().forwardSessionHeaders, false)
  assert.throws(() => make(up.fetch, { forwardSessionHeaders: 'no' }), /forwardSessionHeaders/)
  // The CORS preflight still allows them: browsers may send them either way. / 预检仍允许它们：浏览器可能照样发送。
  const pre = await p.handleRequest(new Request(`${BASE}/v1/chat/completions`, { method: 'OPTIONS', headers: { 'access-control-request-headers': 'x-claude-code-session-id' } }))
  assert.match(pre.headers.get('access-control-allow-headers'), /x-claude-code-session-id/)
})

test('FORWARD_SESSION_HEADERS=0 in the Worker and in the new-api sidecar; unset keeps them', async () => {
  const env = {
    SIGNER_KEY: KEY, UPSTREAM_BASE_URL: 'https://up.example/v1', MODELS_JSON: JSON.stringify(MODELS), CIRCUITS, TOKEN_ID: '11', CONTAINER,
    DELEGATION_EXPIRES: '1900000000', DELEGATION_SIG: '0x' + '11'.repeat(65), PUBLIC_URL: BASE,
  }
  const up = upstream()
  const w = build({ ...env, FORWARD_SESSION_HEADERS: '0' }, { fetch: up.fetch, log: () => {} })
  await (await call(w)).text()
  assert.equal(up.seen[0]['session-id'], undefined)
  assert.equal(build(env, { log: () => {} }).stats().forwardSessionHeaders, true)
  const complete = { ...throwawayIdentity(), PUBLIC_URL: 'https://api.example.com', MODELS_FILE: EXAMPLE_MODELS }
  const c = readConfig({ ...complete, FORWARD_SESSION_HEADERS: '0' })
  assert.equal(c.ok, true, c.problem); assert.equal(c.config.forwardSessionHeaders, false)
  assert.equal(buildProxy(c.config, { log: () => {} }).stats().forwardSessionHeaders, false)
  assert.equal(readConfig(complete).config.forwardSessionHeaders, true)
  assert.match(readConfig({ ...complete, FORWARD_SESSION_HEADERS: 'no' }).problem, /FORWARD_SESSION_HEADERS/)
})

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
// Private files only: the public copy has none of them, so the check is skipped there.
// 仅限私有文件：公开副本里没有，这里跳过。
test('shelved private code is marked at its top (2026-09-28)', { skip: !existsSync(join(ROOT, 'hosting')) }, () => {
  const files = ['hosting', 'hosting/app'].flatMap((d) => readdirSync(join(ROOT, d)).filter((n) => /\.(mjs|js|sql|toml|md|html)$/.test(n) && !n.endsWith('.test.mjs')).map((n) => `${d}/${n}`))
  assert.ok(files.length >= 18, files.join(', '))
  for (const f of [...files, 'docs/DESIGN-hosted.md']) {
    const head = readFileSync(join(ROOT, f), 'utf8').split('\n').slice(0, 5).join('\n')
    assert.match(head, /搁置（2026-09-28）/, f)
    assert.match(head, /SHELVED \(2026-09-28\)/, f)
  }
  assert.ok(readFileSync(join(ROOT, 'hosting/app/index.html'), 'utf8').startsWith('<!doctype html>\n'), 'the doctype stays first')
})
