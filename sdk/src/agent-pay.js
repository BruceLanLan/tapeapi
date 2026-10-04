// @experimental (1.7) Container agents, phase 0 payment: read-only verification and unsigned transactions. Nothing here
// signs, sends, or pays gas for anyone, and nothing holds or routes funds: a payment is a plain transfer from the payer's
// own wallet (or, for an ERC-20, through the payer's container) to the agent's container, followed within an hour by a
// TapeSend message carrying an asset attachment (TAP-10 §16.1), which the recipient checks with TAP-10 §19.
//   - content: the TAP-10 §16 message object with §16.1 asset attachments (encode, decode)
//   - createPaymentKit(api): readMessage (§18.2, §18.3), sendingWallet (§18.5), verifyAttachment (§19, all 15 steps),
//     and the unsigned transactions (recipient read from the chain by name or circuit, never from any text; `transfer`
//     only, never `approve`; native coin only from a wallet directly)
//   - paymentOrder(): the order §19 needs, as checks (record the transfer, attach it to the next message to that
//     recipient within 3,600 s, send nothing else to that recipient in between)
// Instant and later checks are one implementation: the payload and the hint come from eth_getLogs or, when the nodes do
// not serve logs (as on bsc-dataseed), from eth_getBlockReceipts of the entry's block (TAP-10 §18.3), which public nodes
// still answer months later; the cost is bandwidth (a block's receipts), so reads are cached per block.
// Not covered by the 1.x compatibility promise. See docs/DESIGN-container-agent.md.
import { keccak_256 } from '@noble/hashes/sha3'
import { TapeAPIError } from './errors.js'
import { findDuplicateKey } from './canon.js'
import { selector, encodeParams, decodeParams, encodeCall, decodeReturn, hexToBytes, toHex, bytesToHex, concatBytes, isAddress, eqAddr, checksumAddress, ZERO_ADDRESS } from './abi.js'
import { chainById, parseTapeName } from './chains.js'
import { formatUnits } from './manifest.js'
import { endpoint as endpointOf, open as openPayload, messageId } from './tapesend.js'

export const SENT_TOPIC = '0xd75bb8082dd3ae8bb88682115ee1412a8e8051cc81d0e4c01dc3b06c0cf61020'
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
export const ATTACHMENT_STALE_S = 3600          // TAP-10 §19 step 12
export const ATTACHMENT_CROWDED = 60            // TAP-10 §19 step 13
export const MAX_ATTACHMENTS = 4                // TAP-10 §16
export const INBOX_PAGE_MAX = 200               // TAP-10 §13.6
export const PENDING_WINDOW_BLOCKS = 30         // TAP-10 §17, a `finalized` chain without F
export const ATTACHMENT_RESULTS = Object.freeze(['pending', 'mismatch', 'unavailable', 'unverifiable', 'late', 'indirect', 'third-party', 'stale', 'crowded', 'not-first', 'ok', 'other-chain', 'repeat'])
export const TRANSFER_SELECTOR = selector('transfer(address,uint256)')
// ERC-6551 account execute(to, value, data, operation); operation 0 = CALL
export const EXECUTE_SELECTOR = selector('execute(address,uint256,bytes,uint8)')

const STRICT = Object.freeze({ answers: 'tap10', strict: true })
const ANSWERS = Object.freeze({ answers: 'tap10' })
const HEX32 = /^0x[0-9a-fA-F]{64}$/
const AMOUNT_RE = /^[1-9][0-9]{0,77}$/
const TOKEN_ID_RE = /^(0|[1-9][0-9]{0,77})$/
const isRevert = (e) => e instanceof TapeAPIError && e.code === 'RPC_ERROR' && (Number(e.data?.rpcCode) === 3 || e.data?.rpcRevert === true)
const notAnAnswer = (e) => isRevert(e) || (e instanceof TapeAPIError && e.code === 'ABI_INVALID')
const chainFailure = (e) => e instanceof TapeAPIError && ['RPC_UNAVAILABLE', 'RPC_DISAGREE', 'RPC_ERROR'].includes(e.code)
const lower = (x) => (typeof x === 'string' ? x.toLowerCase() : x)
const bad = (msg, reason) => { throw new TapeAPIError('INVALID_ARGUMENT', msg, reason ? { reason } : undefined) }

// ---------- TAP-10 §16 content, §16.1 asset attachments ----------
/** §16.1 for the three asset types; returns the attachment with hex in lowercase, or null when it fails. Images are not
 *  asset attachments and are not checked here. / 只核对三种资产附件 */
export function checkAssetAttachment(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return null
  if (!['native', 'erc20', 'erc721'].includes(a.type)) return null
  if (!Number.isSafeInteger(a.chainId) || a.chainId <= 0) return null
  if (typeof a.tx !== 'string' || !HEX32.test(a.tx)) return null
  const out = { type: a.type, chainId: a.chainId, tx: a.tx.toLowerCase() }
  if (a.type !== 'native') { if (!isAddress(a.token)) return null; out.token = a.token.toLowerCase() }
  if (a.type === 'erc721') { if (typeof a.tokenId !== 'string' || !TOKEN_ID_RE.test(a.tokenId)) return null; out.tokenId = a.tokenId }
  else { if (typeof a.amount !== 'string' || !AMOUNT_RE.test(a.amount)) return null; out.amount = a.amount }
  return out
}

/** The §16 content object as UTF-8 bytes, ready for tapesend.encodePublic or tapesend.seal. Only asset attachments are
 *  built here (native, erc20, erc721); each must pass §16.1. / §16 内容，只构造资产附件 */
export function encodeContent({ subject, body = '', ts, attachments = [] } = {}) {
  if (typeof body !== 'string') bad('body must be a string')
  if (subject !== undefined && (typeof subject !== 'string' || [...subject].length > 200)) bad('subject must be a string of at most 200 code points')
  if (ts !== undefined && (!Number.isSafeInteger(ts) || ts < 0)) bad('ts must be milliseconds since the Unix epoch')
  if (!Array.isArray(attachments) || attachments.length > MAX_ATTACHMENTS) bad(`attachments: at most ${MAX_ATTACHMENTS}`)
  const seen = new Set()
  const atts = attachments.map((a, i) => {
    const c = checkAssetAttachment(a)
    if (!c) bad(`attachments[${i}] is not a valid native, erc20 or erc721 attachment (TAP-10 §16.1)`)
    if (seen.has(c.tx)) bad(`attachments[${i}] repeats a transaction: a repeat is never counted again (TAP-10 §19)`)
    seen.add(c.tx)
    return c
  })
  const obj = { v: 1, kind: 'message', ...(subject !== undefined ? { subject } : {}), body, ...(ts !== undefined ? { ts } : {}), ...(atts.length ? { attachments: atts } : {}) }
  return new TextEncoder().encode(JSON.stringify(obj))
}

function depthOver(v, max, d = 1) {
  if (d > max) return true
  if (v && typeof v === 'object') for (const x of Object.values(v)) if (depthOver(x, max, d + 1)) return true
  return false
}
function loneSurrogate(v) {
  const s = (x) => typeof x === 'string' && /(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/.test(x)
  if (s(v)) return true
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (s(k) || loneSurrogate(x)) return true
  return false
}
/**
 * TAP-10 §16 decoding, in its order: { status: 'ok' | 'damaged' | 'unsupported', message?, attachments, dropped, images }.
 * Attachments never make a message damaged: each asset attachment that fails §16.1 is dropped and counted, elements
 * beyond the fourth count as dropped, a non-array `attachments` counts as one. `images` counts image attachments, which
 * this SDK neither checks nor drops. Subject and body are plain text (TAP-10 §16 rendering is the caller's).
 */
export function decodeContent(bytes) {
  const out = (status, extra = {}) => ({ status, attachments: [], dropped: 0, images: 0, ...extra })
  if (!(bytes instanceof Uint8Array)) bad('content must be bytes')
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return out('damaged', { reason: 'byte order mark' })
  let text, v
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return out('damaged', { reason: 'not UTF-8' }) }
  try { v = JSON.parse(text) } catch { return out('damaged', { reason: 'not JSON' }) }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out('damaged', { reason: 'not a JSON object' })
  if (depthOver(v, 32)) return out('damaged', { reason: 'nested deeper than 32 levels' })
  if (findDuplicateKey(text) !== null) return out('damaged', { reason: 'duplicate member name' })
  if (loneSurrogate(v)) return out('damaged', { reason: 'unpaired surrogate' })
  if (typeof v.v === 'number' && v.v !== 1) return out('unsupported', { reason: `v ${v.v}` })
  if (typeof v.kind === 'string' && v.kind !== 'message') return out('unsupported', { reason: `kind ${v.kind.slice(0, 40)}` })
  if (v.v !== 1 || v.kind !== 'message' || typeof v.body !== 'string' || (v.subject !== undefined && typeof v.subject !== 'string')) return out('damaged', { reason: 'v, kind, body or subject missing or of another type' })
  const message = { v: 1, kind: 'message', body: v.body }
  if (v.subject !== undefined) message.subject = [...v.subject].slice(0, 200).join('')
  if (Number.isSafeInteger(v.ts) && v.ts >= 0) message.ts = v.ts
  const res = out('ok', { message })
  if (v.attachments === undefined) return res
  if (!Array.isArray(v.attachments)) { res.dropped = 1; return res }
  res.dropped = Math.max(0, v.attachments.length - MAX_ATTACHMENTS)
  for (const a of v.attachments.slice(0, MAX_ATTACHMENTS)) {
    if (a && a.type === 'image') { res.images++; continue }
    const c = checkAssetAttachment(a)
    if (c) res.attachments.push(c); else res.dropped++
  }
  return res
}

/**
 * @experimental (1.7) Phase-0 payment tools bound to one client (rpcUrls required; every decision read is strict).
 *   tokenAllowed   (token address) => boolean: the client's OWN list of known token contracts (TAP-10 §19: `ok` is shown
 *                  as positive only for tokens on it). Default: none is known, every `ok` is shown neutrally. The SDK
 *                  ships no list. / 客户端自己的已知代币列表；SDK 不内置名单
 */
export function createPaymentKit(api, opts = {}) {
  if (!api || typeof api !== 'object' || !api.addresses) throw new TapeAPIError('INVALID_ARGUMENT', 'createPaymentKit takes a createTapeAPI() client')
  if (opts.tokenAllowed !== undefined && typeof opts.tokenAllowed !== 'function') throw new TapeAPIError('INVALID_ARGUMENT', 'tokenAllowed must be a function')
  const chainId = Number(api.chainId)
  const { hub, factory } = api.addresses
  const tokenAllowed = opts.tokenAllowed ?? (() => false)
  const needRpc = () => {
    if (!api.rpc) throw new TapeAPIError('INVALID_ARGUMENT', 'payment checks read the chain: create the client with rpcUrls')
    if (api.rpc.degraded || (api.rpc.operators?.length ?? 0) < 2) throw new TapeAPIError('INVALID_ARGUMENT', 'payment checks need nodes of at least two operators (strict agreement); a single-node client cannot make them')
    return api.rpc
  }
  const strictCall = async (to, name, args) => decodeReturn(name, await needRpc().ethCall(to, encodeCall(name, args), 'latest', STRICT))
  const strictRaw = async (to, sig, types, args) => String(await needRpc().ethCall(to, selector(sig) + bytesToHex(encodeParams(types, args)), 'latest', STRICT))

  // ---- hub reads (TAP-10 §13.5, §13.6) ----
  async function inboxCount(to) { return BigInt(decodeParams(['uint256'], await strictRaw(hub, 'inboxCount(bytes32)', ['bytes32'], [to]))[0]) }
  // inboxPage returns offset (0x20) ‖ length ‖ length × 4 words; reject a length over 200, a byte length that does not
  // match, or a field wider than its type (address 160 bits, blockNumber 56, timestamp 40) (§13.6)
  async function inboxPage(to, start, n) {
    const raw = hexToBytes(await strictRaw(hub, 'inboxPage(bytes32,uint256,uint256)', ['bytes32', 'uint256', 'uint256'], [to, BigInt(start), BigInt(n)]))
    const word = (i) => BigInt('0x' + bytesToHex(raw.subarray(i * 32, i * 32 + 32)))
    const malformed = (why) => { throw new TapeAPIError('RPC_ERROR', `inboxPage answer is malformed: ${why}`) }
    if (raw.length < 64 || word(0) !== 32n) malformed('bad offset')
    const len = word(1)
    if (len > BigInt(INBOX_PAGE_MAX)) malformed(`length ${len} over ${INBOX_PAGE_MAX}`)
    if (raw.length !== 64 + Number(len) * 128) malformed('byte length does not match')
    const out = []
    for (let k = 0; k < Number(len); k++) {
      const [from, block, time, digest] = [0, 1, 2, 3].map((j) => word(2 + k * 4 + j))
      if (from >> 160n || block >> 56n || time >> 40n) malformed('a field exceeds its width')
      out.push({ index: Number(start) + k, from: checksumAddress('0x' + from.toString(16).padStart(40, '0')), blockNumber: Number(block), timestamp: Number(time), digest: '0x' + digest.toString(16).padStart(64, '0') })
    }
    return out
  }
  async function entryAt(to, index) {
    const [e] = await inboxPage(to, index, 1)
    if (!e) throw new TapeAPIError('NOT_FOUND', `no inbox entry ${index}`)
    return e
  }

  // ---- logs of one block (TAP-10 §18.3): eth_getLogs, or eth_getBlockReceipts when the nodes do not serve logs ----
  const blockLogs = new Map()
  const SENT_FACTS = (l) => ({ tx: lower(l.transactionHash), topics: (l.topics || []).map(lower), data: lower(l.data) })
  function sentLogsOf(block) {
    if (blockLogs.has(block)) return blockLogs.get(block)
    const hexB = '0x' + block.toString(16)
    const fromHub = (l) => l && eqAddr(l.address, hub) && lower(l.topics?.[0]) === SENT_TOPIC
    const p = (async () => {
      try {
        return await needRpc().call('eth_getLogs', [{ fromBlock: hexB, toBlock: hexB, address: hub, topics: [SENT_TOPIC] }], { ...ANSWERS, project: (ls) => { if (!Array.isArray(ls)) throw new Error('not an array'); return ls.filter(fromHub).map(SENT_FACTS) } })
      } catch (e) {
        if (!chainFailure(e)) throw e
        return needRpc().call('eth_getBlockReceipts', [hexB], { ...ANSWERS, project: (rs) => { if (!Array.isArray(rs)) throw new Error('not an array'); return rs.flatMap((r) => (Array.isArray(r?.logs) ? r.logs : []).filter(fromHub).map((l) => SENT_FACTS({ ...l, transactionHash: l.transactionHash ?? r.transactionHash }))) } })
      }
    })()
    blockLogs.set(block, p)
    p.catch(() => blockLogs.delete(block))
    if (blockLogs.size > 256) blockLogs.delete(blockLogs.keys().next().value)
    return p
  }
  const decodeSent = (l) => {
    if (l.topics.length !== 4) return null
    try {
      const [inboxIndex, , payload] = decodeParams(['uint256', 'uint256', 'bytes'], l.data)
      return { to: l.topics[1], from: '0x' + l.topics[2].slice(26), ref: l.topics[3], inboxIndex: Number(inboxIndex), payload: hexToBytes(payload), tx: l.tx, data: l.data }
    } catch { return null }
  }
  const digestOf = (ref, payload) => toHex(keccak_256(concatBytes(hexToBytes(ref), keccak_256(payload))))
  // The payload, ref and hint of one entry; null when no node gave a log matching the entry (unavailable)
  async function sentOf(to, entry) {
    let logs
    try { logs = await sentLogsOf(entry.blockNumber) } catch (e) { if (chainFailure(e)) return null; throw e }
    for (const l of logs) {
      const s = decodeSent(l)
      if (s && s.to === lower(to) && eqAddr(s.from, entry.from) && s.inboxIndex === entry.index && digestOf(s.ref, s.payload) === lower(entry.digest)) return s
    }
    return null
  }

  const sentOfMessage = new WeakMap()   // a readMessage result -> its Sent log (not a field: a caller cannot supply one)
  // ---- strict transaction reads, reduced to facts before agreement ----
  const receipts = new Map()
  function receiptOf(tx) {
    if (!receipts.has(tx)) {
      const p = needRpc().call('eth_getTransactionReceipt', [tx], { ...STRICT, project: (r) => (r == null ? null : { status: Number(BigInt(r.status)), blockNumber: Number(BigInt(r.blockNumber)), logs: (r.logs || []).map((l) => ({ address: lower(l.address), topics: (l.topics || []).map(lower), data: lower(l.data) })) }) })
      receipts.set(tx, p); p.catch(() => receipts.delete(tx))
      if (receipts.size > 512) receipts.delete(receipts.keys().next().value)
    }
    return receipts.get(tx)
  }
  const txOf = (tx) => needRpc().call('eth_getTransactionByHash', [tx], { ...STRICT, project: (t) => (t == null ? null : { from: lower(t.from), to: t.to == null ? null : lower(t.to), value: BigInt(t.value ?? 0).toString() }) })
  const blockTime = (n) => needRpc().call('eth_getBlockByNumber', ['0x' + n.toString(16), false], { ...STRICT, project: (b) => (b == null ? null : Number(BigInt(b.timestamp))) })

  /** TAP-10 §18.5: { wallet } | { indirect: true } | { unavailable: reason }, from the message's own transaction. */
  async function sendingWallet(to, entry, sent) {
    sent ??= await sentOf(to, entry)
    if (!sent) return { unavailable: 'no node returned a payload matching the entry' }
    let r, t
    try { r = await receiptOf(sent.tx) } catch (e) { if (chainFailure(e)) return { unavailable: e.message }; throw e }
    if (!r || r.status !== 1 || r.blockNumber !== entry.blockNumber) return { unavailable: 'the hint\'s receipt does not confirm the entry' }
    const confirms = r.logs.some((l) => l.address === lower(hub) && l.topics[0] === SENT_TOPIC && l.topics[1] === lower(to) && l.topics[2] === '0x' + '00'.repeat(12) + lower(entry.from).slice(2) && l.topics[3] === lower(sent.ref) && l.data === sent.data)
    if (!confirms) return { unavailable: 'the hint\'s receipt has no matching Sent log' }
    if (r.logs.some((l) => l.topics[0] === TRANSFER_TOPIC && l.topics.length === 4)) return { indirect: true, reason: 'an ERC-721 transfer in the same transaction' }
    try { t = await txOf(sent.tx) } catch (e) { if (chainFailure(e)) return { unavailable: e.message }; throw e }
    if (!t) return { unavailable: 'the transaction could not be read' }
    if (t.to === lower(hub) || (t.to !== null && t.to === t.from)) return { wallet: checksumAddress(t.from) }
    return { indirect: true, reason: `the transaction went to ${t.to}, not the hub` }
  }

  // TAP-10 §17 finality: F = the smallest block at the chain's finality tag among nodes of at least min(3, operators)
  // operators (strict); without F, a `finalized` chain counts the 30 blocks below the head as pending, a `safe` chain all.
  async function isPending(block) {
    const tag = chainById(chainId)?.finality ?? 'safe'
    const seen = []
    try {
      await needRpc().call('eth_getBlockByNumber', [tag, false], { ...STRICT, project: (b) => { seen.push(Number(BigInt(b.number))); return 0 } })
      return block > Math.min(...seen)
    } catch (e) {
      if (!chainFailure(e)) throw e
      if (tag !== 'finalized') return true
      return block > (await needRpc().blockNumber()) - PENDING_WINDOW_BLOCKS
    }
  }

  /**
   * One inbox message with its content: { recipient, to, inboxIndex, messageId, entry, ref, txHint, status, message,
   * attachments, dropped, images }. `secretKey` opens a sealed payload (the recipient's TapeSend key); a public payload
   * needs none. status: 'ok' | 'unavailable' | a TapeSend outcome ('damaged', 'not-for-key', 'unsupported').
   */
  async function readMessage({ recipient, inboxIndex, secretKey } = {}) {
    if (!isAddress(recipient)) bad('recipient must be the recipient container address')
    if (!Number.isSafeInteger(inboxIndex) || inboxIndex < 0) bad('inboxIndex must be a whole number')
    const to = toHex(endpointOf(recipient, chainId))
    const entry = await entryAt(to, inboxIndex)
    const base = { recipient: checksumAddress(recipient), to, inboxIndex, messageId: messageId({ chainId, hub, to, inboxIndex }), entry, attachments: [], dropped: 0, images: 0 }
    const sent = await sentOf(to, entry)
    if (!sent) return { ...base, status: 'unavailable' }
    let content
    try { content = openPayload({ payload: sent.payload, secretKey, to, from: toHex(endpointOf(entry.from, chainId)), hub, ref: sent.ref, chainId }).content }
    catch (e) { if (e instanceof TapeAPIError && e.code === 'TAPESEND_INVALID') return { ...base, ref: sent.ref, txHint: sent.tx, status: e.data?.reason ?? 'damaged' }; throw e }
    const d = decodeContent(content)
    const msg = { ...base, ref: sent.ref, txHint: sent.tx, ...d }
    sentOfMessage.set(msg, sent)
    return msg
  }

  /**
   * TAP-10 §19, the fifteen steps in order, all reads strict: the first that applies is the result. `message` comes from
   * readMessage; `attachment` is one of its attachments. Returns { result, ...detail }; only 'ok' proves that the sender
   * paid this recipient for this message, and `known` says whether the token is on the client's own list.
   */
  async function verifyAttachment(message, attachment) {
    const a = checkAssetAttachment(attachment)
    if (!a) bad('attachment is not a valid asset attachment')
    if (!sentOfMessage.has(message)) bad('message must be a readMessage result of this kit (its entry and payload were read from the chain)')
    // only an attachment the message itself claims: a payment is verified FOR this message, never for one it does not name
    if (!message.attachments.some((x) => x.tx === a.tx && x.type === a.type && x.chainId === a.chainId && x.token === a.token && x.amount === a.amount && x.tokenId === a.tokenId)) bad('attachment is not one of this message\'s attachments')
    if (a.chainId !== chainId) return { result: 'other-chain' }
    const m = message.entry
    const to = message.to
    const done = (result, extra = {}) => ({ result, ...extra, ...(a.token ? { token: checksumAddress(a.token), known: tokenAllowed(checksumAddress(a.token)) === true } : {}) })
    if (await isPending(m.blockNumber)) return done('pending')                                         // 1
    let r, t
    try { [r, t] = await Promise.all([receiptOf(a.tx), txOf(a.tx)]) } catch (e) { if (chainFailure(e)) return done('unavailable', { step: 3, reason: e.message }); throw e }
    if (r == null && t == null) return done('mismatch', { step: 2, reason: 'no receipt and no transaction' })   // 2
    if (r == null || t == null) return done('unavailable', { step: 3 })                               // 3
    if (r.status !== 1) return done('mismatch', { step: 4, reason: 'the transaction reverted' })      // 4
    const container = lower(message.recipient)
    if (a.type === 'native' && t.to !== container) return done('unverifiable', { step: 5, reason: 'a native transfer must go from a wallet straight to the container' })   // 5
    let payer = null                                                                                  // 6
    if (a.type === 'native') { if (t.value !== a.amount) return done('mismatch', { step: 6, reason: `value ${t.value}, attachment ${a.amount}` }); payer = t.from }
    else {
      const want = '0x' + '00'.repeat(12) + container.slice(2)
      const hit = r.logs.find((l) => l.address === a.token && l.topics[0] === TRANSFER_TOPIC && l.topics[2] === want && (a.type === 'erc20'
        ? l.topics.length === 3 && l.data === '0x' + BigInt(a.amount).toString(16).padStart(64, '0')
        : l.topics.length === 4 && BigInt(l.topics[3]) === BigInt(a.tokenId)))
      if (!hit) return done('mismatch', { step: 6, reason: 'no matching Transfer log to the container' })
      payer = '0x' + hit.topics[1].slice(26)
    }
    if (r.blockNumber > m.blockNumber) return done('late', { step: 7 })                               // 7
    const sw = await sendingWallet(to, m, sentOfMessage.get(message))                                              // 8, 9
    if (sw.unavailable) return done('unavailable', { step: 8, reason: sw.unavailable })
    if (sw.indirect) return done('indirect', { step: 9, reason: sw.reason })
    const wallet = lower(sw.wallet)                                                                   // 10
    const paidBySender = payer === wallet || (payer === lower(m.from) && t.from === wallet)
    if (!paidBySender) return done('third-party', { step: 10, payer: checksumAddress(payer), wallet: sw.wallet })
    let tt
    try { tt = await blockTime(r.blockNumber) } catch (e) { if (chainFailure(e)) return done('unavailable', { step: 11 }); throw e }
    if (tt == null) return done('unavailable', { step: 11 })                                          // 11
    if (m.timestamp - tt > ATTACHMENT_STALE_S) return done('stale', { step: 12, seconds: m.timestamp - tt })   // 12
    // 13, 14: walk the same inbox backwards from m; entries at or after the transfer's block
    const start = Math.max(0, m.index - (ATTACHMENT_CROWDED + 1))
    const before = m.index > start ? await inboxPage(to, start, m.index - start) : []
    const since = []
    for (let k = before.length - 1; k >= 0 && before[k].blockNumber >= r.blockNumber; k--) since.push(before[k])
    if (since.length > ATTACHMENT_CROWDED) return done('crowded', { step: 13 })
    for (const e of since) {
      if (eqAddr(e.from, m.from)) return done('not-first', { step: 14, earlier: e.index })
      const w = await sendingWallet(to, e)
      if (w.unavailable) return done('unavailable', { step: 14, earlier: e.index, reason: w.unavailable })
      // An indirect earlier message (TAP-10 §18.5 steps 2-3: written through a contract) is skipped: its sending container
      // was compared above, and it has no sending wallet to compare. §18.5 keeps "indirect" apart from "cannot be
      // determined" (step 1 failing), and §19 lists unavailable and indirect as separate results, so the parenthesis of
      // step 14 reads as step 1 failing. Taking indirect as unavailable would let anyone's relayed message (a Safe-held
      // correspondent's greeting included) turn every later payment to this recipient into unavailable for good.
      // indirect 的早先条目跳过：发件容器已比过，没有钱包可比；否则任何经合约中继的一条来信都会让之后的付款永远 unavailable。
      if (w.wallet && eqAddr(w.wallet, sw.wallet)) return done('not-first', { step: 14, earlier: e.index })
    }
    return done('ok', { payer: checksumAddress(payer), wallet: sw.wallet, transferBlock: r.blockNumber, seconds: m.timestamp - tt })   // 15
  }
  /** Every asset attachment of a message; a second one with the same tx is 'repeat' and never counted again. */
  async function verifyAttachments(message) {
    const seen = new Set()
    const out = []
    for (const a of message.attachments ?? []) {
      if (seen.has(a.tx)) { out.push({ attachment: a, result: 'repeat' }); continue }
      seen.add(a.tx)
      out.push({ attachment: a, ...(await verifyAttachment(message, a)) })
    }
    return out
  }

  // ---- unsigned transactions (phase 0, option ii) ----
  // The recipient comes ONLY from the chain: a name (<#ID>.<processor>.tape, the processor read with cpuAt) or a
  // { circuits, tokenId } pair, then factory.isCPU and hub.accountOf, all strict. An address passed by the caller is
  // refused: it is how a message body, a task text or a manifest field would smuggle in a phishing recipient.
  // 收款地址只来自链上：名字或电路，再经 isCPU 与 accountOf 严格读取。调用方给的地址一律拒绝。
  async function recipientOf(target) {
    if (!target || typeof target !== 'object') bad('name the recipient by { name } or { circuits, tokenId }')
    for (const k of ['to', 'container', 'recipient', 'address']) if (target[k] !== undefined) bad(`the recipient is read from the chain by name or circuit; an address (\`${k}\`) is never taken from the caller`, 'recipient-not-from-chain')
    let circuits, tokenId, name = null
    if (typeof target.name === 'string') {
      const p = parseTapeName(target.name)
      if (!p || p.error || p.chainId !== chainId) bad(`${target.name} is not a TapeOut name of chain ${chainId}${p?.error ? `: ${p.error}` : ''}`)
      try { circuits = await strictCall(factory, 'cpuAt', [BigInt(p.processor)]) } catch (e) { if (notAnAnswer(e)) bad(`processor ${p.processor} does not exist`); throw e }
      tokenId = BigInt(p.tokenId); name = p.name
    } else if (isAddress(target.circuits) && target.tokenId != null) { circuits = target.circuits; tokenId = tokenIdOf(target.tokenId) }
    else bad('name the recipient by { name } or { circuits, tokenId }')
    let cpu
    try { cpu = await strictCall(factory, 'isCPU', [circuits]) } catch (e) { if (notAnAnswer(e)) cpu = false; else throw e }
    if (cpu !== true) bad(`${circuits} is not a TapeOut processor`, 'not-tapeout')
    const container = await strictCall(hub, 'accountOf', [circuits, tokenId])
    if (eqAddr(container, ZERO_ADDRESS)) bad('the hub derives no container')
    // accountOf derives an address for ANY #ID, minted or not (TAP-10 §13.5, Appendix A): only an existing token has a
    // holder who can ever move what is sent there. TAP-10 §4.2 step 4: ownerOf, a revert is no-such-token.
    // accountOf 对任何 #ID 都推导出地址（无论是否铸造）：只有存在的 token 才有人能取走转过去的钱。
    let holder
    try { holder = await strictCall(circuits, 'ownerOf', [tokenId]) } catch (e) { if (notAnAnswer(e)) bad(`#${tokenId} of ${circuits} does not exist (ownerOf reverts): nobody could ever move a payment sent to its address`, 'no-such-token'); throw e }
    if (eqAddr(holder, ZERO_ADDRESS)) bad(`#${tokenId} of ${circuits} has no holder`, 'no-such-token')
    return { container: checksumAddress(container), circuits: checksumAddress(circuits), tokenId: tokenId.toString(), name, holder: checksumAddress(holder) }
  }
  // #ID: a decimal string without leading zeros, a safe integer or a bigint, 1 to 2^256 - 1 (the same rules as agent-sig)
  const tokenIdOf = (v) => {
    let n
    if (typeof v === 'bigint') n = v
    else if (typeof v === 'number' && Number.isSafeInteger(v)) n = BigInt(v)
    else if (typeof v === 'string' && /^[1-9][0-9]{0,77}$/.test(v)) n = BigInt(v)
    else bad('tokenId must be a decimal string without leading zeros, a safe integer or a bigint')
    if (n < 1n || n >= 1n << 256n) bad('tokenId must be 1 to 2^256 - 1')
    return n
  }
  const amountOf = (v) => {
    let n
    try { n = BigInt(v) } catch { bad('amount must be a whole number in the smallest unit') }
    if (typeof v === 'string' && !AMOUNT_RE.test(v)) bad('amount must be a decimal string without leading zeros')
    if (n <= 0n || n >= 1n << 256n) bad('amount must be positive and fit uint256')
    return n
  }
  const built = new WeakMap()   // transferToContainer results -> what was built (not a field: a caller cannot forge one)
  // ERC-20 decimals is a uint8: null when it cannot be read (a revert, no answer), 'invalid' when the answer is above 255
  // ERC-20 的 decimals 是 uint8：读不到为 null，读到但超过 255 为 'invalid'
  async function decimalsOf(token) {
    let d
    try { d = BigInt(decodeParams(['uint256'], await strictRaw(token, 'decimals()', [], []))[0]) } catch (e) { if (notAnAnswer(e)) return null; throw e }
    return d <= 255n ? Number(d) : 'invalid'
  }
  /** ERC-20 transfer(recipient container, amount) from the payer's wallet. { to, data, value, recipient, summary }. */
  async function transferToContainer({ token, amount, ...target } = {}) {
    if (!isAddress(token) || eqAddr(token, ZERO_ADDRESS)) bad('token must be the ERC-20 contract (for the native coin use nativeToContainer)')
    const n = amountOf(amount)
    const recipient = await recipientOf(target)
    const decimals = await decimalsOf(token)
    const tx = { to: checksumAddress(token), data: TRANSFER_SELECTOR + bytesToHex(encodeParams(['address', 'uint256'], [recipient.container, n])), value: '0x0' }
    const out = { ...tx, recipient, summary: describeTx(tx, { decimals, recipient }) }
    built.set(out, { to: tx.to, data: tx.data, recipient: Object.freeze({ ...recipient }), decimals })
    return out
  }
  /** The chain's native coin, from the payer's WALLET straight to the container (TAP-10 §19 step 5: a transfer through a
   *  container's execute cannot be verified). No gas field: the wallet estimates it (a container's receive costs more
   *  than 2,300 gas). */
  async function nativeToContainer({ amount, ...target } = {}) {
    const n = amountOf(amount)
    const recipient = await recipientOf(target)
    const tx = { to: recipient.container, data: '0x', value: '0x' + n.toString(16) }
    return { ...tx, recipient, summary: describeTx(tx, { decimals: 18, recipient, native: true }) }
  }
  /** Wrap an ERC-20 transfer built above in the PAYER's container: execute(token, 0, transfer(...), 0), signed by the
   *  payer container's holder. Only a `transfer` is ever wrapped: never a native value (unverifiable), never `approve` or
   *  any other call. A wallet cannot read execute calldata, so the summary spells out every field. */
  // Only the very object transferToContainer returned, unedited: its inner recipient is the container the chain named.
  // A hand-made or edited transfer is refused (recipient-not-from-chain). / 只接受 transferToContainer 原样返回的对象
  function viaContainer({ from, tx } = {}) {
    if (!isAddress(from)) bad('from must be the payer\'s container')
    if (!tx || !isAddress(tx.to) || typeof tx.data !== 'string') bad('tx must be a transaction from transferToContainer')
    if (BigInt(tx.value ?? 0) !== 0n || tx.data === '0x') bad('the native coin is never sent through a container: TAP-10 §19 cannot verify it (step 5); pay from the wallet with nativeToContainer', 'native-via-container-unverifiable')
    if (!tx.data.toLowerCase().startsWith(TRANSFER_SELECTOR)) bad('only an ERC-20 transfer is wrapped; this SDK never builds approve or any other call', 'only-transfer')
    const rec = built.get(tx)
    if (!rec || rec.to !== tx.to || rec.data !== tx.data || !tx.recipient || !eqAddr(tx.recipient.container, rec.recipient.container)) bad('tx must be the unedited result of transferToContainer of this kit: its recipient is read from the chain, never taken from a caller', 'recipient-not-from-chain')
    const [inner] = decodeParams(['address', 'uint256'], hexToBytes('0x' + tx.data.slice(10)))
    if (!eqAddr(inner, rec.recipient.container)) bad('the transfer\'s recipient is not the container the chain named', 'recipient-not-from-chain')
    const out = { to: checksumAddress(from), data: EXECUTE_SELECTOR + bytesToHex(encodeParams(['address', 'uint256', 'bytes', 'uint8'], [tx.to, 0n, tx.data, 0])), value: '0x0' }
    // the summary is written from what was built, never from fields of `tx` a caller could edit / 摘要只用构造时记下的内容
    return { ...out, recipient: { ...rec.recipient }, summary: describeTx(out, { inner: tx, recipient: rec.recipient, decimals: rec.decimals }) }
  }

  return { readMessage, verifyAttachment, verifyAttachments, sendingWallet: async ({ recipient, inboxIndex }) => { const to = toHex(endpointOf(recipient, chainId)); return sendingWallet(to, await entryAt(to, inboxIndex)) }, inboxCount: (recipient) => inboxCount(toHex(endpointOf(recipient, chainId))), transferToContainer, nativeToContainer, viaContainer, recipientOf, chainId }
}

/** Every field of an unsigned transaction, in words, for a holder to compare with what the wallet shows. */
export function describeTx(tx, { decimals = null, recipient = null, native = false, inner = null } = {}) {
  const lines = [`to: ${tx.to}`, `value: ${BigInt(tx.value ?? 0)} (smallest unit of the native coin)`]
  const data = String(tx.data ?? '0x').toLowerCase()
  // the amount in whole tokens too, by decimal string arithmetic (never floating point) / 同时给出整币数（十进制字符串运算）
  const fmt = (n) => (decimals === 'invalid' ? `${n} (smallest unit; decimals() gave no valid answer)` : decimals == null ? `${n} (smallest unit; decimals() could not be read)` : `${n} (smallest unit, ${decimals} decimals) = ${formatUnits(n, decimals)} tokens`)
  if (native || data === '0x') lines.push('data: none (a plain native-coin transfer: send it from your wallet, never through a container)')
  else if (data.startsWith(TRANSFER_SELECTOR)) {
    const [to, amount] = decodeParams(['address', 'uint256'], hexToBytes('0x' + data.slice(10)))
    lines.push(`call: transfer(to = ${to}, amount = ${fmt(amount)}) on token ${tx.to}`)
  } else if (data.startsWith(EXECUTE_SELECTOR)) {
    const [to, value, d, op] = decodeParams(['address', 'uint256', 'bytes', 'uint8'], hexToBytes('0x' + data.slice(10)))
    lines.push(`call: execute(to = ${to}, value = ${value}, data = ${String(d).slice(0, 10)}…, operation = ${op} (call)) on your container ${tx.to}`)
    if (inner) lines.push(...describeTx(inner, { decimals }).slice(2).map((l) => `  inner ${l}`))
  } else lines.push(`data: ${data.slice(0, 10)}… (not built by this SDK)`)
  if (recipient) lines.push(`recipient container: ${recipient.container}${recipient.name ? ` (${recipient.name})` : ''}, circuit ${recipient.circuits} #${recipient.tokenId}${recipient.holder ? `, held by ${recipient.holder}` : ''}`)
  return lines
}

/**
 * @experimental (1.7) The order TAP-10 §19 needs, as checks in the payer's client:
 *   1. recordTransfer({ recipient, tx }) right after the wallet returns the hash, before inclusion (§20 step 4);
 *   2. confirmTransfer({ recipient, tx, blockTime }) once it is included;
 *   3. checkMessage({ recipient, attachments }) before sending ANY message to that recipient: a message that does not
 *      attach every recorded transfer is refused (§19 not-first), and so is an attachment whose transfer is more than
 *      3,600 s old (§19 stale);
 *   4. messageSent({ recipient, attachments }) after sending, which clears what it carried.
 * `clock`: () => Unix seconds. State lives in this object only: keep one per payer.
 */
export function paymentOrder({ clock = () => Math.floor(Date.now() / 1000) } = {}) {
  const pending = new Map()   // recipient (lowercase) -> Map(tx -> { blockTime })
  const used = new Set()
  const of = (r) => { if (!isAddress(r)) bad('recipient must be a container address'); const k = r.toLowerCase(); if (!pending.has(k)) pending.set(k, new Map()); return pending.get(k) }
  const hash = (tx) => { if (typeof tx !== 'string' || !HEX32.test(tx)) bad('tx must be a 32-byte transaction hash'); return tx.toLowerCase() }
  return {
    recordTransfer({ recipient, tx }) {
      const h = hash(tx)
      if (used.has(h)) bad('this transfer was already recorded: a recorded transfer is never sent or attached again (TAP-10 §20 step 4)', 'transfer-repeated')
      used.add(h); of(recipient).set(h, { blockTime: null })
    },
    confirmTransfer({ recipient, tx, blockTime }) {
      const e = of(recipient).get(hash(tx))
      if (!e) bad('no such recorded transfer')
      if (!Number.isSafeInteger(blockTime)) bad('blockTime must be Unix seconds')
      e.blockTime = blockTime
    },
    /** The latest time the message carrying the transfers to `recipient` may go out (null while any is unconfirmed). */
    deadline(recipient) {
      const times = [...of(recipient).values()].map((e) => e.blockTime)
      if (!times.length || times.some((t) => t == null)) return null
      return Math.min(...times) + ATTACHMENT_STALE_S
    },
    checkMessage({ recipient, attachments = [] }) {
      const p = of(recipient)
      const carried = new Set(attachments.map((a) => lower(a?.tx)))
      const missing = [...p.keys()].filter((h) => !carried.has(h))
      if (missing.length) bad(`a transfer to ${recipient} is waiting for its message: send the message that attaches it first, and nothing else to this recipient before it (TAP-10 §19 not-first): ${missing.join(', ')}`, 'not-first')
      for (const h of carried) {
        const e = p.get(h)
        if (!e) bad(`attachment ${h} is not a recorded transfer to ${recipient}`, 'unknown-transfer')
        if (e.blockTime != null && clock() - e.blockTime > ATTACHMENT_STALE_S) bad(`transfer ${h} is more than ${ATTACHMENT_STALE_S} s old: the recipient's check would say stale (TAP-10 §19 step 12)`, 'stale')
      }
      return true
    },
    messageSent({ recipient, attachments = [] }) { const p = of(recipient); for (const a of attachments) p.delete(lower(a?.tx)) },
    /** TAP-10 §20 step 4: a recorded transfer is removed only when every node agrees it reverted, or that it was cancelled
     *  (another transaction with its nonce was included): the caller has established that. It is never recorded again. */
    dropTransfer({ recipient, tx, reason }) {
      if (reason !== 'reverted' && reason !== 'cancelled') bad("reason must be 'reverted' or 'cancelled' (TAP-10 §20 step 4)")
      if (!of(recipient).delete(hash(tx))) bad('no such recorded transfer')
    },
    /** TAP-10 §20 step 4: the wallet sped the transfer up; the replacement's hash replaces the recorded one. */
    replaceTransfer({ recipient, tx, by }) {
      const p = of(recipient), h = hash(tx), b = hash(by)
      if (!p.has(h)) bad('no such recorded transfer')
      if (used.has(b)) bad('the replacement was already recorded', 'transfer-repeated')
      p.delete(h); used.add(b); p.set(b, { blockTime: null })
    },
  }
}
