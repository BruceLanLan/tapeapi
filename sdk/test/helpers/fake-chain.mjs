// 进程内假链：按 selector 解码 eth_call / In-process fake chain answering eth_call by selector.
import { sha256 } from '@noble/hashes/sha256'
import { functionBySelector, decodeCall, encodeReturn, eqAddr, ZERO_ADDRESS, labelToBytes32, toHex, utf8ToBytes, decodeParams, encodeParams, hexToBytes, bytesToHex } from '../../src/abi.js'
import { CHAINS, IMPL_SLOT } from '../../src/chains.js'

export const ZERO_HASH = '0x' + '00'.repeat(32)

export const ADDR = {
  hub: '0x' + '10'.repeat(20), siteRegistry: '0x' + '20'.repeat(20), directory: '0x' + '30'.repeat(20),
  escrow: '0x' + '40'.repeat(20), circuits: '0x' + '50'.repeat(20), container: '0x' + '60'.repeat(20),
  treasury: '0x' + '70'.repeat(20),
  factory: '0x' + '80'.repeat(20),   // processor factory: isCPU(circuits) / 处理器工厂
}
// The mainnet factory (MAINNET.factory) also answers, so a client built without `factory` works as on chain 56;
// any other address has no code: eth_call returns '0x', as a real node does (review R2-6).
// 主网工厂地址同样作答，未传 `factory` 的客户端与主网一致；其它地址没有代码，eth_call 返回 '0x'，与真实节点相同。
export const MAINNET_FACTORY = '0x68224F668083c29e9800Be2a646d42d18cedF7e2'

// A JSON-RPC batch handed to a fetch that only understands one call: ask it call by call and answer the batch as a
// node would (an array; a call refused at the HTTP level refuses the whole batch). For tests whose fetch wrappers
// inject a fault per call. / 把批量请求拆给只懂单个调用的 fetch，逐个问、像节点那样以数组作答；供按调用注入故障的测试包装使用。
export async function eachCall(url, init, fetchOne) {
  const answers = await Promise.all(JSON.parse(init.body).map((req) => fetchOne(url, { ...init, body: JSON.stringify(req) })))
  const bad = answers.find((r) => !r.ok)
  if (bad) return bad
  return new Response(JSON.stringify(await Promise.all(answers.map((r) => r.json()))), { status: 200, headers: { 'content-type': 'application/json' } })
}

export function createFakeChain({ addr = ADDR, chainId = 56 } = {}) {
  const st = {
    block: 62_000_000, owners: new Map(), accounts: new Map(), tokens: new Map(), hubKeys: new Map(), labels: new Map(), services: new Map(), files: new Map(),
    // escrow v2 state is per (consumer, provider) channel; `balances` is the ERC-20 (BEM) balance of an address
    // 托管 v2 状态按 (消费者, 提供者) 通道；`balances` 是某地址的 ERC-20（BEM）余额
    balances: new Map(), channels: new Map(), claimed: new Map(), sessions: new Map(), pendingWithdraws: new Map(), calls: [],
    contributions: new Map(), legacyEscrows: new Set(), // provider -> bps; escrows that predate contributionOf / 旧版托管
    // 节点故障注入 / per-node fault injection: url -> 'disagree' | 'timeout' | 'http500' | 'rpcerror' | 'nologs'
    //   | 'history:N' (eth_getLogs only for the last N blocks, as publicnode: arch A4 / 只提供最近 N 个区块的日志)
    faults: new Map(),
    notCPU: new Set(),  // circuits contracts the factory does not know (counterfeits) / 工厂不认识的电路合约（仿冒）
    codes: new Set(),   // addresses that have code (an opened container), besides contract holders / 有代码的地址（已开通的容器）
    contractHolders: new Map(),  // address -> Set of digests it accepts under EIP-1271 / 按 EIP-1271 认可的摘要
    logs: [],   // ChannelBus Wire logs: { address, topics, data, blockNumber, logIndex } / ChannelBus 日志
    // Security 1.1: blocks and storage. Block n has a hash derived from n (a node with the 'fork' fault reports another),
    // and a timestamp headTime − (head − n) (headTime: the test's value, or Date.now in seconds). finalized is head − 2 and
    // safe head − 40 unless tagLags says otherwise for a node. Storage: ERC-1967 implementation slots answer chains.js
    // expectedImpl for this chain's proxies unless set. `reads` logs the block parameter of every state read.
    // 安全加固 1.1：区块与存储。块 n 的哈希由 n 推出（带 'fork' 故障的节点报另一个），时间戳为 headTime − (head − n)。
    // finalized 为 head − 2、safe 为 head − 40，除非 tagLags 为某节点另设。存储：本链代理的实现槽默认答 expectedImpl。
    headTime: null, tagLags: new Map(), storage: new Map(), reads: [],
  }
  const k2 = (a, b) => `${a.toLowerCase()}:${b.toLowerCase()}`
  // Files are stored under the bare registry key, as every TapeKit uploader does (SPEC §6 step 3), but LOOKED UP
  // with the exact string the SDK sent: a leading slash must miss, exactly like mainnet (fixtures/mainnet-4246-index.json).
  // 文件按裸键存（与 TapeKit 上传工具一致），但按 SDK 发来的原样字符串查：带前导斜杠必须查不到，和主网一致。
  const fileKey = (c, path) => k2(c, path.replace(/^\/+/, ''))
  const k3 = (a, b, c) => `${a.toLowerCase()}:${b.toLowerCase()}:${c.toLowerCase()}`
  const api = {
    state: st, addr,
    setOwner(tokenId, owner) { st.owners.set(String(tokenId), owner) },
    // TAP-10 keys as the DeWebHub serves them. `usable: false` models a revoked key or a circuit that changed
    // hands: the hub then zeroes key, suite, index and chains, exactly as DeWebHub.keyFor does on mainnet.
    // hub 所提供的 TAP-10 密钥。`usable: false` 模拟已撤销的密钥或已易主的电路：此时 hub 把密钥、套件、序号、
    // 收信链全部置零，与主网 DeWebHub.keyFor 的行为一致。
    setTapeSendKey(container, { circuits = addr.circuits, tokenId, key, usable = true, suite = 1, holder = ZERO_ADDRESS, keyIndex = 0, version = 1, chainId: cid = chainId } = {}) {
      st.tokens.set(container.toLowerCase(), [BigInt(cid), circuits, BigInt(tokenId)])
      st.hubKeys.set(`${circuits.toLowerCase()}:${BigInt(tokenId)}`, { container, key, usable, suite, holder, keyIndex, version })
    },
    setAccount(tokenId, container) { st.accounts.set(String(tokenId), container) },
    // ERC-6551 token() of a container: which circuit it belongs to / 容器的 token()：它属于哪个电路
    setContainerToken(container, { circuits = addr.circuits, tokenId, chainId: cid = chainId } = {}) {
      st.tokens.set(container.toLowerCase(), [BigInt(cid), circuits, BigInt(tokenId)])
    },
    register({ label, container, circuits = addr.circuits, tokenId, manifestPath = '/.well-known/tapeapi.json' }) {
      if (label) st.labels.set(labelToBytes32(label), container)
      st.services.set(container.toLowerCase(), { circuits, tokenId: BigInt(tokenId), container, label: label ? labelToBytes32(label) : '0x' + '00'.repeat(32), manifestPath, updatedAt: 1n })
    },
    // 文件 = 字节 + 真实 fileInfo（size / sha256 / contentType / updatedAt / chunkCount），模拟 SiteRegistry 的索引与内容两张表。
    // A file is bytes plus a genuine fileInfo record: the fake keeps the SiteRegistry's index and its content
    // separately so tests can make them disagree, exactly the failure TAPI-20 §3.2 is meant to catch.
    writeFile(container, path, content, { contentType = 'application/json', updatedAt = 1n } = {}) {
      const bytes = typeof content === 'string' ? utf8ToBytes(content) : content
      st.files.set(fileKey(container, path), {
        bytes, info: { size: BigInt(bytes.length), contentType, sha256Hash: toHex(sha256(bytes)), updatedAt: BigInt(updatedAt), chunkCount: BigInt(Math.max(1, Math.ceil(bytes.length / 24_000))) },
      })
    },
    // 只改索引不改字节（伪造 size / sha256Hash）/ Override the index record without touching the bytes.
    setFileInfo(container, path, overrides) {
      const f = st.files.get(fileKey(container, path)); if (!f) throw new Error('setFileInfo: no such file')
      for (const [k, v] of Object.entries(overrides)) f.info[k] = (k === 'size' || k === 'updatedAt' || k === 'chunkCount') ? BigInt(v) : v
    },
    // 只改字节不改索引（模拟 SiteRegistry 分块拼装出错）/ Replace the bytes but keep the index: a mis-assembled read.
    // content === null 让 read() 回滚而 fileInfo 照旧 / content === null makes read() revert while fileInfo still answers
    setFileBytes(container, path, content) {
      const f = st.files.get(fileKey(container, path)); if (!f) throw new Error('setFileBytes: no such file')
      f.bytes = content === null ? null : (typeof content === 'string' ? utf8ToBytes(content) : content)
    },
    setBalance(a, v) { st.balances.set(a.toLowerCase(), BigInt(v)) },            // ERC-20 balanceOf(a) / 代币余额
    setChannel(c, p, v) { st.channels.set(k2(c, p), BigInt(v)) },                 // escrow.channelOf(c, p)
    setClaimed(c, p, v) { st.claimed.set(k2(c, p), BigInt(v)) },
    setSession(c, p, key, exp) { st.sessions.set(k3(c, p, key), BigInt(exp)) },   // escrow.sessionExpiry(c, p, key)
    setPendingWithdraw(c, p, amount, requestedAt) { st.pendingWithdraws.set(k2(c, p), [BigInt(amount), BigInt(requestedAt)]) },
    setContribution(p, bps) { st.contributions.set(p.toLowerCase(), BigInt(bps)) },
    // A smart-account holder (a Safe): it has code, and answers EIP-1271 for the digests it accepts.
    // 智能账户持有人（如 Safe）：有代码，并对它认可的摘要按 EIP-1271 作答。
    /** mark a circuits contract as NOT a TapeOut processor / 标记为非 TapeOut 处理器 */
    setCounterfeit(circuits, yes = true) { if (yes) st.notCPU.add(circuits.toLowerCase()); else st.notCPU.delete(circuits.toLowerCase()) },
    setContractHolder(address, ...digests) {
      const key = address.toLowerCase()
      const set = st.contractHolders.get(key) || new Set()
      for (const d of digests) set.add(toHex(d).toLowerCase())
      st.contractHolders.set(key, set)
    },
    // 该地址上的 contributionOf/treasury 调用会 revert / contributionOf & treasury revert at this escrow address.
    markLegacyEscrow(a) { st.legacyEscrows.add(a.toLowerCase()) },
    // An address with code, as an opened (deployed) container has. / 有代码的地址，如已开通（已部署）的容器。
    setCode(address, yes = true) { if (yes) st.codes.add(address.toLowerCase()); else st.codes.delete(address.toLowerCase()) },
    setFault(url, kind) { if (kind) st.faults.set(url, kind); else st.faults.delete(url) },
    /** a node's own lag behind head for a tag: setTagLag('http://rpc3', 'finalized', 5000) / 某节点某标签落后 head 的块数 */
    setTagLag(url, tag, lag) { st.tagLags.set(`${url}:${tag}`, lag) },
    setStorage(address, slot, word) { st.storage.set(`${address.toLowerCase()}:${slot.toLowerCase()}`, word) },
    setImplementation(proxy, impl) { api.setStorage(proxy, IMPL_SLOT, '0x' + '00'.repeat(12) + impl.slice(2).toLowerCase()) },
    blockHash: (n, url) => blockOf(n, url).hash,
  }
  const headTime = () => st.headTime ?? Math.floor(Date.now() / 1000)
  function blockOf(n, url) {
    const fork = st.faults.get(url) === 'fork'
    return { number: '0x' + n.toString(16), hash: '0x' + (fork ? 'f0' : 'b1') + n.toString(16).padStart(62, '0'), parentHash: '0x' + 'b1' + (n - 1).toString(16).padStart(62, '0'), timestamp: '0x' + (headTime() - (st.block - n)).toString(16), miner: url }
  }
  function storageAt(address, slot) {
    const set = st.storage.get(`${String(address).toLowerCase()}:${String(slot).toLowerCase()}`)
    if (set) return set
    const allowed = String(slot).toLowerCase() === IMPL_SLOT ? CHAINS[chainId]?.expectedImpl?.[String(address).toLowerCase()] : null
    return '0x' + '00'.repeat(12) + (allowed ? allowed[0].slice(2) : '00'.repeat(20))
  }
  function ethCall(to, data) {
    // EIP-1271: a contract holder accepts exactly the digests it was given / 合约持有人只认可给定的摘要
    if (data.startsWith('0x1626ba7e')) {
      const set = st.contractHolders.get(to.toLowerCase())
      const digest = '0x' + data.slice(10, 74)
      if (!set) throw Object.assign(new Error('execution reverted'), { code: 3 })
      return set.has(digest.toLowerCase()) ? IS_VALID_SIG + '0'.repeat(56) : '0x' + '00'.repeat(32)
    }
    const name = functionBySelector(data)
    if (!name) throw Object.assign(new Error('execution reverted'), { code: 3 })
    const args = decodeCall(name, data)
    st.calls.push({ to, name, args: Array.from(args) })
    switch (name) {
      case 'accountOf': return encodeReturn('accountOf', [st.accounts.get(String(args[1])) || ZERO_ADDRESS])
      // Processor number 7 is the test circuits contract; any other number is past the end and reverts, like the factory.
      // 处理器 7 号是测试电路合约；其他编号超出范围，像工厂一样 revert。
      case 'cpuAt': if (args[0] === 7n) return encodeReturn('cpuAt', [addr.circuits]); throw Object.assign(new Error('execution reverted'), { code: 3 })
      case 'isCPU':
        if (!eqAddr(to, addr.factory ?? ADDR.factory) && !eqAddr(to, MAINNET_FACTORY)) return '0x'
        return encodeReturn('isCPU', [!st.notCPU.has(String(args[0]).toLowerCase())])
      case 'token': {
        const t = st.tokens.get(to.toLowerCase())
        if (!t) throw Object.assign(new Error('execution reverted'), { code: 3 })
        return encodeReturn('token', t)
      }
      case 'keyFor': {
        const r = st.hubKeys.get(`${String(args[0]).toLowerCase()}:${BigInt(args[1])}`)
        const zero = '0x' + '00'.repeat(32)
        if (!r) return encodeReturn('keyFor', [ZERO_ADDRESS, zero, false, ZERO_ADDRESS, 0n, 0n, zero, false, 0n, 0n])
        const ep = '0x' + '00'.repeat(4) + BigInt(chainId).toString(16).padStart(16, '0') + r.container.slice(2).toLowerCase()
        return encodeReturn('keyFor', r.usable
          ? [r.container, ep, true, r.holder, BigInt(r.suite), BigInt(r.keyIndex), r.key, true, BigInt(r.version), 7n]
          : [r.container, ep, true, r.holder, 0n, 0n, zero, false, BigInt(r.version), 0n])
      }
      case 'ownerOf': { const o = st.owners.get(String(args[0])); if (!o) throw Object.assign(new Error('execution reverted: nonexistent token'), { code: 3 }); return encodeReturn('ownerOf', [o]) }
      case 'resolve': return encodeReturn('resolve', [st.labels.get(args[0].toLowerCase()) || ZERO_ADDRESS])
      case 'serviceOf': return encodeReturn('serviceOf', [st.services.get(args[0].toLowerCase()) || { circuits: ZERO_ADDRESS, tokenId: 0n, container: ZERO_ADDRESS, label: '0x' + '00'.repeat(32), manifestPath: '', updatedAt: 0n }])
      // 与主网一致：缺失文件 read() 回滚（自定义错误 0x2a9df442），fileInfo 返回全零 / like mainnet: read() of a missing
      // file reverts with custom error 0x2a9df442, fileInfo returns zeros
      case 'read': {
        const bytes = st.files.get(k2(args[0], args[1]))?.bytes
        if (!bytes) throw Object.assign(new Error('execution reverted: 0x2a9df442'), { code: 3 })
        return encodeReturn('read', [toHex(bytes)])
      }
      case 'fileInfo': {
        const f = st.files.get(k2(args[0], args[1]))
        const i = f ? f.info : { size: 0n, contentType: '', sha256Hash: ZERO_HASH, updatedAt: 0n, chunkCount: 0n }
        return encodeReturn('fileInfo', [i.size, i.contentType, i.sha256Hash, i.updatedAt, i.chunkCount])
      }
      case 'balanceOf': return encodeReturn('balanceOf', [st.balances.get(args[0].toLowerCase()) ?? 0n])
      case 'channelOf': return encodeReturn('channelOf', [st.channels.get(k2(args[0], args[1])) ?? 0n])
      case 'claimedOf': return encodeReturn('claimedOf', [st.claimed.get(k2(args[0], args[1])) ?? 0n])
      case 'sessionExpiry': return encodeReturn('sessionExpiry', [st.sessions.get(k3(args[0], args[1], args[2])) ?? 0n])
      case 'pendingWithdraw':
        if (st.legacyEscrows.has(to.toLowerCase())) throw Object.assign(new Error('execution reverted'), { code: 3 })
        return encodeReturn('pendingWithdraw', st.pendingWithdraws.get(k2(args[0], args[1])) ?? [0n, 0n])
      case 'contributionOf':
        if (st.legacyEscrows.has(to.toLowerCase())) throw Object.assign(new Error('execution reverted'), { code: 3 })
        return encodeReturn('contributionOf', [st.contributions.get(args[0].toLowerCase()) ?? 0n])
      case 'treasury':
        if (st.legacyEscrows.has(to.toLowerCase())) throw Object.assign(new Error('execution reverted'), { code: 3 })
        return encodeReturn('treasury', [addr.treasury])
      default: throw Object.assign(new Error('execution reverted'), { code: 3 })
    }
  }
  const IS_VALID_SIG = '0x1626ba7e'
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } })
  // 假 fetch，只处理 JSON-RPC / Fake fetch handling JSON-RPC only.
  // A JSON-RPC batch (an array body) is answered with an array, one answer per call, faults applied per call, like the
  // default nodes (all of them take a batch of up to 3, measured 2026-09-29). 'nobatch' makes a node answer a batch as one
  // -32600 object, as a node without batch support does. Every request (plain or batch) is logged in `st.requests`.
  // 批量请求（数组）以数组作答，每个调用一个回答，故障按调用施加，与默认节点一致。'nobatch' 让节点像不支持批量的节点那样
  // 以单个 -32600 对象回答批量。每个请求（普通或批量）记在 `st.requests`。
  st.requests = []
  api.fetch = async (url, init = {}) => {
    const fault = st.faults.get(url)
    const body = JSON.parse(init.body)
    st.requests.push({ url, batch: Array.isArray(body), calls: (Array.isArray(body) ? body : [body]).map((r) => r?.method) })
    if (fault === 'timeout') return new Promise((_, rej) => init.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
    if (fault === 'http500') return new Response('boom', { status: 500 })
    if (Array.isArray(body)) {
      if (fault === 'nobatch') return json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } })
      const answers = await Promise.all(body.map((req) => answer(url, fault, req)))
      // a call refused at the HTTP level refuses the whole batch / 某个调用在 HTTP 层被拒，整批被拒
      const bad = answers.find((r) => !r.ok)
      if (bad) return bad
      return json(await Promise.all(answers.map((r) => r.json())))
    }
    return answer(url, fault, body)
  }
  async function answer(url, fault, req) {
    const reply = (result) => json({ jsonrpc: '2.0', id: req.id, result })
    if (fault === 'rpcerror') return json({ jsonrpc: '2.0', id: req.id, error: { code: -32000, message: 'node says no' } })
    const blockArg = { eth_call: 1, eth_getCode: 1, eth_getStorageAt: 2 }[req.method]
    if (blockArg !== undefined) st.reads.push({ url, method: req.method, block: req.params?.[blockArg] ?? 'latest', fn: req.method === 'eth_call' ? functionBySelector(req.params[0].data) : null })
    // 'lag:N': the node's head is N blocks behind (security 1.1, review SECR-3): its tags are N blocks lower, a block above
    // its head is null, and a state read at such a block (EIP-1898 blockHash or number) is geth's "header not found".
    // 'lag:N'：节点的 head 落后 N 块：标签低 N 块，高于其 head 的区块为 null，在这样的区块上的状态读取答 geth 的 "header not found"。
    const lagging = /^lag:(\d+)$/.exec(fault ?? '')
    const head = st.block - (lagging ? Number(lagging[1]) : 0)
    if (lagging && blockArg !== undefined) {
      const b = req.params?.[blockArg]
      const n = b && typeof b === 'object' ? (b.blockHash ? parseInt(b.blockHash.slice(4), 16) : Number(BigInt(b.blockNumber))) : (/^0x[0-9a-f]+$/i.test(String(b)) ? Number(BigInt(b)) : null)
      if (n !== null && n > head) return json({ jsonrpc: '2.0', id: req.id, error: { code: -32000, message: b?.blockHash ? `header for hash ${b.blockHash} not found` : 'header not found' } })
    }
    try {
      switch (req.method) {
        case 'eth_getBlockByNumber': {
          const tag = req.params[0]
          const lag = { latest: 0, finalized: 2, safe: 40 }
          const n = tag in lag ? head - (st.tagLags.get(`${url}:${tag}`) ?? lag[tag]) : Number(BigInt(tag))
          return reply(n > head ? null : blockOf(n, url))
        }
        case 'eth_getStorageAt':
          if (fault === 'nostorage') return json({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'the method eth_getStorageAt does not exist' } })
          return reply(storageAt(req.params[0], req.params[1]))
        case 'eth_chainId': return reply('0x' + chainId.toString(16))
        case 'eth_blockNumber': return reply('0x' + (st.block + (fault === 'disagree' ? 7 : 0)).toString(16))
        case 'eth_call': {
          const out = ethCall(req.params[0].to, req.params[0].data)
          return reply(fault === 'disagree' ? out.replace(/.$/, (c) => (c === '0' ? '1' : '0')) : out)
        }
        case 'eth_getCode':
          return reply(st.contractHolders.has(String(req.params[0]).toLowerCase()) || st.codes.has(String(req.params[0]).toLowerCase()) ? '0x60006000fd' : '0x')
        case 'eth_getLogs': {
          // the BNB Chain dataseed nodes answer every other method but refuse eth_getLogs for any range
          // BNB 链的 dataseed 节点其它方法都答，唯独对任何区间的 eth_getLogs 报错
          if (fault === 'nologs') return json({ jsonrpc: '2.0', id: req.id, error: { code: -32000, message: 'limit exceeded' } })
          const f = req.params[0]
          const lo = Number(BigInt(f.fromBlock)), hi = Number(BigInt(f.toBlock))
          // publicnode's exact answer beyond its window: HTTP 403 with the JSON-RPC error in the body (recorded
          // 2026-09-25, fixtures/bsc-getlogs-answers.json; review R4-1) / publicnode 超出其窗口时的原样回答：HTTP 403，错误在响应体里
          const keep = /^history:(\d+)$/.exec(fault ?? '')
          if (keep && lo < st.block - Number(keep[1])) return json({ jsonrpc: '2.0', error: { code: -32602, message: 'Archive requests require a personal token. Get one at: https://www.allnodes.com/publicnode' }, id: req.id }, 403)
          // a topic position may be one topic or an OR-array of topics (arch B8) / 每个位置可以是单个 topic 或 topic 的"或"数组
          const matches = (t, x) => t == null || (Array.isArray(t) ? t.some((y) => x === String(y).toLowerCase()) : x === t.toLowerCase())
          const hits = st.logs.filter((l) => l.address === f.address.toLowerCase() && l.blockNumber >= lo && l.blockNumber <= hi
            && (f.topics || []).every((t, i) => matches(t, l.topics[i])))
          // rpc2 decorates its logs like newer nodes do (blockTimestamp); that is not a disagreement
          // rpc2 像较新的节点那样给日志加 blockTimestamp；这不算分歧
          return reply(hits.map((l) => ({ ...l, blockNumber: '0x' + l.blockNumber.toString(16), logIndex: '0x' + l.logIndex.toString(16), removed: false,
            ...(url === 'http://rpc2' ? { blockTimestamp: '0x68000000' } : {}) })))
        }
        case 'eth_getBlockReceipts': {
          // Every log of one block, whatever its address or topics, as receipts (one per transaction hash; logs of a
          // test's hand-made transactions share one), plus an unrelated contract's log a reader must filter out.
          // 一个区块的全部日志（不论地址与 topic），按交易组成回执；另加一条无关合约的日志，读取方必须滤掉。
          const b = Number(BigInt(req.params[0]))
          if (b > st.block) return reply(null)
          const hex = (l) => ({ ...l, blockNumber: '0x' + l.blockNumber.toString(16), logIndex: '0x' + l.logIndex.toString(16), removed: false })
          const byTx = new Map()
          for (const l of st.logs.filter((x) => x.blockNumber === b)) { const k = l.transactionHash ?? 'tx'; byTx.set(k, [...(byTx.get(k) || []), hex(l)]) }
          const other = { address: '0x' + '0e'.repeat(20), topics: [WIRE_TOPIC, '0x' + '00'.repeat(32)], data: '0x', blockNumber: b, logIndex: 100000 }
          return reply([...[...byTx.values()].map((logs) => ({ blockNumber: '0x' + b.toString(16), status: '0x1', logs })), { blockNumber: '0x' + b.toString(16), status: '0x1', logs: [hex(other)] }])
        }
        default: return json({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'method not found' } })
      }
    } catch (e) { return json({ jsonrpc: '2.0', id: req.id, error: { code: e.code || -32000, message: e.message } }) }
  }
  // 与真实 fetch 组合：RPC 走假链，其余走网络 / Combine with real fetch for provider HTTP.
  api.fetchWith = (real = globalThis.fetch.bind(globalThis)) => (url, init) => (String(url).startsWith('http://rpc') ? api.fetch(String(url), init) : real(url, init))
  api.eqAddr = eqAddr
  // ChannelBus: execute a send / sendMany transaction in the current block (each Wire log gets the block's next
  // index); mine() advances the chain. / 在当前区块执行 send / sendMany；mine() 推进区块。
  const WIRE_TOPIC = '0x46fffab6f2033c7dc33390d2a1329b6809abdcb8baf711dc44a9144ccf4b1431'
  const emitWire = (to, room, wire) => {
    const logIndex = st.logs.filter((l) => l.blockNumber === st.block).length
    st.logs.push({ address: to.toLowerCase(), topics: [WIRE_TOPIC, room], data: '0x' + bytesToHex(encodeParams(['bytes'], [wire])), blockNumber: st.block, logIndex })
  }
  api.submit = (tx) => {
    const sel = tx.data.slice(0, 10)
    if (sel !== '0x4fdf7085' && sel !== '0x95b97a92') throw new Error('not a ChannelBus call')
    const [room, data] = decodeParams(['bytes32', 'bytes'], hexToBytes('0x' + tx.data.slice(10)))
    const bytes = hexToBytes(data)
    if (sel === '0x4fdf7085') emitWire(tx.to, room, bytes)
    else for (let at = 0; at < bytes.length;) { const len = (bytes[at] << 8) | bytes[at + 1]; emitWire(tx.to, room, bytes.subarray(at + 2, at + 2 + len)); at += 2 + len }
    return '0x' + String(st.logs.length).padStart(64, '0')
  }
  api.mine = (n = 1) => { st.block += n }
  return api
}
