import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  selector, signatureOf, encodeCall, decodeCall, encodeParams, decodeParams, encodeReturn, decodeReturn,
  labelToBytes32, bytes32ToLabel, checksumAddress, functionBySelector, SERVICE_TUPLE, toHex,
} from '../src/abi.js'

const A = '0x' + 'aa'.repeat(20), B = '0x' + 'bb'.repeat(20)

test('selectors match well-known values', () => {
  assert.equal(selector('balanceOf'), '0x70a08231')
  assert.equal(selector('ownerOf'), '0x6352211e')
  assert.equal(selector('transfer(address,uint256)'), '0xa9059cbb')
  assert.equal(signatureOf('settle'), 'settle(address,address,uint256,uint64,bytes)')
  assert.equal(signatureOf('serviceOf'), 'serviceOf(address)')
  // v2 escrow: everything is keyed by (consumer, provider) channel / v2 托管：一切按通道
  assert.equal(signatureOf('fund'), 'fund(address,uint256)')
  assert.equal(signatureOf('requestWithdraw'), 'requestWithdraw(address,uint256)')
  assert.equal(signatureOf('withdraw'), 'withdraw(address)')
  assert.equal(signatureOf('authorizeSession'), 'authorizeSession(address,address,uint64)')
  assert.equal(signatureOf('channelOf'), 'channelOf(address,address)')
  assert.equal(signatureOf('sessionExpiry'), 'sessionExpiry(address,address,address)')
  assert.equal(signatureOf('pendingWithdraw'), 'pendingWithdraw(address,address)')
  // the v1 surface is gone / v1 接口已移除
  for (const gone of ['deposit', 'setAllowance', 'requestAllowanceDecrease', 'allowanceOf', 'revokeSession', 'pendingAllowance']) {
    assert.throws(() => signatureOf(gone), /unknown function/, gone)
  }
})
test('static encoding: address / uint / bool / bytes32', () => {
  const hex = toHex(encodeParams(['address', 'uint256', 'bool', 'bytes32', 'uint64', 'uint16'], [A, 4246n, true, '0x' + '01'.repeat(32), 7, 65535]))
  assert.equal(hex, '0x' + '00'.repeat(12) + 'aa'.repeat(20) + (4246n).toString(16).padStart(64, '0') + '1'.padStart(64, '0') + '01'.repeat(32) + '7'.padStart(64, '0') + 'ffff'.padStart(64, '0'))
  const [a, u, b, h, u64, u16] = decodeParams(['address', 'uint256', 'bool', 'bytes32', 'uint64', 'uint16'], hex)
  assert.equal(a, checksumAddress(A)); assert.equal(u, 4246n); assert.equal(b, true); assert.equal(h, '0x' + '01'.repeat(32)); assert.equal(u64, 7n); assert.equal(u16, 65535n)
})
test('dynamic encoding: string / bytes round-trip and layout', () => {
  const hex = toHex(encodeParams(['address', 'string'], [B, '/.well-known/tapeapi.json']))
  // head: address, offset 0x40; tail: len 25, padded utf8 / 头部两个字，尾部长度+数据
  assert.equal(hex.slice(2 + 64, 2 + 128), '40'.padStart(64, '0'))
  assert.equal(BigInt('0x' + hex.slice(2 + 128, 2 + 192)), 25n)
  const [addr, s] = decodeParams(['address', 'string'], hex)
  assert.equal(addr, checksumAddress(B)); assert.equal(s, '/.well-known/tapeapi.json')
  const raw = new Uint8Array([1, 2, 3, 250, 251])
  const [bytes] = decodeParams(['bytes'], encodeParams(['bytes'], [raw]))
  assert.equal(bytes, '0x010203fafb')
  const [empty] = decodeParams(['bytes'], encodeParams(['bytes'], ['0x']))
  assert.equal(empty, '0x')
  const [uni] = decodeParams(['string'], encodeParams(['string'], ['你好 TapeAPI ✓']))
  assert.equal(uni, '你好 TapeAPI ✓')
})
test('Service tuple (dynamic tuple) round-trip via serviceOf', () => {
  const svc = { circuits: A, tokenId: 4246n, container: B, label: labelToBytes32('reader'), manifestPath: '/.well-known/tapeapi.json', updatedAt: 1758300000n }
  const enc = encodeReturn('serviceOf', [svc])
  // 动态 tuple：首字为 offset 0x20 / dynamic tuple: first word is offset 0x20
  assert.equal(enc.slice(2, 66), '20'.padStart(64, '0'))
  const d = decodeReturn('serviceOf', enc)
  assert.equal(d.circuits, checksumAddress(A)); assert.equal(d.tokenId, 4246n); assert.equal(d.container, checksumAddress(B))
  assert.equal(bytes32ToLabel(d.label), 'reader'); assert.equal(d.manifestPath, svc.manifestPath); assert.equal(d.updatedAt, 1758300000n)
  assert.equal(SERVICE_TUPLE.components.length, 6)
})
test('encodeCall / decodeCall / functionBySelector', () => {
  const data = encodeCall('settle', [A, B, 12345n, 1758400000n, '0x' + 'cd'.repeat(65)])
  assert.equal(data.slice(0, 10), selector('settle'))
  assert.equal(functionBySelector(data), 'settle')
  const args = decodeCall('settle', data)
  assert.equal(args[0], checksumAddress(A)); assert.equal(args[2], 12345n); assert.equal(args[3], 1758400000n); assert.equal(args[4], '0x' + 'cd'.repeat(65))
  const call = encodeCall('read', [B, '/x'])
  assert.equal(decodeCall('read', call)[1], '/x')
  assert.throws(() => encodeCall('nope', []), /unknown function/)
  assert.throws(() => encodeParams(['uint16'], [70000]), /out of range/)
  assert.throws(() => encodeParams(['address'], ['0x123']), /bad address/)
})
test('labelToBytes32 pads ASCII right and accepts bytes32 passthrough', () => {
  assert.equal(labelToBytes32('reader'), '0x' + Buffer.from('reader').toString('hex').padEnd(64, '0'))
  assert.equal(labelToBytes32('0x' + 'ab'.repeat(32)), '0x' + 'ab'.repeat(32))
  assert.throws(() => labelToBytes32(''), /1\.\.32/)
  assert.throws(() => labelToBytes32('x'.repeat(33)), /1\.\.32/)
  // L-21: non-ASCII (Cyrillic е in "rеader"), spaces and control chars are rejected / 拒绝同形字、空格、控制字符
  for (const bad of ['r\u0435ader', 'my label', 'a\tb', 'a\nb', 'x'.repeat(31) + '\u00e9', 42, null]) assert.throws(() => labelToBytes32(bad), (e) => e.code === 'ABI_INVALID', String(bad))
  assert.equal(labelToBytes32('Reader-1.tape'), '0x' + Buffer.from('Reader-1.tape').toString('hex').padEnd(64, '0'))
})
test('checksumAddress EIP-55 vector', () => {
  assert.equal(checksumAddress('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed'), '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed')
  assert.equal(checksumAddress('0xFB6916095CA1DF60BB79CE92CE3EA74C37C5D359'), '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359')
})

test('fileInfo(address,string): multi-value return with a dynamic string decodes to named fields', () => {
  assert.equal(signatureOf('fileInfo'), 'fileInfo(address,string)')
  const h = '0x' + 'ab'.repeat(32)
  const enc = encodeReturn('fileInfo', [756n, 'text/html', h, 1700000000n, 1n])
  const d = decodeReturn('fileInfo', enc)
  assert.equal(d.size, 756n); assert.equal(d.contentType, 'text/html'); assert.equal(d.sha256Hash, h)
  assert.equal(d.updatedAt, 1700000000n); assert.equal(d.chunkCount, 1n)
  assert.deepEqual([...d], [756n, 'text/html', h, 1700000000n, 1n])
})
