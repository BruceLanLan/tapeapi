// Security 1.2, the Merkle proof mode (createTapeAPI({ pin: true, proofs })): each finding as a test, PROOF-1..12, and the
// independent review's PROOFR-1..5.
// The resolve-level tests replay a real resolution of 11.1013.tape on BNB Smart Chain with no network
// (fixtures/mainnet-11-1013-proof.json, recorded read-only by scripts/record-mainnet-proof.mjs): the pinned block and its
// stateRoot, every eth_call and eth_getStorageAt the resolution made, and the eth_getProof answers of the one default node
// that serves proofs (Alchemy). spec/vectors/tapi-20-proof.json carries the same proofs, and Ethereum trie-test cases, for
// the independent Python checker (spec/vectors/verify.py).
// 安全加固 1.2 的默克尔证明模式：每项发现写成测试。解析级测试无网络地回放 11.1013.tape 在 BSC 上的一次真实解析（只读录制）：钉住的
// 区块及其 stateRoot、解析所做的每个 eth_call 与 eth_getStorageAt，以及唯一提供证明的默认节点（Alchemy）的 eth_getProof 回答。
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { keccak_256 } from '@noble/hashes/sha3'
import { createTapeAPI, TapeAPIError, proof, abi, sig, createRpc, IMPL_SLOT } from '../src/index.js'
import { buildTrie, trieBytes, rlpEncode } from './helpers/trie.mjs'

const { verifyAccountProof, verifyMptProof, rlpDecode, STORAGE, addressOfWord } = proof
const fx = JSON.parse(readFileSync(new URL('./fixtures/mainnet-11-1013-proof.json', import.meta.url), 'utf8'))
const vectors = JSON.parse(readFileSync(new URL('../../spec/vectors/tapi-20-proof.json', import.meta.url), 'utf8'))
const ET = JSON.parse(readFileSync(new URL('./fixtures/ethereum-trie-tests.json', import.meta.url), 'utf8'))
const clone = (x) => JSON.parse(JSON.stringify(x))
const code = (c) => (e) => e instanceof TapeAPIError && e.code === c
const flip = (h, byte, xor = 1) => { const b = Buffer.from(h.slice(2), 'hex'); b[byte] ^= xor; return '0x' + b.toString('hex') }
const RPC = ['https://a.invalid', 'https://b.invalid']
const proofOf = (address) => fx.getProof.find((g) => g.address.toLowerCase() === address.toLowerCase())

// ---------------------------------------------------------------- replay ----
// Answers what the recorded resolution asked. `o`: stateRoot (what every node reports for the block), badRoot (what one
// node reports), prover(url) (whether that node serves eth_getProof), proverError(url) (a JSON-RPC error that node answers
// eth_getProof with), tamper(answer, address, url) (changes a served proof), forge(to, data) (an eth_call answer every
// node agrees on: nodes that collude), rootOf(url) (overrides the stateRoot per node; undefined leaves it out). Every
// state read must be at the pinned block.
// 回放录下的解析所问的一切。`o`：stateRoot（各节点对该块报的）、badRoot（某个节点报的）、prover(url)（该节点是否提供证明）、
// tamper（改动提供的证明）、forge（所有节点一致的 eth_call 回答：合谋的节点）。每个状态读取都必须在钉住的区块上。
function replay(o = {}) {
  const calls = new Map(fx.calls.map((c) => [`${c.to.toLowerCase()}:${c.data.toLowerCase()}`, c.result]))
  const storage = new Map(fx.storage.map((s) => [`${s.address.toLowerCase()}:${s.slot.toLowerCase()}`, s.result]))
  const log = []
  const pinnedAt = (b) => b && typeof b === 'object' && b.blockHash === fx.block.hash
  const one = (url, req) => {
    const ok = (result) => ({ jsonrpc: '2.0', id: req.id, result })
    const err = (c, message) => ({ jsonrpc: '2.0', id: req.id, error: { code: c, message } })
    log.push({ url, method: req.method, params: req.params })
    switch (req.method) {
      case 'eth_getBlockByNumber': {
        const stateRoot = o.rootOf ? o.rootOf(url) : o.badRoot && url === RPC[1] ? o.badRoot : (o.stateRoot ?? fx.block.stateRoot)
        return ok({ number: '0x' + fx.block.number.toString(16), hash: fx.block.hash, timestamp: '0x' + fx.block.timestamp.toString(16), ...(stateRoot === undefined ? {} : { stateRoot }), parentHash: '0x' + '00'.repeat(32) })
      }
      case 'eth_call': {
        const [{ to, data }, at] = req.params
        assert.ok(pinnedAt(at), `eth_call at ${JSON.stringify(at)}`)
        const forged = o.forge?.(to, data)
        if (forged !== undefined) return ok(forged)
        const r = calls.get(`${to.toLowerCase()}:${data.toLowerCase()}`)
        return r === undefined ? err(3, 'execution reverted (not in fixture)') : ok(r)
      }
      // the holders here are keys, not contracts (EIP-1271 is not reached) / 这里的持有人都是密钥而不是合约
      case 'eth_getCode': return ok('0x')
      case 'eth_getStorageAt': {
        assert.ok(pinnedAt(req.params[2]))
        return ok(storage.get(`${req.params[0].toLowerCase()}:${req.params[1].toLowerCase()}`) ?? '0x' + '00'.repeat(32))
      }
      case 'eth_getProof': {
        assert.equal(req.params[2], '0x' + fx.block.number.toString(16), 'proofs are asked by block number')
        const pe = o.proverError?.(url)
        if (pe) return err(pe.code, pe.message)
        if (!(o.prover ?? ((u) => u === RPC[1]))(url)) return err(-32601, 'the method eth_getProof does not exist/is not available')
        const g = fx.getProof.find((x) => x.address.toLowerCase() === req.params[0].toLowerCase() && x.slots.join() === req.params[1].join())
        if (!g) return err(-32000, 'not in fixture')
        return ok(o.tamper ? o.tamper(clone(g.answer), g.address, url) : g.answer)
      }
      default: return err(-32601, `no ${req.method} in the replay`)
    }
  }
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    await new Promise((r) => setTimeout(r, 2))
    const out = Array.isArray(body) ? body.map((q) => one(url, q)) : one(url, body)
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return { fetch, log }
}
// Only Date is mocked (the pin's freshness check); the RPC layer keeps real timers. / 只模拟 Date。
const at = async (fn) => {
  mock.timers.enable({ apis: ['Date'], now: (fx.block.timestamp + 1) * 1000 })
  try { return await fn() } finally { mock.timers.reset() }
}
const client = (r, o = {}) => createTapeAPI({ rpcUrls: RPC, quorum: 2, fetch: r.fetch, pin: true, onWarning: () => {}, ...o })

// ---------------------------------------------------------------- verifier ----
test('CONFIRMED PROOF-1: the recorded eth_getProof answers verify against the pinned stateRoot and prove exactly what the nodes answered by eth_call', () => {
  const values = new Map()
  for (const g of fx.getProof) {
    const r = verifyAccountProof(fx.block.stateRoot, g.address, g.slots, g.answer)
    assert.equal(r.account.exists, true)
    for (const [k, v] of r.values) values.set(k, v)
  }
  const call = (fn) => abi.decodeReturn(fn, fx.calls.find((c) => c.data.startsWith(abi.selector(fn))).result)
  const info = call('fileInfo')
  const f = STORAGE.fileInfo(fx.container, '.well-known/tapeapi.json')
  assert.equal(values.get(f.size) & 0xffffffffn, info.size)
  assert.equal('0x' + values.get(f.sha256Hash).toString(16).padStart(64, '0'), info.sha256Hash.toLowerCase())
  assert.equal(addressOfWord(values.get(STORAGE.ownerOf(11n))), fx.holder.toLowerCase())
  assert.equal(addressOfWord(values.get(STORAGE.cpuAt(1013n).element)), call('cpuAt').toLowerCase())
  assert.ok(values.get(STORAGE.cpuAt(1013n).length) > 1013n)
  assert.equal(values.get(STORAGE.isCPU(call('cpuAt'))), 1n)
  // the proxies' proven implementations are the ones chains.js expects / 代理的已证明实现正是 chains.js 所期望的
  for (const [role, address] of [['siteRegistry', '0xd006ffdd5Ae313B17729621A00999cD3C71CE5e6'], ['factory', '0x68224F668083c29e9800Be2a646d42d18cedF7e2']]) {
    const g = proofOf(address)
    assert.ok(proof.LAYOUT_IMPLEMENTATIONS[role].includes(addressOfWord(verifyAccountProof(fx.block.stateRoot, g.address, g.slots, g.answer).values.get(BigInt(IMPL_SLOT)))), role)
  }
})

test('FIXED PROOF-2: changing any one byte of any node of any proof is refused (PROOF_INVALID), for every byte', () => {
  let tried = 0
  for (const g of fx.getProof) {
    const lists = [['accountProof', g.answer.accountProof], ...g.answer.storageProof.map((s, i) => [i, s.proof])]
    for (const [which, nodes] of lists) {
      nodes.forEach((n, ni) => {
        const len = (n.length - 2) / 2
        for (let byte = 0; byte < len; byte++) {
          const a = clone(g.answer)
          const target = which === 'accountProof' ? a.accountProof : a.storageProof[which].proof
          target[ni] = flip(n, byte, 1 << (byte % 8))
          assert.throws(() => verifyAccountProof(fx.block.stateRoot, g.address, g.slots, a), code('PROOF_INVALID'), `${g.address} ${which} node ${ni} byte ${byte}`)
          tried++
        }
      })
    }
  }
  assert.ok(tried > 20000, `${tried} single-byte changes`)
})

test('FIXED PROOF-3: a stateRoot other than the confirmed one refuses every proof; so do a truncated proof, an extra node and a claimed value the proof does not show', () => {
  const wrong = flip(fx.block.stateRoot, 31)
  for (const g of fx.getProof) assert.throws(() => verifyAccountProof(wrong, g.address, g.slots, g.answer), code('PROOF_INVALID'))
  const g = proofOf('0xd006ffdd5Ae313B17729621A00999cD3C71CE5e6')
  const drop = clone(g.answer); drop.accountProof.pop()
  assert.throws(() => verifyAccountProof(fx.block.stateRoot, g.address, g.slots, drop), code('PROOF_INVALID'))
  const extra = clone(g.answer); extra.accountProof.push(extra.accountProof[0])
  assert.throws(() => verifyAccountProof(fx.block.stateRoot, g.address, g.slots, extra), /unused/)
  const claim = clone(g.answer); claim.storageProof[2].value = '0x1234'
  assert.throws(() => verifyAccountProof(fx.block.stateRoot, g.address, g.slots, claim), /claims/)
  const hash = clone(g.answer); hash.storageHash = flip(hash.storageHash, 0)
  assert.throws(() => verifyAccountProof(fx.block.stateRoot, g.address, g.slots, hash), /storageHash/)
  const missing = clone(g.answer); missing.storageProof.pop()
  assert.throws(() => verifyAccountProof(fx.block.stateRoot, g.address, g.slots, missing), /answered 0 times/)
  const other = clone(g.answer); other.address = '0x' + '11'.repeat(20)
  assert.throws(() => verifyAccountProof(fx.block.stateRoot, g.address, g.slots, other), /answered for/)
  // the proof of one contract is not the proof of another / 一个合约的证明不是另一个合约的证明
  assert.throws(() => verifyAccountProof(fx.block.stateRoot, '0xe02c26c7432A7121168AA9B610DE24eCf9a1a414', g.slots, g.answer), code('PROOF_INVALID'))
})

test('FIXED PROOF-4: absence is proven too: an empty slot is 0, an address without an account has no code, and a proof cannot claim a value there', () => {
  const [slot, account] = fx.absent
  const r1 = verifyAccountProof(fx.block.stateRoot, slot.address, slot.slots, slot.answer)
  assert.equal(r1.account.exists, true)
  assert.equal([...r1.values.values()][0], 0n)
  const r2 = verifyAccountProof(fx.block.stateRoot, account.address, account.slots, account.answer)
  assert.equal(r2.account.exists, false)
  assert.equal(r2.account.codeHash, proof.EMPTY_CODE_HASH)
  const lie = clone(slot.answer); lie.storageProof[0].value = '0x1'
  assert.throws(() => verifyAccountProof(fx.block.stateRoot, slot.address, slot.slots, lie), /claims/)
  // an absence proof for a slot that is set does not verify: the path leads to the real leaf / 已有值的槽拿不出"不存在"的证明
  const owner = proofOf('0xe02c26c7432A7121168AA9B610DE24eCf9a1a414')
  const swapped = clone(owner.answer); swapped.storageProof[0].proof = slot.answer.storageProof[0].proof
  assert.throws(() => verifyAccountProof(fx.block.stateRoot, owner.address, owner.slots, swapped), code('PROOF_INVALID'))
})

test('FIXED PROOF-5: RLP is canonical only, and trie nodes are checked the way the Yellow Paper builds them', () => {
  const b = (h) => Uint8Array.from(Buffer.from(h, 'hex'))
  assert.deepEqual(rlpDecode(b('83646f67')), b('646f67'))
  for (const [h, why] of [['8100', /wrapped/], ['b800', /leading zero|long form/], ['b80100', /long form/], ['c0c0', /trailing/], ['83646f', /past the input/], ['f800', /leading zero|long form/], ['', /ended early/]]) {
    assert.throws(() => rlpDecode(b(h)), (e) => e.code === 'PROOF_INVALID' && why.test(e.message), h)
  }
  // An embedded node of 32 bytes or more is refused (it must be hashed) / 32 字节及以上的节点必须按哈希引用
  const leaf = [Uint8Array.of(0x3a), new Uint8Array(40).fill(7)]
  const branch = Array.from({ length: 17 }, (_, i) => (i === 1 ? leaf : new Uint8Array(0)))
  const raw = rlpEncode(branch)
  assert.throws(() => verifyMptProof(keccak_256(raw), Uint8Array.of(0x1a), ['0x' + Buffer.from(raw).toString('hex')]), /embedded node of/)
  // hex-prefix with a bad flag, and an even path with a non-zero pad / hex-prefix 标志错误、偶数长度填充非零
  for (const path of [Uint8Array.of(0x41), Uint8Array.of(0x21)]) {
    const node = rlpEncode([path, Uint8Array.of(1, 2)])
    assert.throws(() => verifyMptProof(keccak_256(node), Uint8Array.of(0x01), ['0x' + Buffer.from(node).toString('hex')]), /hex-prefix/)
  }
})

test('FIXED PROOF-6: the Ethereum trie tests: built roots equal ethereum/tests\' roots, and every proof (present, absent, embedded nodes) verifies to the value in the case', () => {
  let embedded = 0, absent = 0
  for (const [file, cases] of Object.entries(ET.files)) {
    const secure = /secure/i.test(file)
    for (const c of cases) {
      const pairs = Object.entries(c.in).map(([k, v]) => [trieBytes(k), trieBytes(v)])
      const t = buildTrie(pairs, { secure })
      assert.equal(t.root, c.root, `${file}/${c.name}`)
      for (const [k, v] of [...pairs, [trieBytes('0xdeadbeefcafe'), new Uint8Array(0)]]) {
        const p = t.proof(k)
        const got = verifyMptProof(t.root, secure ? keccak_256(k) : k, p, { secure })
        if (v.length) assert.deepEqual(got, v, `${file}/${c.name} ${Buffer.from(k)}`); else { assert.equal(got, null); absent++ }
        // fewer hashed nodes than the key's depth means an embedded node was walked / 哈希节点少于所走深度，说明走过内嵌节点
        if (!secure && p.length > 0 && p.some((n) => rlpDecode(Buffer.from(n.slice(2), 'hex')).some((x) => Array.isArray(x)))) embedded++
      }
    }
  }
  assert.ok(embedded > 0, 'some proofs walk embedded nodes')
  assert.ok(absent > 0)
})

test('FIXED PROOF-7: spec/vectors/tapi-20-proof.json matches the SDK, and verify.py checks it independently (three-way agreement)', () => {
  for (const c of vectors.trie) for (const p of c.proofs) {
    const got = verifyMptProof(c.root, p.path, p.proof, { secure: c.secure })
    assert.equal(got === null ? null : '0x' + Buffer.from(got).toString('hex'), p.value, `${c.file}/${c.name} ${p.key}`)
  }
  assert.equal(vectors.mainnet.block.stateRoot, fx.block.stateRoot)
  for (const a of vectors.mainnet.accounts) {
    const r = verifyAccountProof(vectors.mainnet.block.stateRoot, a.address, a.slots, a.answer)
    assert.deepEqual({ exists: r.account.exists, storageRoot: r.account.storageRoot, codeHash: r.account.codeHash, values: Object.fromEntries([...r.values].map(([k, v]) => ['0x' + k.toString(16), '0x' + v.toString(16)])) }, a.expect)
  }
  for (const m of vectors.mainnet.mutations) {
    const a = clone(vectors.mainnet.accounts[m.account].answer)
    const list = m.list === 'accountProof' ? a.accountProof : a.storageProof[Number(m.list.split('.')[1])].proof
    list[m.node] = flip(list[m.node], m.byte, m.xor)
    assert.throws(() => verifyAccountProof(vectors.mainnet.block.stateRoot, vectors.mainnet.accounts[m.account].address, vectors.mainnet.accounts[m.account].slots, a), code('PROOF_INVALID'))
  }
  const out = execFileSync('python3', [fileURLToPath(new URL('../../spec/vectors/verify.py', import.meta.url))], { encoding: 'utf8' })
  assert.match(out, /^ok: \d+ checks/m)
})

// ---------------------------------------------------------------- resolve ----
test('FIXED PROOF-8: pin + proofs \'strict\' resolves 11.1013.tape offline with fileInfo, cpuAt, isCPU and ownerOf proven, from a node that is not in the quorum\'s agreement', async () => {
  const r = replay()
  const svc = await at(() => client(r, { proofs: 'strict' }).resolve(fx.name))
  assert.equal(svc.verified.holder, fx.holder)
  assert.equal(svc.proofs.mode, 'strict')
  assert.equal(svc.proofs.block, fx.block.number)
  assert.equal(svc.proofs.stateRoot, fx.block.stateRoot)
  assert.deepEqual(svc.proofs.verified.map((x) => x.read).sort(), ['cpuAt', 'fileInfo', 'isCPU', 'ownerOf'])
  assert.ok(svc.proofs.verified.every((x) => x.node === 'b.invalid'))
  assert.deepEqual(svc.proofs.unavailable, [])
  assert.deepEqual(svc.proofs.invalid, [])
  assert.equal(svc.warnings, undefined)
  // node a refused once per concurrent first request, then is skipped; one eth_getProof per contract reached node b
  // a 在最初并发的请求上各拒绝一次，之后被跳过；每个合约一个 eth_getProof 到达 b
  const asked = r.log.filter((x) => x.method === 'eth_getProof')
  assert.equal(asked.filter((x) => x.url === RPC[1]).length, 3)
  const before = asked.filter((x) => x.url === RPC[0]).length
  assert.ok(before >= 1 && before <= 3)
  // the pinned block was asked for with its stateRoot, and every eth_call still went to both nodes / 每个 eth_call 仍问两个节点
  const ethCalls = r.log.filter((x) => x.method === 'eth_call')
  assert.equal(ethCalls.filter((x) => x.url === RPC[0]).length, ethCalls.filter((x) => x.url === RPC[1]).length)
})

test('FIXED PROOF-9: proofs: true warns and keeps the quorum reads when no node serves proofs; \'strict\' refuses with PROOF_UNAVAILABLE', async () => {
  const r = replay({ prover: () => false })
  const warned = []
  const svc = await at(() => client(r, { proofs: true, onWarning: (w) => warned.push(w) }).resolve(fx.name))
  assert.equal(svc.verified.holder, fx.holder)
  assert.deepEqual(svc.proofs.verified, [])
  assert.deepEqual(svc.proofs.unavailable.map((x) => x.read).sort(), ['cpuAt', 'fileInfo', 'isCPU', 'ownerOf'])
  assert.ok(warned.length === 4 && warned.every((w) => w.code === 'PROOF_UNAVAILABLE'))
  assert.match(svc.proofs.unavailable[0].reason, /no node served eth_getProof/)
  await assert.rejects(at(() => client(replay({ prover: () => false }), { proofs: 'strict' }).resolve(fx.name)), (e) => e.code === 'PROOF_UNAVAILABLE' && e.data.block === fx.block.number)
  // a client remembers the nodes that could not prove: the next resolution asks none of them / 客户端记住给不出证明的节点
  const r2 = replay({ prover: () => false })
  const api = client(r2, { proofs: true })
  await at(() => api.resolve(fx.name))
  const first = r2.log.filter((x) => x.method === 'eth_getProof').length
  await at(() => api.resolve(fx.name))
  assert.equal(r2.log.filter((x) => x.method === 'eth_getProof').length, first, 'no node asked again within PROVER_SKIP_MS')
})

test('FIXED PROOF-10: a served proof changed in one byte is PROOF_INVALID in strict mode, a warning with proofs: true; a stateRoot that is not the block\'s refuses every proof', async () => {
  const tamper = (a, address) => { if (address.toLowerCase() === '0xd006ffdd5ae313b17729621a00999cd3c71ce5e6') a.storageProof[2].proof[1] = flip(a.storageProof[2].proof[1], 40); return a }
  await assert.rejects(at(() => client(replay({ tamper }), { proofs: 'strict' }).resolve(fx.name)), (e) => e.code === 'PROOF_INVALID' && e.data.read === 'fileInfo' && /does not hash/.test(e.message))
  const warned = []
  const svc = await at(() => client(replay({ tamper }), { proofs: true, onWarning: (w) => warned.push(w) }).resolve(fx.name))
  assert.deepEqual(svc.proofs.invalid.map((x) => x.read), ['fileInfo'])
  assert.deepEqual(warned.map((w) => w.code), ['PROOF_INVALID'])
  // every node reports the same, wrong, stateRoot: the proofs do not verify against it / 所有节点报同一个错误的 stateRoot
  await assert.rejects(at(() => client(replay({ stateRoot: flip(fx.block.stateRoot, 5) }), { proofs: 'strict' }).resolve(fx.name)), code('PROOF_INVALID'))
  // one node reports another stateRoot for the same block hash: that is a disagreement, with proofs only
  // 某个节点对同一区块哈希报另一个 stateRoot：开启证明时是分歧；不开证明时与 1.2.0 相同，不看 stateRoot
  await assert.rejects(at(() => client(replay({ badRoot: flip(fx.block.stateRoot, 5) }), { proofs: 'strict' }).resolve(fx.name)), code('RPC_DISAGREE'))
  const plain = await at(() => client(replay({ badRoot: flip(fx.block.stateRoot, 5) })).resolve(fx.name))
  assert.equal(plain.proofs, undefined)
})

test('CONFIRMED PROOF-11: nodes that all collude on eth_call can hand a pinned client a forged manifest and holder; FIXED with proofs \'strict\' (the proven fileInfo and ownerOf disagree)', async () => {
  // The attacker's manifest: same container and circuit, its own signer and endpoint, a delegation it signs as the forged holder.
  // 攻击者的清单：同一容器与电路，自己的签名者与端点，以伪造的持有人身份签的委托。
  const ATTACKER = '0x' + '77'.repeat(32)
  const attacker = sig.privateKeyToAddress(ATTACKER)
  const read = fx.calls.find((c) => c.data.startsWith(abi.selector('read')))
  const real = JSON.parse(Buffer.from(abi.decodeReturn('read', read.result).slice(2), 'hex').toString('utf8'))
  const expires = fx.block.timestamp + 30 * 86400
  const forgedManifest = { ...real, signer: attacker, endpoints: { ...real.endpoints, live: ['https://evil.example/tapeapi/v1'] }, delegation: { expires, sig: sig.signDigest(sig.delegationDigest(56, '0xe61A9C7213a6Aa616C246a2B569e555B417b25ee', { container: fx.container, signer: attacker, expires }), ATTACKER) } }
  delete forgedManifest.contentSig
  const bytes = Buffer.from(JSON.stringify(forgedManifest))
  const sha = '0x' + Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex')
  const forge = (to, data) => {
    if (data.startsWith(abi.selector('fileInfo'))) return abi.encodeReturn('fileInfo', [BigInt(bytes.length), 'application/json', sha, 1n, 1n])
    if (data.startsWith(abi.selector('read'))) return abi.encodeReturn('read', ['0x' + bytes.toString('hex')])
    if (data.startsWith(abi.selector('ownerOf'))) return abi.encodeReturn('ownerOf', [attacker])
    return undefined
  }
  const fooled = await at(() => client(replay({ forge })).resolve(fx.name))
  assert.equal(fooled.verified.holder, attacker)
  assert.deepEqual(fooled.manifest.endpoints.live, ['https://evil.example/tapeapi/v1'])
  await assert.rejects(at(() => client(replay({ forge }), { proofs: 'strict' }).resolve(fx.name)), (e) => e.code === 'PROOF_INVALID' && e.data.read === 'fileInfo' && /proven/.test(e.message))
  // with the attacker's file but the real holder, the delegation check refuses already: no proof needed for a refusal
  // 文件是攻击者的而持有人是真的：委托核对已经拒绝，拒绝不需要证明
  const fileOnly = (to, data) => (data.startsWith(abi.selector('ownerOf')) ? undefined : forge(to, data))
  await assert.rejects(at(() => client(replay({ forge: fileOnly })).resolve(fx.name)), code('DELEGATION_INVALID'))
})

test('FIXED PROOF-12: proofs is off by default and needs pin; it adds no round, only the eth_getProof requests', async () => {
  const invalid = (re) => (e) => e instanceof TapeAPIError && e.code === 'INVALID_ARGUMENT' && re.test(e.message)
  assert.throws(() => createTapeAPI({ rpcUrls: RPC, proofs: true }), invalid(/proofs needs pin/))
  assert.throws(() => createTapeAPI({ rpcUrls: RPC, pin: false, proofs: 'strict' }), invalid(/proofs needs pin/))
  assert.throws(() => createTapeAPI({ rpcUrls: RPC, pin: true, proofs: 'yes' }), invalid(/proofs: pass true/))
  assert.throws(() => createTapeAPI({ rpcUrls: RPC, pin: true, proofs: true, chains: { 196: { pin: false } } }).forChain(196), invalid(/proofs needs pin/))
  createTapeAPI({ rpcUrls: RPC, pin: true, proofs: false })
  // Rounds: a round starts when nothing is in flight / 轮：没有请求在途时开始新一轮
  const metered = (r) => {
    const m = { rounds: 0, inflight: 0, requests: 0 }
    m.fetch = async (url, init) => { if (m.inflight++ === 0) m.rounds++; m.requests++; try { return await r.fetch(url, init) } finally { m.inflight-- } }
    return m
  }
  const off = replay(), mOff = metered(off)
  const plain = await at(() => createTapeAPI({ rpcUrls: RPC, quorum: 2, fetch: mOff.fetch, pin: true }).resolve(fx.name))
  assert.equal(plain.proofs, undefined)
  assert.equal(off.log.filter((x) => x.method === 'eth_getProof').length, 0, 'no proof is asked for by default')
  assert.ok(off.log.filter((x) => x.method === 'eth_getBlockByNumber').every((x) => x.params[0] === 'finalized'))
  const on = replay({ prover: () => true }), mOn = metered(on)
  await at(() => createTapeAPI({ rpcUrls: RPC, quorum: 2, fetch: mOn.fetch, pin: true, proofs: 'strict' }).resolve(fx.name))
  assert.ok(mOn.rounds <= mOff.rounds, `rounds ${mOn.rounds} with proofs, ${mOff.rounds} without`)
  assert.equal(mOn.requests - mOff.requests, 3, 'one eth_getProof per contract: factory, circuits, SiteRegistry')
  // the proof mode checks against the rpc layer's confirmedBlock stateRoot, which is opt-in there / stateRoot 在 rpc 层是可选的
  const rpc = createRpc({ urls: RPC, quorum: 2, fetch: replay().fetch })
  const b0 = await at(() => rpc.confirmedBlock('finalized'))
  assert.equal('stateRoot' in b0, false)
  assert.equal((await at(() => rpc.confirmedBlock('finalized', { stateRoot: true }))).stateRoot, fx.block.stateRoot)
})

// ---------------------------------------------------------------- independent review (PROOFR) ----
test('FIXED PROOFR-1: a node serving a bad proof no longer vetoes strict: the request moves on to the next node, the bad one is skipped, and a rate limit is not', async () => {
  // Node a serves a broken proof, node b an honest one. Before: a was asked first (proverLast was set before the check)
  // and every resolution failed PROOF_INVALID; the honest node was never asked. / a 给坏证明、b 诚实：修前 a 永远排第一，strict 永远失败。
  const r = replay({ prover: () => true, tamper: (a, _address, url) => { if (url === RPC[0]) a.accountProof[3] = flip(a.accountProof[3], 7); return a } })
  const api = client(r, { proofs: 'strict' })
  for (let i = 0; i < 2; i++) {
    const svc = await at(() => api.resolve(fx.name))
    assert.deepEqual(svc.proofs.verified.map((x) => x.read).sort(), ['cpuAt', 'fileInfo', 'isCPU', 'ownerOf'])
    assert.ok(svc.proofs.verified.every((x) => x.node === 'b.invalid'))
  }
  const asked = (log, url) => log.filter((x) => x.method === 'eth_getProof' && x.url === url).length
  const aFirst = asked(r.log, RPC[0])
  assert.ok(aFirst >= 1 && aFirst <= 3, 'a is asked only by the concurrent first requests, then skipped')
  assert.equal(asked(r.log, RPC[1]), 6, 'b serves every proof of both resolutions')
  // the same with proofs: true: nothing left to warn about / proofs: true 同样：没有可警告的
  const w = []
  const svc = await at(() => client(replay({ prover: () => true, tamper: (a, _x, url) => { if (url === RPC[0]) a.accountProof[3] = flip(a.accountProof[3], 7); return a } }), { proofs: true, onWarning: (x) => w.push(x) }).resolve(fx.name))
  assert.equal(svc.proofs.verified.length, 4)
  assert.deepEqual(svc.proofs.invalid, [])
  assert.equal(w.length, 0)
  // Every node serves a bad proof: only then is the read invalid (a warning with proofs: true) / 所有节点的证明都坏，才记为无效
  const bad = (a) => { a.accountProof[3] = flip(a.accountProof[3], 7); return a }
  await assert.rejects(at(() => client(replay({ prover: () => true, tamper: bad }), { proofs: 'strict' }).resolve(fx.name)), (e) => e.code === 'PROOF_INVALID' && /does not verify against stateRoot/.test(e.message))
  const allBad = await at(() => client(replay({ prover: () => true, tamper: bad }), { proofs: true }).resolve(fx.name))
  assert.deepEqual(allBad.proofs.invalid.map((x) => x.read).sort(), ['cpuAt', 'fileInfo', 'isCPU', 'ownerOf'])
  assert.deepEqual(new Set(allBad.proofs.invalid.flatMap((x) => x.node.split(', '))), new Set(['a.invalid', 'b.invalid']))
  // A rate limit (and a timeout, a broken connection) is not a refusal: the only prover is asked again next time.
  // 限流（以及超时、断连）不是拒绝：唯一的证明节点下次照常再问。
  let limited = true
  const rl = replay({ proverError: (url) => (url === RPC[1] && limited ? { code: 429, message: 'Too Many Requests' } : undefined) })
  const api2 = client(rl, { proofs: 'strict' })
  await assert.rejects(at(() => api2.resolve(fx.name)), code('PROOF_UNAVAILABLE'))
  limited = false
  const ok2 = await at(() => api2.resolve(fx.name))
  assert.equal(ok2.proofs.verified.length, 4, 'the node that was rate limited is asked again at once')
  // ...while a clear refusal is remembered: -32601 (PROOF-9), and -32005 unless it speaks of a rate limit
  // ……明确的拒绝才被记住：-32601（PROOF-9），以及措辞不是限流的 -32005
  for (const [pe, skipped] of [[{ code: -32005, message: 'eth_getProof is not available on this plan' }, true], [{ code: -32005, message: 'daily request count exceeded, request rate limited' }, false], [{ code: -32005, message: 'project ID request rate exceeded' }, false]]) {
    let on = true
    const rr = replay({ proverError: (url) => (url === RPC[1] && on ? pe : undefined) })
    const api3 = client(rr, { proofs: true })
    await at(() => api3.resolve(fx.name))
    on = false
    const again = await at(() => api3.resolve(fx.name))
    assert.equal(again.proofs.verified.length, skipped ? 0 : 4, pe.message)
  }
})

// The attacker's manifest of PROOF-11: every node forges fileInfo, read and ownerOf / PROOF-11 的攻击者清单：所有节点伪造
async function forgery() {
  const ATTACKER = '0x' + '77'.repeat(32)
  const attacker = sig.privateKeyToAddress(ATTACKER)
  const read = fx.calls.find((c) => c.data.startsWith(abi.selector('read')))
  const real = JSON.parse(Buffer.from(abi.decodeReturn('read', read.result).slice(2), 'hex').toString('utf8'))
  const expires = fx.block.timestamp + 30 * 86400
  const m = { ...real, signer: attacker, endpoints: { ...real.endpoints, live: ['https://evil.example/tapeapi/v1'] }, delegation: { expires, sig: sig.signDigest(sig.delegationDigest(56, '0xe61A9C7213a6Aa616C246a2B569e555B417b25ee', { container: fx.container, signer: attacker, expires }), ATTACKER) } }
  delete m.contentSig
  const bytes = Buffer.from(JSON.stringify(m))
  const sha = '0x' + Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex')
  return (to, data) => {
    if (data.startsWith(abi.selector('fileInfo'))) return abi.encodeReturn('fileInfo', [BigInt(bytes.length), 'application/json', sha, 1n, 1n])
    if (data.startsWith(abi.selector('read'))) return abi.encodeReturn('read', ['0x' + bytes.toString('hex')])
    if (data.startsWith(abi.selector('ownerOf'))) return abi.encodeReturn('ownerOf', [attacker])
    return undefined
  }
}

test('FIXED PROOFR-2: a verified proof that contradicts the quorum is refused with proofs: true as well (PROOF_INVALID); only a proof that cannot be had falls back', async () => {
  const forge = await forgery()
  // Before: proofs: true warned PROOF_INVALID twice and returned the attacker's holder and endpoint.
  // 修前：proofs: true 只警告两次 PROOF_INVALID，照样返回攻击者的持有人与端点。
  const w = []
  await assert.rejects(at(() => client(replay({ forge }), { proofs: true, onWarning: (x) => w.push(x) }).resolve(fx.name)),
    (e) => e.code === 'PROOF_INVALID' && e.data.read === 'fileInfo' && /differs from what the nodes answered/.test(e.message) && e.data.block === fx.block.number)
  // the circuit's proven owner slot differs from the nodes' ownerOf: refused at ownerOf with proofs: true too
  // 电路合约已证明的 owner 槽与节点的 ownerOf 不同：proofs: true 同样在 ownerOf 拒绝
  const CIRC = fx.getProof[1].address.toLowerCase()
  await assert.rejects(at(() => client(syntheticWorld((a, v) => { if (a === CIRC) for (const [k, x] of v) v.set(k, x ^ 1n) }), { proofs: true }).resolve(fx.name)), (e) => e.code === 'PROOF_INVALID' && e.data.read === 'ownerOf')
  // a proof that cannot be had still falls back with proofs: true (PROOF-9), and a forged answer then goes through, as
  // without proofs: detection only / 拿不到证明时 proofs: true 仍回退（PROOF-9），伪造的回答此时照样通过：只是检测
  const w2 = []
  const fooled = await at(() => client(replay({ forge, prover: () => false }), { proofs: true, onWarning: (x) => w2.push(x) }).resolve(fx.name))
  assert.deepEqual(fooled.manifest.endpoints.live, ['https://evil.example/tapeapi/v1'])
  assert.ok(w2.length > 0 && w2.every((x) => x.code === 'PROOF_UNAVAILABLE'))
})

test('FIXED PROOFR-3: RLP nesting is bounded (RLP_MAX_DEPTH = 64), and the public proof functions throw PROOF_INVALID and nothing else', () => {
  // `depth` lists around an empty list, canonical: every header is computed from the inside out, then written once
  // `depth` 层列表包着一个空列表，规范编码：先由内向外算出每层的头，再一次写出
  const nest = (depth) => {
    const head = (len) => { if (len < 56) return [0xc0 + len]; const lb = []; for (let x = len; x > 0; x = Math.floor(x / 256)) lb.unshift(x & 255); return [0xf7 + lb.length, ...lb] }
    const heads = []; let len = 1
    for (let i = 0; i < depth; i++) { const h = head(len); heads.push(h); len += h.length }
    const out = new Uint8Array(len); let p = 0
    for (let i = depth - 1; i >= 0; i--) { out.set(heads[i], p); p += heads[i].length }
    out[p] = 0xc0
    return out
  }
  assert.equal(proof.RLP_MAX_DEPTH, 64)
  let d = rlpDecode(nest(63)), depth = 0
  while (Array.isArray(d) && d.length) { d = d[0]; depth++ }
  assert.equal(depth, 63)
  assert.throws(() => rlpDecode(nest(64)), (e) => e.code === 'PROOF_INVALID' && /nested more than 64/.test(e.message))
  // Before: about 20 000 levels threw a bare RangeError (the stack) / 修前：约 2 万层抛出裸 RangeError
  assert.throws(() => rlpDecode(nest(20000)), code('PROOF_INVALID'))
  const root = fx.block.stateRoot, key = '0x' + '11'.repeat(32)
  for (const [what, f] of [
    ['a number as a node', () => verifyMptProof(root, key, [123], { secure: true })],
    ['null as a node', () => verifyMptProof(root, key, [null], { secure: true })],
    ['a number as the key', () => verifyMptProof(root, 5, [])],
    ['null options', () => verifyMptProof(root, key, [], null)],
    ['a string for secure', () => verifyMptProof(root, key, [], { secure: 'yes' })],
    ['a string for bytes', () => rlpDecode('0xc0')],
    ['slots that are not a list', () => verifyAccountProof(root, fx.getProof[0].address, 5, fx.getProof[0].answer)],
    ['a slot that is not a number', () => verifyAccountProof(root, fx.getProof[0].address, ['zz'], fx.getProof[0].answer)],
    ['an address that is a number', () => verifyAccountProof(root, 5, [], fx.getProof[0].answer)],
  ]) assert.throws(f, code('PROOF_INVALID'), what)
  // verify.py has the same bound (its own check, run by PROOF-7) / verify.py 有同样的上限
  assert.match(readFileSync(new URL('../../spec/vectors/verify.py', import.meta.url), 'utf8'), /RLP_MAX_DEPTH = 64/)
})

// A synthetic state (the attacker's own trie under a stateRoot every node reports, i.e. operators that all collude on
// the header): the real proven values, with `mutate` applied. / 合成状态：所有运营方在区块头上合谋时的攻击者自有树。
function syntheticWorld(mutate) {
  const hexb = (h) => Uint8Array.from(Buffer.from(h.slice(2), 'hex'))
  const word = (n) => { const b = new Uint8Array(32); let x = BigInt(n); for (let i = 31; i >= 0; i--) { b[i] = Number(x & 255n); x >>= 8n } return b }
  const trim = (n) => { let x = BigInt(n); const out = []; while (x > 0n) { out.unshift(Number(x & 255n)); x >>= 8n } return Uint8Array.from(out) }
  const accs = fx.getProof.map((g) => {
    const vals = new Map(verifyAccountProof(fx.block.stateRoot, g.address, g.slots, g.answer).values)
    mutate(g.address.toLowerCase(), vals)
    return { g, vals, st: buildTrie([...vals].filter(([, v]) => v > 0n).map(([k, v]) => [word(k), rlpEncode(trim(v))]), { secure: true }) }
  })
  const state = buildTrie(accs.map(({ g, st }) => [hexb(g.address), rlpEncode([new Uint8Array(0), trim(1), hexb(st.root), hexb(proof.EMPTY_CODE_HASH)])]), { secure: true })
  const answers = new Map(accs.map(({ g, vals, st }) => [g.address.toLowerCase(), {
    address: g.address.toLowerCase(), balance: '0x1', codeHash: proof.EMPTY_CODE_HASH, nonce: '0x0', storageHash: st.root, accountProof: state.proof(hexb(g.address)),
    storageProof: g.slots.map((s) => ({ key: s, value: '0x' + (vals.get(BigInt(s)) ?? 0n).toString(16), proof: st.proof(word(BigInt(s))) })),
  }]))
  return replay({ stateRoot: state.root, prover: () => true, tamper: (_a, address) => answers.get(address.toLowerCase()) })
}

test('FIXED PROOFR-4: an implementation slot whose high 12 bytes are not zero is not an address: its layout is unknown (PROOF_UNAVAILABLE), as cpuAt and ownerOf already required', async () => {
  const known = LAYOUT_OF_SITE()
  assert.equal(addressOfWord(BigInt(known)), known)
  assert.equal(addressOfWord((1n << 160n) | BigInt(known)), null)
  assert.equal(addressOfWord((0xffn << 200n) | BigInt(known)), null)
  assert.equal(addressOfWord('0x' + '00'.repeat(12) + known.slice(2)), known)
  const IMPL = BigInt(IMPL_SLOT), SITE = '0xd006ffdd5ae313b17729621a00999cd3c71ce5e6'
  // control: the same values in the synthetic trie verify / 对照：同样的值在合成树里核验通过
  const control = await at(() => client(syntheticWorld(() => {}), { proofs: 'strict' }).resolve(fx.name))
  assert.equal(control.proofs.verified.length, 4)
  // Before: 0xff..ff << 200 | a known implementation was read by its low 20 bytes and the layout used.
  // 修前：高字节是垃圾、低 20 字节是已知实现，照样套用布局。
  const garbage = () => syntheticWorld((a, v) => { if (a === SITE) v.set(IMPL, (0xffn << 200n) | v.get(IMPL)) })
  await assert.rejects(at(() => client(garbage(), { proofs: 'strict' }).resolve(fx.name)), (e) => e.code === 'PROOF_UNAVAILABLE' && e.data.read === 'fileInfo' && /not an address/.test(e.message))
  const warned = await at(() => client(garbage(), { proofs: true }).resolve(fx.name))
  assert.deepEqual(warned.proofs.unavailable.map((x) => x.read), ['fileInfo'])
})
const LAYOUT_OF_SITE = () => proof.LAYOUT_IMPLEMENTATIONS.siteRegistry[0]

test('FIXED PROOFR-5: a confirming node that leaves the stateRoot out is not counted either way, on both paths of confirmedBlock; one that misreports it is still RPC_DISAGREE', async () => {
  const N = ['https://a.invalid', 'https://b.invalid', 'https://c.invalid']
  const B = fx.block, other = flip(B.stateRoot, 3)
  const blk = (number, root) => ({ number: '0x' + number.toString(16), hash: number === B.number ? B.hash : '0x' + number.toString(16).padStart(64, '0'), timestamp: '0x' + B.timestamp.toString(16), parentHash: '0x' + '00'.repeat(32), ...(root === undefined ? {} : { stateRoot: root }) })
  // `tagAt(url)`: the number a node gives for the tag; `rootOf(url, second)`: its stateRoot on the first (tag) or second
  // (number) round. / `tagAt`：节点对标签给的块号；`rootOf`：它在第一轮（标签）或第二轮（块号）给的 stateRoot。
  const rpcOf = (urls, tagAt, rootOf) => createRpc({ urls, quorum: 2, quiet: true, fetch: async (url, init) => {
    const q = JSON.parse(init.body)
    const second = q.params[0] !== 'finalized'
    const n = second ? Number(BigInt(q.params[0])) : tagAt(url)
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: q.id, result: blk(n, n === B.number ? rootOf(url, second) : '0x' + '22'.repeat(32)) }), { status: 200, headers: { 'content-type': 'application/json' } })
  } })
  const same = () => B.number
  const ahead = (url) => (url === N[0] ? B.number + 2 : B.number)   // a is ahead: the second path / a 领先：走第二条路径
  const omit = (who) => (url) => (url === who ? undefined : B.stateRoot)
  // First path (one round): before, one of three leaving it out made stateRoot undefined (every proof unavailable).
  // 第一条路径：修前三个节点中一个省略，stateRoot 就是 undefined（全部证明不可用）。
  assert.equal((await rpcOf(N, same, omit(N[0])).confirmedBlock('finalized', { stateRoot: true })).stateRoot, B.stateRoot)
  assert.equal((await rpcOf(N, same, omit(N[2])).confirmedBlock('finalized', { stateRoot: true })).stateRoot, B.stateRoot)
  // Second path: before, the node without it fell in another bucket and the block was RPC_DISAGREE.
  // 第二条路径：修前省略的节点落进另一个桶，区块成了 RPC_DISAGREE。
  const b2 = await rpcOf(N, ahead, (url, second) => (second && url === N[1] ? undefined : B.stateRoot)).confirmedBlock('finalized', { stateRoot: true })
  assert.equal(b2.number, B.number)
  assert.equal(b2.stateRoot, B.stateRoot)
  // Too few operators gave it: undefined on both paths (PROOF_UNAVAILABLE for the proofs), never a disagreement
  // 给出的运营方太少：两条路径都是 undefined（证明不可用），绝不是分歧
  assert.equal((await rpcOf(N.slice(0, 2), same, omit(N[1])).confirmedBlock('finalized', { stateRoot: true })).stateRoot, undefined)
  assert.equal((await rpcOf(N, ahead, (url, second) => (second && url !== N[0] ? undefined : B.stateRoot)).confirmedBlock('finalized', { stateRoot: true })).stateRoot, undefined)
  // A node that misreports it: RPC_DISAGREE on both paths (kept: it fails safe) / 谎报：两条路径都 RPC_DISAGREE（保留，安全失败）
  await assert.rejects(rpcOf(N, same, (url) => (url === N[2] ? other : B.stateRoot)).confirmedBlock('finalized', { stateRoot: true }), (e) => e.code === 'RPC_DISAGREE' && /stateRoots/.test(e.message))
  await assert.rejects(rpcOf(N, ahead, (url, second) => (second && url === N[2] ? other : B.stateRoot)).confirmedBlock('finalized', { stateRoot: true }), (e) => e.code === 'RPC_DISAGREE' && /stateRoots/.test(e.message))
  // Without { stateRoot: true } nothing changed: no stateRoot field, and an omitted or wrong one is never looked at
  // 不传 { stateRoot: true } 时不变：没有 stateRoot 字段，省略或错误的都不看
  for (const tagAt of [same, ahead]) {
    const plain = await rpcOf(N, tagAt, (url) => (url === N[2] ? other : url === N[1] ? undefined : B.stateRoot)).confirmedBlock('finalized')
    assert.equal(plain.number, B.number)
    assert.equal('stateRoot' in plain, false)
  }
  // Resolve: one of three nodes leaves the stateRoot out; strict proves everything / 解析：三个节点中一个省略，strict 全部证明
  const r = replay({ rootOf: (url) => (url === RPC[0] ? undefined : B.stateRoot) })
  const svc = await at(() => createTapeAPI({ rpcUrls: [...RPC, 'https://c.invalid'], quorum: 2, fetch: r.fetch, pin: true, proofs: 'strict', onWarning: () => {} }).resolve(fx.name))
  assert.equal(svc.proofs.verified.length, 4)
  // two nodes, one without it: not enough operators, so the proofs are unavailable (never RPC_DISAGREE)
  // 两个节点、一个省略：运营方不够，证明不可用（绝不是 RPC_DISAGREE）
  await assert.rejects(at(() => client(replay({ rootOf: (url) => (url === RPC[0] ? undefined : B.stateRoot) }), { proofs: 'strict' }).resolve(fx.name)), (e) => e.code === 'PROOF_UNAVAILABLE' && /did not agree on a stateRoot/.test(e.message))
})

