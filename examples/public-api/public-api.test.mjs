// The public service (api.tapeapi.fun) on a fake chain: every method, its input checks, and a manifest the holder
// console will publish as served. No network. / 公共服务在假链上：每个方法、输入检查，以及控制台会照样发布的清单。不联网。
import test from 'node:test'
import assert from 'node:assert/strict'
import { abi, MAINNET, validateManifest } from '@tapeapi/sdk'
import { publicMethods, MANIFEST_METHODS, WBNB, USDT, WBNB_USDT_V2 } from './methods.js'
import worker, { manifestOf } from './worker.js'
import * as C from '../../site/console/lib.js'
import { privateKeyToAddress, signDigest, delegationDigest } from '../../sdk/src/sig.js'

const { selector, encodeParams, toHex, encodeReturn, checksumAddress } = abi
const enc = (types, values) => toHex(encodeParams(types, values))
const HASH = '0x' + 'ab'.repeat(32)
const A = (n) => '0x' + String(n).repeat(40).slice(0, 40)
const TOKEN = A(1), HOLDER = A(2), PAIR = A(3), NFT = A(4), CIRCUITS = A(5), CONTAINER = A(6)
const utf8 = (s) => toHex(new TextEncoder().encode(s))

// ethCall answers keyed by `${to}:${calldata}` (lower case); a missing key reverts like a contract would.
// ethCall 的回答按 `${to}:${calldata}` 查表；查不到就像合约那样 revert。
function fakeChain(answers = {}, { balance = 0n, code = '0x6080' } = {}) {
  const table = Object.fromEntries(Object.entries(answers).map(([k, v]) => [k.toLowerCase(), v]))
  const rpc = {
    async ethCall(to, data) {
      const v = table[`${to}:${data}`.toLowerCase()]
      if (v === undefined) throw Object.assign(new Error('execution reverted'), { code: 'RPC_ERROR' })
      return v
    },
    async call(method) {
      if (method === 'eth_getBalance') return '0x' + balance.toString(16)
      if (method === 'eth_getCode') return code
      throw new Error(`unexpected ${method}`)
    },
  }
  return {
    rpc,
    pinBlock: async () => ({ blockNumber: 100, blockHash: HASH, tag: '0x64' }),
    readAt: async (pinned, fn) => ({ value: await fn(pinned.tag), blockRef: 'number' }),
  }
}
const PINNED = { blockNumber: 100, blockHash: HASH, blockRef: 'number' }
const S = (sig) => selector(sig)
const erc20 = (t, { name = 'Tether USD', symbol = 'USDT', decimals = 18, supply = 10n ** 24n } = {}) => ({
  [`${t}:${S('decimals()')}`]: enc(['uint8'], [decimals]),
  [`${t}:${S('totalSupply()')}`]: enc(['uint256'], [supply]),
  ...(name == null ? {} : { [`${t}:${S('name()')}`]: typeof name === 'string' && name.startsWith('0x') ? name : enc(['string'], [name]) }),
  ...(symbol == null ? {} : { [`${t}:${S('symbol()')}`]: symbol.startsWith('0x') ? symbol : enc(['string'], [symbol]) }),
})

test('balance: wei and BNB of a checksummed address, pinned', async () => {
  const m = publicMethods(fakeChain({}, { balance: 1234500000000000000n }))
  assert.deepEqual(await m.balance({ address: HOLDER.toLowerCase() }), { address: checksumAddress(HOLDER), wei: '1234500000000000000', bnb: '1.2345', blockPinned: PINNED })
  await assert.rejects(m.balance({ address: '0x12' }), { code: 'BAD_REQUEST' })
  await assert.rejects(m.balance({}), { code: 'BAD_REQUEST' })
})

test('tokenInfo: string and bytes32 metadata, and a missing name is null rather than a failure', async () => {
  const m = publicMethods(fakeChain(erc20(TOKEN)))
  const r = await m.tokenInfo({ token: TOKEN })
  assert.deepEqual([r.name, r.symbol, r.decimals, r.totalSupply], ['Tether USD', 'USDT', 18, (10n ** 24n).toString()])
  const mkr = utf8('MKR').padEnd(66, '0')   // bytes32 symbol, as old tokens return it / 老代币的 bytes32 符号
  const r2 = await publicMethods(fakeChain(erc20(TOKEN, { name: null, symbol: mkr }))).tokenInfo({ token: TOKEN })
  assert.deepEqual([r2.name, r2.symbol], [null, 'MKR'])
  await assert.rejects(publicMethods(fakeChain({})).tokenInfo({ token: TOKEN }), { code: 'BAD_REQUEST' }, 'not a token at all')
})

test('tokenBalance: raw and in token units', async () => {
  const calls = { ...erc20(TOKEN, { decimals: 6 }), [`${TOKEN}:${S('balanceOf(address)')}${enc(['address'], [HOLDER]).slice(2)}`]: enc(['uint256'], [1500000n]) }
  const r = await publicMethods(fakeChain(calls)).tokenBalance({ token: TOKEN, address: HOLDER })
  assert.deepEqual([r.raw, r.amount, r.symbol, r.decimals], ['1500000', '1.5', 'USDT', 6])
  assert.deepEqual(r.blockPinned, PINNED)
})

test('nftOwner: the owner, and a clear error for a token that does not exist', async () => {
  const calls = { [`${NFT}:${S('ownerOf(uint256)')}${enc(['uint256'], [11n]).slice(2)}`]: enc(['address'], [HOLDER]) }
  const m = publicMethods(fakeChain(calls))
  assert.equal((await m.nftOwner({ contract: NFT, tokenId: '11' })).owner, checksumAddress(HOLDER))
  await assert.rejects(m.nftOwner({ contract: NFT, tokenId: '12' }), /does not exist/)
  await assert.rejects(m.nftOwner({ contract: NFT, tokenId: '-1' }), { code: 'BAD_REQUEST' })
  await assert.rejects(m.nftOwner({ contract: NFT, tokenId: '1e3' }), { code: 'BAD_REQUEST' })
})

function pairCalls(pair, t0, t1, r0, r1) {
  return {
    [`${pair}:${S('token0()')}`]: enc(['address'], [t0]), [`${pair}:${S('token1()')}`]: enc(['address'], [t1]),
    [`${pair}:${S('getReserves()')}`]: enc(['uint112', 'uint112', 'uint32'], [r0, r1, 1700000000n]),
    ...erc20(t0, { symbol: 'A' }), ...erc20(t1, { symbol: 'B' }),
  }
}

test('pairPrice and bnbUsd: prices from reserves, whichever way round the pair holds WBNB and USDT', async () => {
  const E = 10n ** 18n
  const p = await publicMethods(fakeChain(pairCalls(PAIR, TOKEN, HOLDER, 2n * E, 1000n * E))).pairPrice({ pair: PAIR })
  assert.deepEqual(p.price, { token0InToken1: '500', token1InToken0: '0.002' })
  for (const [t0, t1] of [[WBNB, USDT], [USDT, WBNB]]) {
    const r = t0 === WBNB ? [2n * E, 1500n * E] : [1500n * E, 2n * E]
    const b = await publicMethods(fakeChain(pairCalls(WBNB_USDT_V2, t0, t1, ...r))).bnbUsd({})
    assert.equal(b.bnbUsd, '750', `WBNB is token${t0 === WBNB ? 0 : 1}`)
  }
  await assert.rejects(publicMethods(fakeChain(pairCalls(PAIR, TOKEN, HOLDER, 0n, E))).pairPrice({ pair: PAIR }), /no liquidity/)
  await assert.rejects(publicMethods(fakeChain({})).pairPrice({ pair: PAIR }), /does not look like/)
  await assert.rejects(publicMethods(fakeChain(pairCalls(WBNB_USDT_V2, TOKEN, HOLDER, E, E))).bnbUsd({}), { code: 'INTERNAL' })
})

test('tapeName: a name resolves to its circuit, container, holder, and what the container publishes', async () => {
  const word = (n) => enc(['uint256'], [BigInt(n)]).slice(2)
  const file = (size) => encodeReturn('fileInfo', [BigInt(size), 'application/json', '0x' + 'cd'.repeat(32), 1n, 1n])
  const calls = {
    [`${MAINNET.factory}:${S('cpuAt(uint256)')}${word(1013)}`]: enc(['address'], [CIRCUITS]),
    [`${MAINNET.factory}:${abi.encodeCall('isCPU', [CIRCUITS])}`]: enc(['bool'], [true]),
    [`${CIRCUITS}:${S('ownerOf(uint256)')}${word(11)}`]: enc(['address'], [HOLDER]),
    [`${MAINNET.hub}:${abi.encodeCall('accountOf', [CIRCUITS, 11n])}`]: enc(['address'], [CONTAINER]),
    [`${MAINNET.siteRegistry}:${abi.encodeCall('fileInfo', [CONTAINER, '.well-known/tapeapi.json'])}`]: file(571),
    [`${MAINNET.siteRegistry}:${abi.encodeCall('fileInfo', [CONTAINER, '.well-known/tape-channel.json'])}`]: file(0),
  }
  const m = publicMethods(fakeChain(calls))
  const r = await m.tapeName({ name: '11.1013.tape' })
  assert.deepEqual([r.name, r.processor, r.tokenId, r.container, r.holder, r.opened], ['11.1013.tape', 1013, '11', checksumAddress(CONTAINER), checksumAddress(HOLDER), true])
  assert.deepEqual(r.tapeapi, { path: '.well-known/tapeapi.json', size: 571, sha256: '0x' + 'cd'.repeat(32) })
  assert.equal(r.channelKeys, null)
  assert.deepEqual(await m.tapeName({ processor: 1013, tokenId: '11' }), r, 'numbers work as well as the name')
  const closed = await publicMethods(fakeChain(calls, { code: '0x' })).tapeName({ name: '11.1013.tape' })
  assert.equal(closed.opened, false)
  await assert.rejects(m.tapeName({ name: '11.1014.tape' }), /processor 1014 does not exist/)
  await assert.rejects(m.tapeName({ name: '12.1013.tape' }), /circuit #12 does not exist/)
  for (const name of ['1013.11', '11.1013.tap', 'a.1013.tape', '0.1013.tape']) await assert.rejects(m.tapeName({ name }), { code: 'BAD_REQUEST' }, name)
  const fake = { ...calls, [`${MAINNET.factory}:${abi.encodeCall('isCPU', [CIRCUITS])}`]: enc(['bool'], [false]) }
  await assert.rejects(publicMethods(fakeChain(fake)).tapeName({ name: '11.1013.tape' }), /not a TapeOut processor/)
})

test('the manifest lists every implemented method, is valid TAP-20, and the holder console publishes it as served', async () => {
  const impl = publicMethods(fakeChain({}))
  assert.deepEqual(MANIFEST_METHODS.map((m) => m.name).sort(), Object.keys(impl).sort())
  const SIGNER_KEY = '0x' + '22'.repeat(32), HOLDER_KEY = '0x' + '11'.repeat(32)
  const signer = privateKeyToAddress(SIGNER_KEY), holder = privateKeyToAddress(HOLDER_KEY)
  const expires = Math.floor(Date.now() / 1000) + 90 * 86400
  const container = checksumAddress(CONTAINER), circuits = checksumAddress(CIRCUITS)
  const sig = signDigest(delegationDigest(56, MAINNET.hub, { container, signer, expires }), HOLDER_KEY)
  const env = { SIGNER_KEY, PUBLIC_URL: 'https://api.tapeapi.fun', CIRCUITS: circuits, TOKEN_ID: '11', CONTAINER: container, DELEGATION_EXPIRES: String(expires), DELEGATION_SIG: sig }
  const m = manifestOf(env)
  assert.doesNotThrow(() => validateManifest(m, { requireDelegation: true }))
  const s = { circuits, tokenId: '11', container, holder, signer, expires, sig, endpoint: 'https://api.tapeapi.fun/tapeapi/v1' }
  assert.deepEqual(C.manifestProblems(JSON.stringify(m), s), [])
  assert.deepEqual(JSON.parse(C.manifestText({ ...s, name: m.name, methods: m.methods })), m, 'the page publishes exactly what the service serves')
})

test('setup mode until the holder has signed; the served manifest once configured', async () => {
  const h = await (await worker.fetch(new Request('https://api.tapeapi.fun/tapeapi/v1/health'), { SIGNER_KEY: '0x' + '22'.repeat(32), PUBLIC_URL: 'https://api.tapeapi.fun' })).json()
  assert.deepEqual([h.ok, h.setup], [false, true])
})

test('/mcp: once configured, the Worker answers MCP with the eight public methods as tools; in setup mode it does not', async () => {
  const holder = '0x' + '11'.repeat(32), key = '0x' + '22'.repeat(32), expires = Math.floor(Date.now() / 1000) + 86400
  const env = {
    SIGNER_KEY: key, CIRCUITS: CIRCUITS, TOKEN_ID: '11', CONTAINER: CONTAINER, DELEGATION_EXPIRES: String(expires),
    DELEGATION_SIG: signDigest(delegationDigest(56, MAINNET.hub, { container: CONTAINER, signer: privateKeyToAddress(key), expires }), holder),
    PUBLIC_URL: 'https://api.tapeapi.fun', TAPE_NAME: '11.1013.tape', RPC_URLS: 'http://127.0.0.1:9,http://127.0.0.1:10',
  }
  const rpc = (body, e = env) => worker.fetch(new Request('https://api.tapeapi.fun/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), e)
  const init = await (await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })).json()
  assert.equal(init.result.serverInfo.name, 'tapeapi-11.1013.tape')
  const list = await (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()
  assert.deepEqual(list.result.tools.map((t) => t.name), MANIFEST_METHODS.map((m) => m.name))
  const setup = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, { SIGNER_KEY: key, PUBLIC_URL: 'https://api.tapeapi.fun' })
  assert.notEqual(setup.status, 200)
})
