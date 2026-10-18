// tapeapi-mcp (stdio) and MCP revision 2026-07-28: a request that declares the revision in `_meta` gets `resultType`
// (and, for tools/list, `ttlMs` 0 and `cacheScope` public); a request of an earlier revision gets what it got before,
// and the locally verified receipt is the same either way. Network-free: --dev reads the manifest from 127.0.0.1.
// tapeapi-mcp（stdio）与 MCP 2026-07-28 版：声明该版本的请求得到新字段；更早版本的请求得到与以前相同的回答；本地核验过的
// 回执两种情况下都相同。不联网：--dev 从 127.0.0.1 读清单。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { privateKeyToAddress } from '../src/sig.js'
import { RECEIPT_META_KEY, toolsDigest } from '../src/mcp.js'
import { createProvider } from '../../server/src/index.js'

const BIN = fileURLToPath(new URL('../bin/tapeapi-mcp.js', import.meta.url))
const KEY = '0x' + '5a'.repeat(32)
const META = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {}, 'io.modelcontextprotocol/clientInfo': { name: 't', version: '1' } }
const manifest = {
  tapeapi: '0.1', name: 'Local Test', circuits: '0x' + '7e'.repeat(20), tokenId: '9', container: '0x' + '7c'.repeat(20), signer: privateKeyToAddress(KEY),
  endpoints: { live: ['http://127.0.0.1:1/tapeapi/v1'], async: false }, dev: true,
  methods: [{ name: 'echo', priceBEM: '0', params: { text: 'string' }, returns: { echo: 'object' } }],
}
const provider = createProvider({ manifest, signerKey: KEY, dev: true, rateLimit: false, log: () => {}, methods: { echo: async (p) => ({ echo: p }) } })
let child
after(async () => { child?.kill(); await provider.close?.() })

test('tapeapi-mcp: the 2026-07-28 fields go to a request of that revision only; the receipt is the same', async () => {
  const srv = await provider.listen(0)
  const url = `http://127.0.0.1:${srv.address().port}`
  manifest.endpoints.live = [`${url}/tapeapi/v1`]
  child = spawn(process.execPath, [BIN, '--dev', url, '--no-pin'], { stdio: ['pipe', 'pipe', 'pipe'] })
  let out = '', err = '', seq = 0
  const waiters = new Map()
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
  child.stderr.on('data', (d) => { err += d })
  child.stdout.on('data', (d) => {
    out += d
    let i
    while ((i = out.indexOf('\n')) >= 0) {
      const line = out.slice(0, i); out = out.slice(i + 1)
      let msg; try { msg = JSON.parse(line) } catch { continue }
      const w = waiters.get(msg.id); if (w) { waiters.delete(msg.id); w(msg) }
    }
  })
  const request = (method, params) => {
    const id = ++seq
    const p = new Promise((ok, fail) => {
      const t = setTimeout(() => fail(new Error(`no reply to ${method} in 20 s; stderr:\n${err}`)), 20_000)
      waiters.set(id, (m) => { clearTimeout(t); ok(m) })
    })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }) + '\n')
    return p
  }
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
  const legacy = (await request('tools/list', {})).result
  const modern = (await request('tools/list', { _meta: META })).result
  assert.deepEqual(Object.keys(legacy), ['tools'])
  assert.deepEqual(modern, { ...legacy, resultType: 'complete', ttlMs: 0, cacheScope: 'public' })
  assert.equal(toolsDigest(modern.tools), toolsDigest(legacy.tools))
  const name = legacy.tools[0].name
  const cl = (await request('tools/call', { name, arguments: { text: 'hi' } })).result
  const cm = (await request('tools/call', { name, arguments: { text: 'hi' }, _meta: META })).result
  assert.equal(cm.resultType, 'complete'); assert.equal('resultType' in cl, false)
  assert.equal(cl.isError, false, cl.content?.map((c) => c.text).join('\n'))
  const strip = ({ id, ts, sig, ...rest }) => rest
  assert.deepEqual(strip(cm._meta[RECEIPT_META_KEY]), strip(cl._meta[RECEIPT_META_KEY]))
  assert.deepEqual(cm._meta[RECEIPT_META_KEY].params, { text: 'hi' })
  child.stdin.end()
})
