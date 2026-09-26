// Replays RECORDED mainnet responses (sdk/test/fixtures/mainnet-4246-index.json, chainId 56, TapeKit SPEC test vector
// 4246.0.tape / index.html) through the real RPC layer, ABI decoders and SHA-256 path. No network. This is the test
// that would have caught the leading-slash bug: the fake chain used to store whatever key we asked for.
// 回放真实主网响应（无网络）走真正的 RPC 层、ABI 解码与 SHA-256 路径。这就是本可以抓住前导斜杠 bug 的测试。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createTapeAPI, registryKey, MANIFEST_PATH, MANIFEST_KEY, abi } from '../src/index.js'
const { hexToBytes, toHex, keccak256, concatBytes } = abi

const fx = JSON.parse(readFileSync(new URL('./fixtures/mainnet-4246-index.json', import.meta.url), 'utf8'))
// Keyed by (to, data): the same calldata sent to another contract is not what mainnet answered (review R2-6)
// 按 (to, data) 取：同样的调用数据发往别的合约，就不是主网的答复
const byCall = new Map(Object.values(fx.calls).map((c) => [`${c.to.toLowerCase()}:${c.data.toLowerCase()}`, c]))
let served = []
// A fetch that answers exactly what mainnet answered for that calldata, on any node. / 对同样 calldata 原样回放主网答复。
const replayFetch = async (url, init) => {
  const req = JSON.parse(init.body); const c = byCall.get(`${String(req.params[0].to).toLowerCase()}:${req.params[0].data.toLowerCase()}`)
  served.push(req.params[0].data.toLowerCase())
  const body = !c ? { jsonrpc: '2.0', id: req.id, error: { code: 3, message: 'execution reverted (not in fixture)' } }
    : c.revert ? { jsonrpc: '2.0', id: req.id, error: { code: 3, message: 'execution reverted: 0x2a9df442' } }
    : { jsonrpc: '2.0', id: req.id, result: c.result }
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}
const api = () => createTapeAPI({ rpcUrls: ['https://a.invalid', 'https://b.invalid'], quorum: 2, fetch: replayFetch })

test('registryKey strips leading slashes only', () => {
  assert.equal(registryKey('/index.html'), 'index.html')
  assert.equal(registryKey('//.well-known/tapeapi.json'), '.well-known/tapeapi.json')
  assert.equal(registryKey('a/b/c.json'), 'a/b/c.json')
  assert.equal(registryKey(MANIFEST_PATH), MANIFEST_KEY)
})

test('mainnet vector: accountOf(cpu, 4246) decodes to the SPEC container', async () => {
  const c = await api().chain.accountOf(fx.circuits, fx.tokenId)
  assert.equal(c.toLowerCase(), fx.container.toLowerCase())
})

test('mainnet vector: fileInfo("index.html") decodes 756 bytes / text/html / the SPEC SHA-256', async () => {
  const fi = await api().chain.fileInfo(fx.container, 'index.html')
  assert.equal(fi.size, 756n)
  assert.equal(fi.contentType, 'text/html; charset=utf-8')
  assert.equal(fi.sha256Hash.toLowerCase(), '0xec444c899bd9229f9173082fff362da66dd297179482a58b30b6f53ce9f7a0b6')
})

test('mainnet vector: read("index.html") bytes hash to fileInfo.sha256Hash (the TAP-20 §3.2 check on real data)', async () => {
  const a = api()
  const fi = await a.chain.fileInfo(fx.container, 'index.html')
  const hex = await a.chain.readFile(fx.container, 'index.html')
  const bytes = Buffer.from(hex.slice(2), 'hex')
  assert.equal(BigInt(bytes.length), fi.size)
  assert.equal('0x' + createHash('sha256').update(bytes).digest('hex'), fi.sha256Hash.toLowerCase())
  assert.match(bytes.toString('utf8'), /^<!DOCTYPE html/)
})

test('a URL-form path is sent to the registry WITHOUT the slash (the bug: "/index.html" answers size 0 on mainnet)', async () => {
  served = []
  const fi = await api().chain.fileInfo(fx.container, '/index.html')
  assert.equal(fi.size, 756n, 'SDK must normalise "/index.html" to the key mainnet actually stores')
  const slashCall = fx.calls['fileInfo:/index.html'].data.toLowerCase()
  const bareCall = fx.calls['fileInfo:index.html'].data.toLowerCase()
  assert.ok(served.includes(bareCall), 'bare key was queried')
  assert.ok(!served.includes(slashCall), 'slash-prefixed key was never queried')
})

test('fixture sanity: mainnet really answers size 0 for "/index.html" and reverts read of it', () => {
  const slash = fx.calls['fileInfo:/index.html'].result
  assert.equal(BigInt('0x' + slash.slice(2, 66)), 0n, 'size word is zero')
  assert.match(fx.calls['read:/index.html'].revert, /0x2a9df442/)
})

test('mainnet vector: the SPEC container is the canonical ERC-6551 v0.3 CREATE2 address (arch B3)', () => {
  // The container can be derived without the hub: registry 0x000000006551c…, salt 0, implementation 0xaf4e78a2…,
  // chainId 56, the circuit contract and tokenId. Pinning the implementation set would demote the hub (an upgradeable
  // proxy) to a cross-check; this test records the fact that makes it possible.
  // 容器地址无需中枢即可推导：注册表、salt 0、实现合约、chainId、电路合约与 tokenId。若固定实现合约集合，可把中枢
  // （可升级代理）降为交叉校验；本测试记录使之可行的事实。
  const h = (s) => hexToBytes(s.startsWith('0x') ? s : '0x' + s)
  const word = (v) => h(BigInt(v).toString(16).padStart(64, '0'))
  const registry = '0x000000006551c19487814612e58FE06813775758', impl = '0xaf4e78a2257c9c5480c2f8310e3b00437260751d'
  const code = concatBytes(h('3d60ad80600a3d3981f3363d3d373d3d3d363d73'), h(impl), h('5af43d82803e903d91602b57fd5bf3'),
    word(0), word(56), word(fx.circuits), word(fx.tokenId))
  const addr = toHex(keccak256(concatBytes(h('ff'), h(registry), word(0), keccak256(code))).subarray(12))
  assert.equal(addr.toLowerCase(), fx.container.toLowerCase())
})
