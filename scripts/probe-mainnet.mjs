#!/usr/bin/env node
// Read-only live probe of the TAP-20 resolve path on BNB Chain (chainId 56). Sends no transactions.
// Usage: node scripts/probe-mainnet.mjs [circuits tokenId]   (default: TapeKit SPEC vector 4246 on processor #0)
// 只读主网探针：走 SDK 的真实解析路径。不发送任何交易。
import { createTapeAPI, createRpc, MANIFEST_PATH, MANIFEST_KEY, rpcUrlsFor } from '../sdk/src/index.js'
import { keccak256 } from '../sdk/src/sig.js'
import { createHash } from 'node:crypto'

const urls = process.env.RPC_URLS ? process.env.RPC_URLS.split(',') : rpcUrlsFor(56)
const api = createTapeAPI({ rpcUrls: urls, quorum: 2, timeoutMs: 25000 })
const rpc = createRpc({ urls, quorum: 2, timeoutMs: 25000 })
const FACTORY = '0x68224F668083c29e9800Be2a646d42d18cedF7e2'
const sel = (sig) => '0x' + Buffer.from(keccak256(Buffer.from(sig))).toString('hex').slice(0, 8)

let [circuits, tokenId] = process.argv.slice(2)
if (!circuits) { circuits = '0x' + (await rpc.ethCall(FACTORY, sel('cpus(uint256)') + '0'.repeat(64))).slice(-40); tokenId = '4246' }
console.log('circuits   ', circuits, 'tokenId', tokenId)
const container = await api.chain.accountOf(circuits, tokenId)
console.log('container  ', container)
console.log('holder     ', await api.chain.ownerOf(circuits, tokenId))
for (const p of ['index.html', '/index.html', MANIFEST_KEY, MANIFEST_PATH]) {
  const fi = await api.chain.fileInfo(container, p)
  console.log(`fileInfo(${JSON.stringify(p)})`.padEnd(40), 'size', String(fi.size).padStart(6), fi.contentType || '-', fi.sha256Hash)
}
try {
  const hex = await api.chain.readFile(container, 'index.html'); const b = Buffer.from(hex.slice(2), 'hex')
  console.log('read(index.html)'.padEnd(40), b.length, 'bytes  sha256', createHash('sha256').update(b).digest('hex'))
} catch (e) { console.log('read(index.html) failed:', e.code, e.message.slice(0, 100)) }
try { const svc = await api.resolve({ circuits, tokenId }); console.log('resolve    OK', svc.container, svc.manifest?.name) }
catch (e) { console.log('resolve    ', e.code, '-', e.message.slice(0, 160)) }
// TAP-26 §3.1: the container's TapeSend key, the identity a Tape Channel authenticates against.
// TAP-26 §3.1：容器的 TapeSend 密钥，Tape Channel 认证所依据的身份。
try { const k = await api.chain.tapeSendKey(container); console.log('tapeSendKey', k.staticPublic, 'suite 1, index', k.keyIndex, 'holder', k.holder) }
catch (e) { console.log('tapeSendKey', e.code, '-', e.message.slice(0, 120)) }
