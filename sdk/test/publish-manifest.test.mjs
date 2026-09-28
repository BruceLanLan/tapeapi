// api.tx.publishManifest: builds the SiteRegistry writes a provider signs to put its manifest on-chain (TapeKit B.5).
// 构造提供者把清单写上链所需的 SiteRegistry 交易。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createTapeAPI, MANIFEST_KEY, MANIFEST_LIMIT, TapeAPIError } from '../src/index.js'
import { decodeCall, selector } from '../src/abi.js'
import { ADDR } from './helpers/fake-chain.mjs'

const SIGNER = '0x' + '11'.repeat(20)
const base = () => ({
  tapeapi: '0.1', name: 'Publish Test', circuits: ADDR.circuits, tokenId: '4246', container: ADDR.container, signer: SIGNER,
  delegation: { expires: Math.floor(Date.now() / 1000) + 86400 * 30, sig: '0x' + '22'.repeat(64) + '1b' },
  endpoints: { live: ['https://api.example.com/tapeapi/v1'], async: false },
  methods: [{ name: 'ping', priceBEM: '0', params: {}, returns: { ok: 'boolean' } }],
})
const api = createTapeAPI({ siteRegistry: ADDR.siteRegistry })
const sha = (b) => '0x' + createHash('sha256').update(b).digest('hex')

test('small manifest -> one putFile at the bare key with the right hash and bytes', () => {
  const m = base()
  const r = api.tx.publishManifest({ container: ADDR.container, manifest: m })
  assert.equal(r.txs.length, 1)
  assert.equal(r.key, MANIFEST_KEY)
  assert.equal(r.txs[0].to, ADDR.siteRegistry)
  assert.equal(r.txs[0].data.slice(0, 10), selector('putFile'))
  assert.equal(selector('putFile'), '0xfab2ed82', 'selector must match the mainnet SiteRegistry implementation')
  const [c, path, ct, hash, data] = decodeCall('putFile', r.txs[0].data)
  assert.equal(c.toLowerCase(), ADDR.container.toLowerCase())
  assert.equal(path, '.well-known/tapeapi.json', 'no leading slash')
  assert.equal(ct, 'application/json')
  const bytes = Buffer.from(data.slice(2), 'hex')
  assert.equal(bytes.length, r.size)
  assert.equal(hash.toLowerCase(), sha(bytes))
  assert.equal(r.sha256Hash, sha(bytes))
  assert.deepEqual(JSON.parse(bytes.toString('utf8')), m)
})

test('manifest over 24,000 bytes -> putFile + appendChunk(expectIndex = 1, 2, …), chunks reassemble to the hashed bytes', () => {
  const m = base(); m.description = 'x'.repeat(50_000)
  const r = api.tx.publishManifest({ container: ADDR.container, manifest: m })
  assert.equal(r.txs.length, 3)
  assert.equal(selector('appendChunk'), '0xe2b51347')
  const [, , , hash, first] = decodeCall('putFile', r.txs[0].data)
  const parts = [Buffer.from(first.slice(2), 'hex')]
  r.txs.slice(1).forEach((tx, i) => {
    assert.equal(tx.data.slice(0, 10), selector('appendChunk'))
    const [c, path, idx, chunk] = decodeCall('appendChunk', tx.data)
    assert.equal(c.toLowerCase(), ADDR.container.toLowerCase()); assert.equal(path, MANIFEST_KEY); assert.equal(idx, BigInt(i + 1))
    parts.push(Buffer.from(chunk.slice(2), 'hex'))
  })
  assert.ok(parts[0].length === 24_000 && parts[1].length === 24_000 && parts[2].length > 0)
  const all = Buffer.concat(parts)
  assert.equal(all.length, r.size); assert.equal(sha(all), hash.toLowerCase())
})

test('rejects: over the 64 KiB TAP-20 limit, wrong container, invalid manifest, non-JSON string', () => {
  const big = base(); big.description = 'y'.repeat(MANIFEST_LIMIT)
  assert.throws(() => api.tx.publishManifest({ container: ADDR.container, manifest: big }), (e) => e instanceof TapeAPIError && /exceeds/.test(e.message))
  assert.throws(() => api.tx.publishManifest({ container: ADDR.escrow, manifest: base() }), (e) => e.code === 'MANIFEST_INVALID' && /not the target container/.test(e.message))
  const bad = base(); delete bad.methods
  assert.throws(() => api.tx.publishManifest({ container: ADDR.container, manifest: bad }), (e) => e.code === 'MANIFEST_INVALID')
  assert.throws(() => api.tx.publishManifest({ container: ADDR.container, manifest: '{not json' }), (e) => e.code === 'MANIFEST_INVALID' && /not JSON/.test(e.message))
  assert.throws(() => api.tx.publishManifest({ container: 'nope', manifest: base() }), (e) => e.code === 'INVALID_ARGUMENT')
})

test('removeManifest -> removeFile(container, bare key)', () => {
  const tx = api.tx.removeManifest(ADDR.container)
  assert.equal(selector('removeFile'), '0x0a9c1871')
  const [c, path] = decodeCall('removeFile', tx.data)
  assert.equal(c.toLowerCase(), ADDR.container.toLowerCase()); assert.equal(path, MANIFEST_KEY)
})
