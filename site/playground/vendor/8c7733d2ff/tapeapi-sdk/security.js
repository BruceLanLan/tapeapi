// Security 1.1 helpers (the security 1.1 hardening design). Everything here is @experimental: outside the 1.0 stability
// promise, and it may change in a 1.x minor release.
// 安全加固 1.1 的辅助函数。这里的一切都是 @experimental：不在 1.0 稳定承诺之内，1.x 的小版本里可能改变。
//
// - erc6551Account: the container address derived locally (ERC-6551 CREATE2, salt 0), to cross-check hub.accountOf.
//   本地推导容器地址（ERC-6551 CREATE2，salt 0），与 hub.accountOf 交叉核对。
// - ContradictionRecord v1 (TAPI-23 §8, informative): two signed envelopes for the same request that name the same block
//   inside their signed results and state different results. Anyone can check one with the envelopes alone.
//   矛盾记录 v1：同一请求、签名结果内所钉区块相同、结果不同的两份签名信封。任何人只凭信封就能核验。
// - withSpotCheck: with probability `rate`, ask one more independent provider the same question and compare bytes.
//   以概率 `rate` 再问一家独立提供者同一个问题，逐字节比较。
import { keccak_256 } from '@noble/hashes/sha3'
import { concatBytes } from '@noble/hashes/utils'
import { TapeAPIError } from './errors.js'
import { canonicalJSON } from './canon.js'
import { hexToBytes, toHex, checksumAddress, encodeParams, isAddress, eqAddr } from './abi.js'
import { recoverResponseSigner, responseRequestHash } from './sig.js'

// ---------- ERC-6551 container derivation / 容器地址推导 ----------
// ERC-6551 reference registry v0.3.1 (0x000000006551c19487814612e58FE06813775758): the account is a CREATE2 of an
// ERC-1167 proxy to `implementation` with (salt, chainId, tokenContract, tokenId) appended. DeWebHub.accountOf uses salt 0
// (checked against mainnet, TAPI-20 §6.1: accountOf(0xe02c…a414, 11) = 0x1b2A…aAe8).
// ERC-6551 参考注册表 v0.3.1：账户是指向 `implementation` 的 ERC-1167 代理（尾部附 salt、chainId、tokenContract、tokenId）的 CREATE2。
// DeWebHub.accountOf 用 salt 0（已对照主网）。
const PROXY_HEAD = hexToBytes('0x3d60ad80600a3d3981f3363d3d373d3d3d363d73')
const PROXY_TAIL = hexToBytes('0x5af43d82803e903d91602b57fd5bf3')
/** @experimental The ERC-6551 account address, derived locally with no chain read. / 本地推导的 ERC-6551 账户地址。 */
export function erc6551Account({ registry, implementation, chainId, tokenContract, tokenId, salt = 0n }) {
  for (const [k, v] of [['registry', registry], ['implementation', implementation], ['tokenContract', tokenContract]]) {
    if (!isAddress(v)) throw new TapeAPIError('INVALID_ARGUMENT', `erc6551Account: ${k} must be an address`)
  }
  const s = typeof salt === 'string' && /^0x[0-9a-fA-F]{64}$/.test(salt) ? hexToBytes(salt) : encodeParams(['uint256'], [BigInt(salt)])
  const code = concatBytes(PROXY_HEAD, hexToBytes(implementation), PROXY_TAIL,
    encodeParams(['bytes32', 'uint256', 'address', 'uint256'], [s, BigInt(chainId), tokenContract, BigInt(tokenId)]))
  const h = keccak_256(concatBytes(new Uint8Array([0xff]), hexToBytes(registry), s, keccak_256(code)))
  return checksumAddress(toHex(h.slice(12)))
}

// ---------- ContradictionRecord v1 / 矛盾记录 v1 ----------
const HASH_RE = /^0x[0-9a-fA-F]{64}$/
/** The block a signed result names inside itself, or null. / 签名结果内部写明的区块。
 *  TAPI-23: { chainId, blockNumber, blockHash }. A `blockPinned` result (examples/_lib/chain.mjs): { blockNumber, blockHash }. */
export function signedBlockOf(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null
  if (Number.isSafeInteger(result.chainId) && Number.isSafeInteger(result.blockNumber) && typeof result.blockHash === 'string' && HASH_RE.test(result.blockHash)) {
    return { chainId: result.chainId, blockNumber: result.blockNumber, blockHash: result.blockHash.toLowerCase() }
  }
  const p = result.blockPinned
  if (p && typeof p === 'object' && Number.isSafeInteger(p.blockNumber) && typeof p.blockHash === 'string' && HASH_RE.test(p.blockHash)) {
    return { blockNumber: p.blockNumber, blockHash: p.blockHash.toLowerCase() }
  }
  return null
}
// What a result states about that block: TAPI-23 `result` (stateRoot and blockRef are not part of the statement in v1),
// or a blockPinned result without its block. A blockPinned statement is the WHOLE rest of the signed result, so it fits
// only methods whose result is fully determined by the block: a field that varies between honest answers (a
// `fetchedAt`, a latency, a server time) makes two honest answers look like a contradiction. Use records of such
// methods only when their results carry nothing but block-determined fields.
// 结果对该区块的陈述。blockPinned 的陈述是签名结果去掉 blockPinned 后的**全部**内容，因此只适用于结果完全由区块决定的方法：
// 诚实回答之间会变的字段（`fetchedAt`、耗时、服务器时间）会让两份诚实回答看起来互相矛盾。只有结果里全是由区块决定的字段时，
// 才对这类方法使用记录。
function statementOf(result) {
  if (signedBlockOf(result)?.chainId !== undefined) return { result: result.result }
  const { blockPinned, ...rest } = result
  return rest
}
const weakOf = (result) => result?.blockRef === 'number' || result?.blockPinned?.blockRef === 'number'
/** @experimental keccak256(canonicalJSON(statement)) of a signed result, 0x hex. / 结果陈述的哈希。 */
export const statementHash = (result) => toHex(keccak_256(new TextEncoder().encode(canonicalJSON(statementOf(result)))))

const envelopeFields = (e) => ({ container: checksumAddress(e.container), signer: checksumAddress(e.signer), id: e.id, ts: e.ts, ok: true, result: e.result, sig: e.sig })

/**
 * @experimental Build a ContradictionRecord v1 from two verified ok envelopes answering one request. Throws
 * INVALID_ARGUMENT when the pair is not a contradiction (different request, no signed block, different blocks, same
 * statement). `a` / `b`: { container, signer, id, ts, result, sig }.
 * 由回答同一请求的两份已验证 ok 信封构造矛盾记录 v1；不构成矛盾时抛 INVALID_ARGUMENT。
 */
export function contradictionRecord({ method, params = {}, a, b }) {
  const bad = (m) => { throw new TapeAPIError('INVALID_ARGUMENT', `contradictionRecord: ${m}`) }
  if (typeof method !== 'string') bad('method must be a string')
  const ba = signedBlockOf(a?.result), bb = signedBlockOf(b?.result)
  if (!ba || !bb) bad('both results must name their block inside the signed result (TAPI-23 blockNumber/blockHash, or blockPinned)')
  if (canonicalJSON(ba) !== canonicalJSON(bb)) bad('the two results name different blocks: that is not a contradiction')
  const ha = statementHash(a.result), hb = statementHash(b.result)
  if (ha === hb) bad('the two results state the same thing')
  return {
    tapeapiContradiction: 1,
    request: { method, params },
    requestHash: responseRequestHash({ method, params }),
    block: ba,
    envelopes: [{ ...envelopeFields(a), resultHash: ha }, { ...envelopeFields(b), resultHash: hb }],
  }
}

/**
 * @experimental Check a ContradictionRecord v1: both TAPI-21 signatures recover to the named signers over the same
 * request, both signed results name the same block, their statements differ, AND each signer is the one its container's
 * holder delegated, which the record alone cannot show: anyone can sign two contradicting envelopes that NAME a victim's
 * container. So `valid: true` needs `signerOf(container)` (e.g. (c) => api.resolve(c).then((s) => s.manifest.signer))
 * to confirm every signer (FIXED SECR-2). Without it, or when it throws, a record whose signatures are consistent is
 * `{ valid: false, reason: 'signer unverified…', signaturesConsistent: true, signersChecked: false, kind, weak, block }`.
 * `kind`: 'self' when one signer contradicts itself (the strongest case), 'cross' when two providers disagree (at least
 * one is wrong; which one needs the chain). `weak`: a result was evaluated by block number, not hash (TAPI-23 §3.2).
 * A blockPinned record is only meaningful for a method whose result the block fully determines (see statementOf).
 * @experimental 核验矛盾记录：两份 TAPI-21 签名对同一请求恢复出所写的签名者、两份签名结果写明同一区块、陈述不同，**并且**每个签名者
 * 确为其容器持有人委托的签名者——这一点记录本身证明不了：任何人都能签两份互相矛盾、却**写着**受害者容器的信封。因此 `valid: true`
 * 需要 `signerOf(container)` 确认每个签名者（FIXED SECR-2）。没有它或它抛错时，签名自洽的记录为 `{ valid: false, reason:
 * 'signer unverified…', signaturesConsistent: true, signersChecked: false, kind, weak, block }`。`kind`：同一签名者自相矛盾为
 * 'self'（最强），两家不一致为 'cross'。blockPinned 记录只对结果完全由区块决定的方法有意义（见 statementOf）。
 */
export async function verifyContradiction(record, { signerOf } = {}) {
  const no = (reason) => ({ valid: false, reason })
  if (!record || record.tapeapiContradiction !== 1) return no('not a ContradictionRecord v1')
  const { request, envelopes } = record
  if (!request || typeof request.method !== 'string') return no('request.method missing')
  if (!Array.isArray(envelopes) || envelopes.length !== 2) return no('a record holds exactly two envelopes')
  const params = request.params ?? {}
  let rh
  try { rh = responseRequestHash({ method: request.method, params }) } catch (e) { return no(`request has no canonical form: ${e.message}`) }
  if (String(record.requestHash).toLowerCase() !== rh) return no('requestHash does not match the request')
  const blocks = []
  for (const [i, e] of envelopes.entries()) {
    if (!e || e.ok !== true || !isAddress(e.container) || !isAddress(e.signer) || typeof e.id !== 'string' || !Number.isSafeInteger(e.ts) || typeof e.sig !== 'string') return no(`envelope ${i} is incomplete`)
    let who
    try { who = recoverResponseSigner({ container: e.container, id: e.id, method: request.method, params, ok: true, body: e.result, ts: e.ts }, e.sig) } catch (err) { return no(`envelope ${i}: ${err.message}`) }
    if (!eqAddr(who, e.signer)) return no(`envelope ${i} is signed by ${who}, not ${e.signer}`)
    const blk = signedBlockOf(e.result)
    if (!blk) return no(`envelope ${i} names no block inside its signed result`)
    blocks.push(canonicalJSON(blk))
    if (e.resultHash !== undefined && String(e.resultHash).toLowerCase() !== statementHash(e.result)) return no(`envelope ${i}: resultHash does not match its result`)
  }
  if (blocks[0] !== blocks[1]) return no('the two envelopes name different blocks')
  if (record.block !== undefined && canonicalJSON(record.block) !== blocks[0]) return no('record.block is not the block the envelopes name')
  if (statementHash(envelopes[0].result) === statementHash(envelopes[1].result)) return no('the two results state the same thing')
  const [a, b] = envelopes
  const facts = {
    kind: eqAddr(a.signer, b.signer) && eqAddr(a.container, b.container) ? 'self' : 'cross',
    weak: weakOf(a.result) || weakOf(b.result),
    block: JSON.parse(blocks[0]),
  }
  // The signatures are consistent; whether they bind anyone is the delegation. / 签名自洽；是否约束得了谁，要看委托。
  const unverified = (why) => ({ valid: false, reason: `signer unverified: ${why}`, signaturesConsistent: true, signersChecked: false, ...facts })
  if (typeof signerOf !== 'function') return unverified('pass signerOf to confirm each signer is the one its container delegates to')
  for (const e of envelopes) {
    let delegated
    try { delegated = await signerOf(e.container) } catch (err) { return unverified(`signerOf(${e.container}) failed: ${err?.message ?? err}`) }
    if (!eqAddr(delegated, e.signer)) return no(`${e.signer} is not the signer ${e.container} delegates to`)
  }
  return { valid: true, ...facts, signaturesConsistent: true, signersChecked: true }
}

/**
 * @experimental Every ContradictionRecord the envelopes of a quorum error support (error.data.envelopes of
 * ATTEST_DISAGREE / QUORUM_FAILED from api.callQuorum): one per pair of ok envelopes in different groups that name the
 * same signed block. [] when there is none.
 * @experimental 法定数错误的信封能支持的全部矛盾记录：不同组、同一签名区块的每对 ok 信封一条。
 */
export function contradictionsOf(error) {
  const d = error?.data
  const envs = Array.isArray(d?.envelopes) ? d.envelopes.filter((e) => e && e.ok === true) : []
  const req = d?.request
  if (!req || typeof req.method !== 'string') return []
  const out = []
  for (let i = 0; i < envs.length; i++) {
    for (let j = i + 1; j < envs.length; j++) {
      if (envs[i].group === envs[j].group) continue
      try { out.push(contradictionRecord({ method: req.method, params: req.params ?? {}, a: envs[i], b: envs[j] })) } catch { /* not a contradiction / 不构成矛盾 */ }
    }
  }
  return out
}

// ---------- random second opinion / 随机抽查 ----------
const defaultRandom = () => globalThis.crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32
const originsOf = (svc) => new Set((svc?.manifest?.endpoints?.live ?? []).map((u) => { try { return new URL(u).origin } catch { return u } }))
/** TAPI-23 §3.5: different container, different holder, no shared origin. / 独立：容器、持有人不同，来源不重叠。 */
function independent(a, b) {
  if (!a?.container || !b?.container || eqAddr(a.container, b.container)) return false
  const ha = a.verified?.holder, hb = b.verified?.holder
  if (!ha || !hb || eqAddr(ha, hb)) return false
  const oa = originsOf(a)
  for (const o of originsOf(b)) if (oa.has(o)) return false
  return true
}
const freeMethod = (svc, method) => {
  const d = (svc?.manifest?.methods ?? []).find((m) => m.name === method)
  return d ? (!d.priceBEM || /^0+(\.0+)?$/.test(String(d.priceBEM))) : null
}

/**
 * @experimental A client wrapper that, with probability `rate` (default 0: off), asks one more provider the same
 * question and compares the two results byte for byte (canonical JSON). The alternate is picked at random among
 * `alternates` that offer the method and are independent of the service called (TAPI-23 §3.5). The caller's answer is
 * never held back or changed: by default the check runs in the background and reports through `onMismatch` (with a
 * ContradictionRecord when the two results name the same signed block) and `onError`. `wait: true` waits for it and adds
 * `spotCheck` to the answer. A priced alternate is skipped unless `allowPaid: true` (it would be paid with the call's
 * `payer`). Only meaningful for deterministic methods: two honest answers to an AI prompt differ, and so do two answers
 * that carry a varying field such as `fetchedAt`. `onMismatch` / `onError` may be async; a rejection is ignored.
 * @experimental 客户端包装器：以概率 `rate`（默认 0，关闭）再问一家提供者同一问题，逐字节比较（规范 JSON）。备选者从提供该方法、
 * 且与被调用服务相互独立的 `alternates` 中随机挑选。调用方的回答绝不被扣留或改变：默认在后台核查，经 `onMismatch`（两个结果写明
 * 同一签名区块时附矛盾记录）与 `onError` 报告；`wait: true` 则等待并在回答上附 `spotCheck`。收费的备选者默认跳过，除非
 * `allowPaid: true`。只对确定性方法有意义。
 */
export function withSpotCheck(api, { rate = 0, alternates = [], random = defaultRandom, onMismatch, onError, wait = false, allowPaid = false } = {}) {
  if (!api || typeof api.call !== 'function') throw new TapeAPIError('INVALID_ARGUMENT', 'withSpotCheck takes a TapeAPI client')
  if (typeof rate !== 'number' || !(rate >= 0 && rate <= 1)) throw new TapeAPIError('INVALID_ARGUMENT', 'rate must be a number in 0..1')
  if (!Array.isArray(alternates)) throw new TapeAPIError('INVALID_ARGUMENT', 'alternates must be an array of resolved services')
  if (typeof random !== 'function') throw new TapeAPIError('INVALID_ARGUMENT', 'random must be a function returning [0, 1)')
  // A reporter never breaks the call, and neither does its promise: an async reporter that rejects is swallowed, never an
  // unhandledRejection (FIXED SECR-6). / 报告函数绝不影响调用，它返回的 promise 也不会：异步报告函数的拒绝被吞掉，绝不成为未处理的拒绝。
  const report = (fn, ...args) => { Promise.resolve().then(() => fn?.(...args)).catch(() => { /* ignored / 忽略 */ }) }
  async function check(svc, method, params, opts, primary) {
    const pool = alternates.filter((s) => independent(svc, s) && freeMethod(s, method) !== null && (allowPaid || freeMethod(s, method)))
    if (!pool.length) throw new TapeAPIError('QUORUM_FAILED', `${method}: no independent alternate offers this method${allowPaid ? '' : ' for free'}`)
    const other = pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))]
    const { id, ...rest } = opts ?? {}
    const second = await api.call(other, method, params, rest)
    const same = canonicalJSON(primary.result) === canonicalJSON(second.result)
    const env = (s, r) => ({ container: s.container, signer: s.manifest.signer, id: r.id, ts: r.ts, result: r.result, sig: r.sig })
    const out = { same, checked: other.container, primary: env(svc, primary), other: env(other, second) }
    if (!same) {
      try { out.record = contradictionRecord({ method, params: params ?? {}, a: out.primary, b: out.other }) } catch { /* no common signed block / 没有共同的签名区块 */ }
      report(onMismatch, out)
    }
    return out
  }
  return {
    async call(svc, method, params = {}, opts = {}) {
      const primary = await api.call(svc, method, params, opts)
      if (!(rate > 0) || !(random() < rate)) return primary
      const p = check(svc, method, params, opts, primary)
      if (!wait) { p.catch((e) => report(onError, e)); return primary }
      try { return { ...primary, spotCheck: await p } } catch (e) { report(onError, e); return { ...primary, spotCheck: { error: e } } }
    },
  }
}
