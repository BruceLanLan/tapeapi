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
// Not covered by the 2.x compatibility promise. Designed in internal notes (container agents, phase 0).
import { keccak_256 } from '@noble/hashes/sha3'
import { TapeAPIError } from './errors.js'
import { findDuplicateKey } from './canon.js'
import { selector, encodeParams, decodeParams, encodeCall, decodeReturn, hexToBytes, toHex, bytesToHex, concatBytes, isAddress, eqAddr, checksumAddress, ZERO_ADDRESS } from './abi.js'
import { chainById, parseTapeName, AUDITED_ESCROWS } from './chains.js'
import { normalizeMandate, phase1Problems, mandateNamesFunds, mandateHashOf, DEFAULT_FUNDING_PATH, FUNDING_PATHS, withdrawRequestLive, WITHDRAW_COOLDOWN_S, WITHDRAW_WINDOW_S } from './agent-sig.js'
import { formatUnits } from './manifest.js'
import { endpoint as endpointOf, open as openPayload, messageId } from './tapesend.js'
import { voucherDigest, recoverAddress, privateKeyToAddress } from './sig.js'
import { spendKeyContext } from './agent-vault.js'

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
  // the OUTER value of viaContainer (the TapeOut fee the container's execute may require): a whole number of the native coin's
  // smallest unit, 0 or more; same forms as amountOf, but zero is allowed / 外层 value：最小单位的整数，≥ 0
  const feeValueOf = (v) => {
    let n
    if (typeof v === 'bigint') n = v
    else if (typeof v === 'number' && Number.isSafeInteger(v)) n = BigInt(v)
    else if (typeof v === 'string' && TOKEN_ID_RE.test(v)) n = BigInt(v)
    else bad('value must be a whole number in the smallest unit of the native coin (a decimal string without leading zeros, a safe integer or a bigint), 0 or more')
    if (n < 0n || n >= 1n << 256n) bad('value must be 0 or more and fit uint256')
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
   *  any other call. A wallet cannot read execute calldata, so the summary spells out every field.
   *  `value` (optional) is the OUTER value of the transaction: the TapeOut fee the container's execute may require in the
   *  chain's native coin, which only the caller can supply (the SDK neither hard-codes nor reads it). The INNER value stays 0. */
  // Only the very object transferToContainer returned, unedited: its inner recipient is the container the chain named.
  // A hand-made or edited transfer is refused (recipient-not-from-chain). / 只接受 transferToContainer 原样返回的对象
  function viaContainer({ from, tx, value } = {}) {
    if (!isAddress(from)) bad('from must be the payer\'s container')
    if (!tx || !isAddress(tx.to) || typeof tx.data !== 'string') bad('tx must be a transaction from transferToContainer')
    if (BigInt(tx.value ?? 0) !== 0n || tx.data === '0x') bad('the native coin is never sent through a container: TAP-10 §19 cannot verify it (step 5); pay from the wallet with nativeToContainer', 'native-via-container-unverifiable')
    if (!tx.data.toLowerCase().startsWith(TRANSFER_SELECTOR)) bad('only an ERC-20 transfer is wrapped; this SDK never builds approve or any other call', 'only-transfer')
    const rec = built.get(tx)
    if (!rec || rec.to !== tx.to || rec.data !== tx.data || !tx.recipient || !eqAddr(tx.recipient.container, rec.recipient.container)) bad('tx must be the unedited result of transferToContainer of this kit: its recipient is read from the chain, never taken from a caller', 'recipient-not-from-chain')
    const [inner] = decodeParams(['address', 'uint256'], hexToBytes('0x' + tx.data.slice(10)))
    if (!eqAddr(inner, rec.recipient.container)) bad('the transfer\'s recipient is not the container the chain named', 'recipient-not-from-chain')
    const fee = value == null ? 0n : feeValueOf(value)
    const out = { to: checksumAddress(from), data: EXECUTE_SELECTOR + bytesToHex(encodeParams(['address', 'uint256', 'bytes', 'uint8'], [tx.to, 0n, tx.data, 0])), value: '0x' + fee.toString(16) }
    // the summary is written from what was built, never from fields of `tx` a caller could edit / 摘要只用构造时记下的内容
    return { ...out, recipient: { ...rec.recipient }, summary: describeTx(out, { inner: tx, recipient: rec.recipient, decimals: rec.decimals }) }
  }

  const kit = { readMessage, verifyAttachment, verifyAttachments, sendingWallet: async ({ recipient, inboxIndex }) => { const to = toHex(endpointOf(recipient, chainId)); return sendingWallet(to, await entryAt(to, inboxIndex)) }, inboxCount: (recipient) => inboxCount(toHex(endpointOf(recipient, chainId))), transferToContainer, nativeToContainer, viaContainer, recipientOf, chainId }
  // @internal for review-verify.js (the experimental review subpath), never on the kit object / 只给评价核验用
  PAY_INTERNALS.set(kit, { inboxCount, inboxPage, sentOf, sendingWallet, isPending, chainId, hub })
  return kit
}

const PAY_INTERNALS = new WeakMap()
/** @internal The inbox readers of a createPaymentKit() result (review-verify.js only); null for anything else. */
export function paymentKitInternals(kit) { return PAY_INTERNALS.get(kit) ?? null }

// execute's outer value 0: said in the summary, never silently / execute 外层 value 为 0 时，摘要必须明说
const FEE_NOTICE = "WARNING: outer value is 0, but the container's execute may require the TapeOut fee in the chain's native coin (0.0002 BNB on BNB Smart Chain at the time of writing; it cannot be read from the chain with a getter: simulate the transaction, a revert of `0xafd49700(paid, required)` states it). A call without it reverts. Pass `value` to viaContainer to attach it."

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
    // The OUTER value is not the inner one: the container's execute may require the TapeOut fee in the chain's native coin
    // (read on BNB Smart Chain mainnet: every call; the excess refunded to the sender, a short payment reverts with
    // 0xafd49700(paid, required)). It has no public getter, so it is never guessed here. / 外层 value 是 TapeOut 费，不是内层转账
    if (BigInt(tx.value ?? 0) > 0n) lines.push(`outer value ${BigInt(tx.value)} is the TapeOut fee the container's execute takes in the native coin: it goes to TapeOut, never to the recipient (the inner value is 0, the recipient gets only the token transfer)`)
    else lines.push(FEE_NOTICE)
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

// ---------- phase 1 (experimental): the holder's transaction plan, its close-out and the session history ----------
// Internal design notes, phase 1, §2.1, §2.3-§2.6, §6.1 S4/S4b. Pure: no chain read, nothing signed or sent.
// What only the chain knows is passed in as facts: each provider's escrow (from its manifest), whether that escrow has
// code and its token(), the channel's balance, a live withdraw request, the agent key's session on the channel, the
// principal's current holder, whether the principal container is deployed and opened, and on the container path the
// TapeOut fee each `execute` takes (and whether it still reverts with it). createAgentKit(api).holderPlan / closeOut read
// all of them at ONE pinned block, strictly, and call these functions; a caller that passes its own facts gets the same
// rules over them. Nothing in this library writes a fee in.
// 阶段 1（实验）：持有人交易计划、收尾计划与会话历史。纯函数：不读链、不签名、不发送。链上才知道的事实作为参数传入；
// createAgentKit(api).holderPlan / closeOut 在同一个钉块上严格读取它们再调用这里。库内不写死任何费用。
export const MAX_SESSION_S = 30 * 86400   // the escrow's MAX_SESSION / 托管的 MAX_SESSION
export const ESCROW_PLAN_PATHS = FUNDING_PATHS
// The container's execute reverts with this selector and (paid, required) when the TapeOut fee is short (read on BNB
// Smart Chain mainnet by simulation; no getter) / 容器 execute 费用不足时以此选择器与 (paid, required) 回滚
export const EXECUTE_FEE_SELECTOR = '0xafd49700'
const planFail = (msg, reason, extra) => { throw new TapeAPIError('INVALID_ARGUMENT', msg, { reason, ...extra }) }
const uintOf = (v, name) => {
  let n
  if (typeof v === 'bigint') n = v
  else if (typeof v === 'number' && Number.isSafeInteger(v)) n = BigInt(v)
  else if (typeof v === 'string' && TOKEN_ID_RE.test(v)) n = BigInt(v)
  else bad(`${name} must be a whole number (a decimal string without leading zeros, a safe integer or a bigint)`)
  if (n < 0n || n >= 1n << 256n) bad(`${name} must be 0 or more and fit uint256`)
  return n
}
const isoOf = (s) => { try { return new Date(s * 1000).toISOString() } catch { return String(s) } }
const optBool = (v, name) => { if (v !== undefined && typeof v !== 'boolean') bad(`${name} must be a boolean`) }
// The inner call in words, for the holder to compare with the wallet / 内层调用的文字说明，供持有人与钱包核对
function escrowCallLines(kind, f) {
  if (kind === 'approve') return [`call: approve(spender = ${f.escrow}, amount = ${f.amount}) on token ${f.token}: lets the escrow pull exactly ${f.amount} (smallest unit) from ${f.consumer}, no more`]
  if (kind === 'fund') return [`call: fund(provider = ${f.provider}, amount = ${f.amount}) on escrow ${f.escrow}: moves ${f.amount} (smallest unit of ${f.token}) from ${f.consumer} into the channel (${f.consumer}, ${f.provider}); the channel balance is the most ${f.provider} can ever settle, and a key authorised on it can spend all of it`]
  if (kind === 'authorizeSession') return [`call: authorizeSession(provider = ${f.provider}, key = ${f.key}, expires = ${f.expires} = ${isoOf(f.expires)}) on escrow ${f.escrow}: the agent's key may sign vouchers on the channel (${f.consumer}, ${f.provider}) until then; extend-only, no revoke; never authorise a key that was authorised before`]
  if (kind === 'approve-zero') return [`call: approve(spender = ${f.escrow}, amount = 0) on token ${f.token}: clears what the escrow may still pull from ${f.consumer}`]
  if (kind === 'requestWithdraw') return [`call: requestWithdraw(provider = ${f.provider}, amount = ${f.amount}) on escrow ${f.escrow}: starts the 48-hour cooldown for taking the whole channel (${f.consumer}, ${f.provider}) back; honest providers stop serving it, but a holder of a key authorised on it can still spend it until the withdraw is executed`]
  if (kind === 'withdraw') return [`call: withdraw(provider = ${f.provider}) on escrow ${f.escrow}: pays back to ${f.consumer} what the request asked for (at most what is left); only between 48 hours and 48 hours + 7 days after the request, after which the request lapses and must be made again`]
  return []
}
function wrapFor(path, principal, fee) {
  return (inner) => (path === 'holder' ? { ...inner } : { to: principal, data: EXECUTE_SELECTOR + bytesToHex(encodeParams(['address', 'uint256', 'bytes', 'uint8'], [inner.to, 0n, inner.data, 0])), value: '0x' + (fee ?? 0n).toString(16) })
}
function stepFor(path, principal, fee) {
  const wrap = wrapFor(path, principal, fee)
  return (kind, f, inner) => {
    const tx = wrap(inner)
    const lines = path === 'holder'
      ? [`to: ${tx.to}`, `value: 0 (smallest unit of the native coin)`, ...escrowCallLines(kind, f)]
      : [`to: ${tx.to}`, `value: ${BigInt(tx.value)} (smallest unit of the native coin)`, `call: execute(to = ${inner.to}, value = 0, data = ${inner.data.slice(0, 10)}…, operation = 0 (call)) on your container ${principal}`, ...escrowCallLines(kind, f).map((l) => `  inner ${l}`),
          fee !== null ? `outer value ${fee} is the TapeOut fee the container's execute takes in the native coin, as found by simulation or supplied: it goes to TapeOut, never to the escrow or a provider` : FEE_NOTICE]
    return { kind, ...f, tx, summary: lines }
  }
}
// Review p1m3 R1: the container path's fee has a ceiling the caller names, and its total is said in whole coins
// 审查 p1m3 R1：容器路径的费用有调用方给的上限，合计以整币写明
function feeCeiling(path, fee, maxExecuteFee, principal) {
  if (maxExecuteFee === undefined) return null
  if (path !== 'container') bad('maxExecuteFee is for the container path only')
  const max = uintOf(maxExecuteFee, 'maxExecuteFee')
  if (fee !== null && fee > max) planFail(`the TapeOut fee each execute through ${principal} takes is ${fee} (smallest unit of the native coin), above your maxExecuteFee ${max}: nothing was planned (review p1m3 R1: the fee is what the container, or the nodes simulating it, say; never attached without a ceiling)`, 'execute-fee-too-high')
  return max
}
// review p1m3 recheck (1): the pure functions too never attach a fee without the caller's ceiling (the kit always gives
// both; maxExecuteFee alone is allowed: no fee is attached then) / 复核建议 1：纯函数同样不在没有上限时附上费用
function needCeiling(fee, maxExecuteFee) {
  if (fee !== null && maxExecuteFee === undefined) bad('executeFee needs maxExecuteFee, the most each execute may take as the TapeOut fee (review p1m3 R1): a fee is never attached without the caller\'s ceiling')
}
// review p1m3 S4: the holder's native coin (read strictly at the pinned block) must pay the fee of every execute
// 审查 p1m3 S4：持有人的原生币（钉块上严格读取）须付得起每笔 execute 的费
function shortOfFee(balance, fee, count, holder) {
  if (balance === null || fee === null || fee === 0n || count === 0) return
  const need = fee * BigInt(count)
  if (balance < need) planFail(`the holder ${holder} has ${balance} of the native coin (smallest unit), below ${count === 1 ? `one execute's TapeOut fee ${fee}` : `the ${count} executes' TapeOut fees, ${fee} each, ${need} in all`} (gas comes on top): fund the holder first`, 'holder-short-of-fee', { balance: balance.toString(), need: need.toString() })
}
function feeTotal(chainId, fee, count) {
  const coin = chainById(chainId)?.currency ?? 'native coin'
  const total = fee * BigInt(count)
  return { perExecute: fee.toString(), executes: count, total: total.toString(), line: `TapeOut fee: ${formatUnits(fee, 18)} ${coin} per execute × ${count} execute${count === 1 ? '' : 's'} = ${formatUnits(total, 18)} ${coin} in all (${total} smallest unit), paid to TapeOut on top of gas; the allowance repair (approve(escrow, 0)), if needed, takes one more` }
}

// ---- the session history (S4b): what the holder's console authorised / 会话历史：持有人控制台授权过的会话 ----
const HASH_RE = /^0x[0-9a-f]{64}$/
/**
 * @experimental (phase 1) One session the console authorised (or found in SessionAuthorized logs): { chainId, escrow,
 * consumer, provider, key, expires, mandateHash } with addresses checksummed, expires Unix seconds and mandateHash the
 * mandate it was authorised for, or null when not known (an entry read from the logs). claimedAtPlan (review p1m3 B1):
 * the channel's claimedOf when this mandate's plan first funded it (a decimal string), carried forward by every re-run;
 * null when not known (an entry read from the logs, or a plan made without the claimedOf fact). block (review p1m3
 * recheck 3): the block the plan's facts were read at (the kit's holderPlan writes its pin into `record`), or for a log
 * entry the block of its SessionAuthorized log; null when not known. Throws INVALID_ARGUMENT.
 * 一条会话记录；mandateHash 未知（取自日志）时为 null。claimedAtPlan：本授权书的计划第一次为该通道充值时的 claimedOf，重跑沿用；未知为 null。
 */
export function sessionEntry(e) {
  if (!e || typeof e !== 'object') bad('a session entry is an object')
  if (!Number.isSafeInteger(e.chainId) || e.chainId <= 0) bad('session entry: chainId must be a positive integer')
  for (const k of ['escrow', 'consumer', 'provider', 'key']) if (!isAddress(e[k]) || eqAddr(e[k], ZERO_ADDRESS)) bad(`session entry: ${k} must be a non-zero address`)
  if (!Number.isSafeInteger(e.expires) || e.expires <= 0) bad('session entry: expires must be Unix seconds')
  if (e.mandateHash != null && (typeof e.mandateHash !== 'string' || !HASH_RE.test(e.mandateHash.toLowerCase()))) bad('session entry: mandateHash must be a bytes32 or null')
  const claimedAtPlan = e.claimedAtPlan == null ? null : uintOf(e.claimedAtPlan, 'session entry: claimedAtPlan').toString()
  if (e.block != null && (!Number.isSafeInteger(e.block) || e.block < 0)) bad('session entry: block must be a block number or null')
  return { chainId: e.chainId, escrow: checksumAddress(e.escrow), consumer: checksumAddress(e.consumer), provider: checksumAddress(e.provider), key: checksumAddress(e.key), expires: e.expires, mandateHash: e.mandateHash == null ? null : e.mandateHash.toLowerCase(), claimedAtPlan, block: e.block ?? null }
}
/**
 * @experimental (phase 1) The console's session history (draft §2.4, §2.3 rules 1 and 3, §3b.1: MUST keep every session
 * it authorised). record(entries) after the holder sent a plan's authorizeSession (plan.record), or the entries read from
 * SessionAuthorized logs (kit.sessionLogs). One entry per session: a later record of a recorded session only fills a
 * claimedAtPlan that was null (review p1m3 recheck 3), never replaces one, and raises its block to the later one. entries() is plain JSON to keep wherever the console keeps its state, and to
 * pass back as `history` to escrowPlan, which refuses a key used before (key-reused) and a channel another key can still
 * spend on (channel-session-live). Nothing here reads the chain; a lost history is what the logs are for.
 * 控制台的会话历史：record 计划的 record 或日志读出的条目；entries() 是纯 JSON，交还给 escrowPlan 的 history。
 */
export function sessionHistory(initial = []) {
  if (!Array.isArray(initial)) bad('sessionHistory takes an array of entries')
  const list = []
  const same = (a, b) => a.chainId === b.chainId && eqAddr(a.escrow, b.escrow) && eqAddr(a.consumer, b.consumer) && eqAddr(a.provider, b.provider) && eqAddr(a.key, b.key) && a.expires === b.expires && a.mandateHash === b.mandateHash
  const add = (e) => {
    const n = sessionEntry(e)
    // a re-run's record of a session already recorded adds no entry. Review p1m3 recheck 3 (N3): its claimedAtPlan fills
    // the recorded one's only when that one is null (not known; a plan made without the claimed fact): null -> a value,
    // never a value -> another value (the first baseline is kept, so what the key spent is never forgotten)
    // 已记录的会话不再新增条目。复核 3（N3）：重跑记录的 claimedAtPlan 只在已记录的为 null 时填入；只许 null → 值，绝不值 → 另一值
    const i = list.findIndex((x) => same(x, n))
    if (i >= 0) {
      if (list[i].claimedAtPlan === null && n.claimedAtPlan !== null) list[i] = { ...list[i], claimedAtPlan: n.claimedAtPlan }
      // the latest block a run of this session was pinned at: a later re-run's pin must be after it (pin-not-after-record)
      // 本会话各次运行中最晚的钉块：之后的重跑必须钉在它之后
      if (n.block !== null && (list[i].block === null || n.block > list[i].block)) list[i] = { ...list[i], block: n.block }
      return
    }
    // a log entry (no hash) for a session already recorded with its hash adds nothing / 日志条目（无哈希）对应已带哈希记录的会话：不新增
    if (n.mandateHash === null && list.some((x) => same({ ...x, mandateHash: null }, n))) return
    list.push(n)
  }
  initial.forEach(add)
  return { record(entries) { (Array.isArray(entries) ? entries : [entries]).forEach(add) }, entries: () => list.map((e) => ({ ...e })) }
}

// A session-history entry belongs to mandate `m` (planned for `consumer`) when it carries m's hash, or, read from the
// logs (no hash), when it is on one of m's capped channels for that consumer and ends at m's expires (§2.4)
// 历史条目属于授权书 m：带 m 的哈希；或取自日志（无哈希）、在本 consumer 的带金额通道上且到期等于 m 的 expires
function belongsTo(m, mandateHash, consumer) {
  const cappedSet = new Set(m.scope.filter((s) => s.cap !== '0').map((s) => s.provider.toLowerCase()))
  return (e) => (e.mandateHash !== null ? e.mandateHash === mandateHash : eqAddr(e.consumer, consumer) && e.expires === m.expires && cappedSet.has(e.provider.toLowerCase()))
}
/**
 * Review p1m3 recheck (CE-3, CE-4): the channels (escrow, consumer) to `provider` other than (escrow, consumer) on which
 * the session history records this mandate's agent key: a provider that moved its escrow, a holder that changed (or a
 * second wallet), the other funding path. The kit reads each at its pinned block and passes them to escrowPlan as the
 * provider's `elsewhere` fact. Internal (not exported by @tapeapi/sdk/agent).
 * 复核 CE-3、CE-4：会话历史里本授权书的钥匙出现过、而不是 (escrow, consumer) 的通道；kit 在钉块上逐一读取，作为 `elsewhere` 事实交给 escrowPlan。
 */
export function mandateChannelsElsewhere(mandate, { chainId, hub, consumer, provider, escrow, history }) {
  const m = normalizeMandate(mandate)
  const belongs = belongsTo(m, mandateHashOf(chainId, hub, m), consumer)
  const out = new Map()
  for (const h of history.map(sessionEntry)) {
    if (h.chainId !== chainId || !eqAddr(h.provider, provider) || !eqAddr(h.key, m.agentKey) || !belongs(h)) continue
    if (escrow && eqAddr(h.escrow, escrow) && eqAddr(h.consumer, consumer)) continue
    out.set(`${h.escrow}:${h.consumer}`.toLowerCase(), { escrow: h.escrow, consumer: h.consumer })
  }
  return [...out.values()]
}
/**
 * Review p1m3 recheck 3 (N1): the kit's holderPlan and closeOut never run without a session history. It is the only thing
 * that makes the cap hold over several channels (another escrow, another consumer); left out, key-reused, funded-elsewhere
 * and channel-session-live were skipped in silence. [] is the console saying it has no record. Returns the history;
 * INVALID_ARGUMENT otherwise. Internal (not exported by @tapeapi/sdk/agent).
 * 复核 3（N1）：kit 的 holderPlan 与 closeOut 必须给会话历史；[] 表示控制台确认没有记录。内部函数。
 */
export function requireHistory(o, what) {
  if (!Array.isArray(o?.history)) bad(`${what} needs history: the console's session history (sessionHistory().entries(), with every plan's record), or [] when the console confirms it has none. Without it a channel this mandate's key was authorised on elsewhere (another escrow, another consumer) cannot be seen, and the cap could be funded twice (review p1m3 recheck 3; draft §10.5)`)
  return o.history
}
/**
 * @experimental (phase 1) The holder's unsigned transactions that set up the channels of a mandate that names funds
 * (draft §2.5 steps 1-4): per escrow one approve of exactly Σ (cap − channel), then fund(P, cap − channel) for each
 * capped provider, then authorizeSession(P, agentKey, expires) for each channel where the key has no session yet, then a
 * check that the allowance is back to 0 (with the approve(escrow, 0) to send if it is not).
 *   chainId        REQUIRED: the chain, for its audited escrows (AUDITED_ESCROWS)
 *   path           'holder' (F2: the principal's current holder funds from its wallet) or 'container' (F1: every call
 *                  wrapped in the principal container's execute); default DEFAULT_FUNDING_PATH (pending decision D3)
 *   holder         the wallet that sends the plan, REQUIRED (review p1m3 S6): the consumer on the holder path, the caller
 *                  of execute on the container path
 *   holderBalance  container path: the holder's native coin at the pinned block (holder-short-of-fee)
 *   providers      one entry per scope item with a cap: { provider, escrow (from its manifest; null: it names none),
 *                  escrowCode (false: the escrow has no code on this chain), token (that escrow's token(); null: none),
 *                  channel (its current channelOf, default 0), pendingLive (a live withdraw request), session (the agent
 *                  key's sessionExpiry on this channel, default 0), claimed (its claimedOf: what was ever settled on
 *                  it; optional, the kit always reads it), otherPath, elsewhere (review p1m3 recheck: [{ escrow,
 *                  consumer, channel, pendingLive, claimed }], each other channel to this provider on which the history
 *                  records this mandate's key, read at the pinned block; the kit reads every one) }
 *   allowEscrows   escrows besides AUDITED_ESCROWS (empty) the caller has decided to trust
 *   executeFee     container path only: the OUTER value of each execute (the TapeOut fee in the native coin's smallest
 *                  unit, found by simulating; a revert 0xafd49700(paid, required) states it). Left out, every execute
 *                  carries value 0 and its summary says the call may revert without the fee.
 *   maxExecuteFee  container path: the most the caller lets each execute take (review p1m3 R1); an executeFee above it
 *                  is execute-fee-too-high. Required with executeFee (an executeFee without it is INVALID_ARGUMENT, review
 *                  p1m3 recheck); the kit's holderPlan and closeOut always give it on the container path
 *   now            Unix seconds: refuse a plan whose authorizeSession would revert (expires not after now, or more than
 *                  MAX_SESSION_S ahead); required with `history`
 *   currentHolder  the principal's current holder read on chain: `holder` must be it (holder-not-current)
 *   signer         (review p1m3 recheck 3) who signed the mandate: the principal's holder when it was signed, which every
 *                  verifier compares with the CURRENT holder. Given and not `holder` (the circuit changed hands since, or
 *                  another wallet), or null (the signature holds for no address that can be named, nor for `holder`):
 *                  holder-changed-since-signing. The kit's holderPlan finds it from the signed mandate (`signed`)
 *   principalDeployed, principalOpened   container path: the principal has code, and its circuit's container was opened
 *                  (principal-not-deployed, principal-not-opened)
 *   executeReverts container path: what a simulated execute (with the fee) answered when it still reverted (execute-reverts)
 *   pinBlock       the block the facts were read at (the kit passes its pin): written into `record` as `block`; with a
 *                  history, an entry of this mandate (any channel) or of a channel this plan funds whose block is at or
 *                  after pinBlock is pin-not-after-record (review p1m3 recheck 3)
 *   history, hub   the console's session history (sessionHistory().entries()) and the hub of the mandate's domain (to
 *                  compute its hash): a key recorded for another mandate is refused (key-reused), and so is a channel
 *                  on which another recorded key's session has not ended (channel-session-live, draft §2.3 rule 3)
 *                  Omitted is NOT the same as [] (review p1m3 recheck 3): omitted, key-reused, funded-elsewhere and
 *                  channel-session-live are not checked at all, the result's `checked.history` is false and a note says
 *                  so; [] means the console confirms it has no record (`checked.history` true). The kit's holderPlan and
 *                  closeOut require it
 * Refused (INVALID_ARGUMENT with data.reason, or AGENT_INVALID for the mandate's own rules), in this order: the phase-1
 * static rules; nothing-to-plan; session-expired, session-too-long; holder-not-current; holder-changed-since-signing;
 * principal-not-deployed,
 * principal-not-opened, execute-fee-too-high, holder-short-of-fee (holderBalance below one fee), execute-reverts;
 * key-reused; pin-not-after-record; then for each capped scope item in scope order:
 * agent-key-on-fee-channel, provider-is-consumer, provider-is-escrow, provider-unresolvable, escrow-not-allowed,
 * escrow-other-chain, escrow-token-mismatch, funded-elsewhere (review p1m3 recheck CE-3/CE-4: the history records this
 * mandate's key on another channel to this provider, another escrow or another consumer, that is not released: a
 * channel of another consumer is never released; one of this consumer is released when its `elsewhere` fact says it is
 * empty without a live request and the history has its claimedAtPlan; a missing fact refuses), other-path-funded
 * (review p1m3 S1: the entry's otherPath { channel, session }, the other funding path's channel to this provider and the
 * agent key's session there, is not all 0; the kit sums it over this escrow and every escrow the history names for this
 * provider), withdraw-pending, channel-exceeds-cap, key-already-authorised (the key has a
 * session on the channel ending at another time than expires: never authorise it again, draft §2.4), channel-spent,
 * channel-exceeds-budget, budget-exhausted (review p1m3 recheck 3: the budget is 0 and the channel is fresh, empty and
 * without the key's session: no authorizeSession alone on an empty channel, no step at all), channel-session-live; last,
 * holder-short-of-fee again when holderBalance is below the fee
 * of every execute of the plan (review p1m3 S4).
 * The budget of each channel is cap − spentElsewhere − spentHere (0 at least): spentElsewhere is Σ (claimed −
 * claimedAtPlan) over the released channels elsewhere, spentHere is claimed − claimedAtPlan on this channel when the
 * key is already authorised here (0 on a fresh channel). The plan funds budget − channel; a channel above the budget is
 * channel-exceeds-budget. So, for each (mandate, provider), what the key spent on every channel the history records plus
 * what is still open to it stays within the cap; a channel the history does not record is not seen.
 * A plan already applied (review p1m3 B1): where the key's session already equals expires, the agent key can have spent
 * on the channel since, so cap − channel is NOT what is left to fund. Such a channel below its cap is refused
 * (channel-spent) unless the history holds this session's entry with claimedAtPlan (the plan's `record` carries it) and
 * `claimed` is given: then what this mandate's key spent is claimed − claimedAtPlan, the channel's budget is cap minus
 * that (0 at least), the plan funds budget − channel, and a channel above its budget is channel-exceeds-budget. So the
 * key's spending plus the channel never exceeds the cap however often the plan is run.
 * A fact left out is not checked: the kit always passes every one. The fee channel (feeCap > 0) is not planned.
 * The result carries `checked: { history, signer }`: whether a session history, and the mandate's signer, were given
 * at all (review p1m3 recheck 3).
 * The approve and fund are built for the token the caller names, which must be the scope item's token and (from the kit)
 * the escrow's own token(); they do not go through 1.8's tx.fund and its BEM-only escrow check (checkedEscrow). That is
 * for checking this experimental subpath on local chains; it does not lift the BEM restriction of tx.fund.
 * approve 与 fund 按给出的代币构造（须等于 scope 代币与托管的 token()），不经 1.8 tx.fund 的 BEM 限制；这是实验子路径的本地链
 * 验证用途，不代表放开 BEM 限制。
 */
export function escrowPlan(mandate, { chainId, path = DEFAULT_FUNDING_PATH, holder, providers, allowEscrows = [], executeFee, maxExecuteFee, now, currentHolder, principalDeployed, principalOpened, executeReverts, holderBalance, history, hub, pinBlock, signer } = {}) {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) bad('escrowPlan needs chainId (a positive integer): the audited escrows are per chain')
  if (!ESCROW_PLAN_PATHS.includes(path)) bad(`path must be one of ${ESCROW_PLAN_PATHS.join(', ')}`)
  if (!Array.isArray(allowEscrows) || !allowEscrows.every(isAddress)) bad('allowEscrows must be an array of escrow addresses')
  if (now !== undefined && (!Number.isSafeInteger(now) || now < 0)) bad('now must be Unix seconds')
  if (currentHolder !== undefined && !isAddress(currentHolder)) bad('currentHolder must be an address')
  optBool(principalDeployed, 'principalDeployed'); optBool(principalOpened, 'principalOpened')
  if (executeReverts != null && typeof executeReverts !== 'string') bad('executeReverts must be what the simulation answered (a string)')
  if (path === 'holder' && (principalDeployed !== undefined || principalOpened !== undefined || executeReverts != null)) bad('principalDeployed, principalOpened and executeReverts are facts of the container path')
  if (hub !== undefined && !isAddress(hub)) bad('hub must be the hub address of the mandate\'s domain')
  if (pinBlock !== undefined && (!Number.isSafeInteger(pinBlock) || pinBlock < 0)) bad('pinBlock must be the block number the facts were read at')
  if (signer !== undefined && signer !== null && (!isAddress(signer) || eqAddr(signer, ZERO_ADDRESS))) bad('signer must be the address that signed the mandate, or null when its signature holds for no address that can be named')
  let hist = null
  if (history !== undefined) {
    if (!Array.isArray(history)) bad('history must be an array of session entries (sessionHistory().entries())')
    if (now === undefined) bad('history needs now: a recorded session counts until it ends')
    if (hub === undefined) bad('history needs hub: entries are told apart by the hash of their mandate')
    hist = history.map(sessionEntry)
  }
  const m = normalizeMandate(mandate)
  if (!mandateNamesFunds(m)) planFail('the mandate names no funds: there is nothing to fund (a phase-0 mandate needs no transaction)', 'nothing-to-plan')
  const p = phase1Problems(m)
  if (p.length) throw new TapeAPIError('AGENT_INVALID', `escrowPlan: ${p.map((x) => x.message).join('; ')}`, { reason: p[0].code })
  const capped = m.scope.filter((s) => s.cap !== '0')
  if (!capped.length) planFail('no scope item has a cap; the fee channel (feeCap) is not planned in this version', 'nothing-to-plan')
  if (path === 'holder' && (!isAddress(holder) || eqAddr(holder, ZERO_ADDRESS))) bad('the holder path needs `holder`, the principal\'s current holder: it is the consumer of every channel')
  // review p1m3 S6: the container path needs the holder too: it calls execute, pays the fee, and its own channels are
  // the other path's (other-path-funded) / 审查 p1m3 S6：容器路径也要 holder：它调用 execute、付费，它自己的通道是另一条路径
  if (path === 'container' && (!isAddress(holder) || eqAddr(holder, ZERO_ADDRESS))) bad('the container path needs `holder`, the principal\'s current holder: it calls the container\'s execute and pays its fee')
  if (path === 'holder' && executeFee !== undefined) bad('executeFee is for the container path only: the holder path calls the token and the escrow directly')
  if (path === 'holder' && holderBalance !== undefined) bad('holderBalance is a fact of the container path (the native coin that pays the TapeOut fee)')
  const balance = holderBalance === undefined ? null : uintOf(holderBalance, 'holderBalance')
  if (path === 'holder' && maxExecuteFee !== undefined) bad('maxExecuteFee is for the container path only')
  const fee = path === 'container' && executeFee != null ? uintOf(executeFee, 'executeFee') : null
  needCeiling(fee, maxExecuteFee)
  if (now !== undefined) {
    if (m.expires <= now) planFail(`the mandate expires at ${m.expires}, not after now (${now}): authorizeSession would revert`, 'session-expired')
    if (m.expires > now + MAX_SESSION_S) planFail(`the mandate expires at ${m.expires}, more than ${MAX_SESSION_S} s after now (${now}): authorizeSession would revert (MAX_SESSION)`, 'session-too-long')
  }
  // M3: the facts about the consumer, read at the kit's pinned block (owner's decision: refuse, never take as given)
  // M3：关于 consumer 的链上事实（负责人决定：拒绝，不再"照单全收"）
  if (currentHolder !== undefined && holder !== undefined && !eqAddr(holder, currentHolder)) planFail(`${holder} is not the principal's current holder (${checksumAddress(currentHolder)}): ${path === 'holder' ? 'it would fund channels no verifier counts for this mandate' : 'the container\'s execute is the holder\'s only'}`, 'holder-not-current')
  // review p1m3 recheck 3 (CE-4 without a history): the mandate is signed by the principal's holder at signing time, and
  // every verifier checks it against the CURRENT holder (TAP-11 §4.4, not-signed-by-holder). A holder other than the
  // signer means the circuit changed hands (or another wallet): no verifier accepts the mandate any more, and funding it
  // only exposes money to the agent key. null: the signature holds for no address that can be named (nor the holder)
  // 复核 3（无历史时的 CE-4）：授权书由签署时的持有人签，核验方按当前持有人核对；持有人不是签署人即电路转手或换了钱包，授权书已不被任何核验方接受
  if (signer !== undefined && (signer === null || !eqAddr(signer, holder))) planFail(`the mandate ${signer === null ? 'carries a signature that holds neither for' : `was signed by ${checksumAddress(signer)}, not by`} ${checksumAddress(holder)}, the holder sending this plan: the principal's circuit changed hands since it was signed (or this is another wallet). Verifiers check a mandate against the principal's current holder (not-signed-by-holder), so none would accept this one; funding it would only expose the money to the agent key. Have the current holder sign a new mandate with a new agent key${path === 'holder' ? ', and close the former holder\'s channels from that wallet' : ''}`, 'holder-changed-since-signing', { signer: signer === null ? null : checksumAddress(signer) })
  if (path === 'container') {
    // draft §2.1: F1 needs the principal container deployed (a counterfactual address cannot call fund) and opened
    // §2.1：F1 要求委托方容器已部署（反事实地址调不了 fund）且已开通
    if (principalDeployed === false) planFail(`the principal container ${m.principal} has no code: a container that was never deployed cannot fund a channel (draft §2.1); use the holder path`, 'principal-not-deployed')
    if (principalOpened === false) planFail(`the principal container ${m.principal} was not opened: its execute cannot be called (draft §2.1); use the holder path`, 'principal-not-opened')
    feeCeiling(path, fee, maxExecuteFee, m.principal)
    shortOfFee(balance, fee, 1, holder)
    if (executeReverts != null) planFail(`a simulated execute through ${m.principal}${fee !== null ? ` with the fee ${fee}` : ''} still reverts (${executeReverts.slice(0, 140)}): a gate of the container (payment, listing) or a fee that cannot be found; nothing was planned`, 'execute-reverts')
  }
  if (!Array.isArray(providers)) bad('providers must be an array with one entry per scope item that has a cap')
  const allowed = new Set([...(AUDITED_ESCROWS[chainId] ?? []), ...allowEscrows].map((a) => a.toLowerCase()))
  const byProvider = new Map()
  for (const [i, e] of providers.entries()) {
    if (!e || typeof e !== 'object' || !isAddress(e.provider)) bad(`providers[${i}].provider must be an address`)
    const k = e.provider.toLowerCase()
    if (byProvider.has(k)) bad(`providers[${i}]: ${e.provider} is listed twice`)
    if (!capped.some((s) => eqAddr(s.provider, e.provider))) bad(`providers[${i}]: ${e.provider} is not a scope item with a cap`)
    if (e.escrow !== null && e.escrow !== undefined && !isAddress(e.escrow)) bad(`providers[${i}].escrow must be an address, or null when the manifest names none`)
    optBool(e.escrowCode, `providers[${i}].escrowCode`)
    byProvider.set(k, e)
  }
  const consumer = path === 'holder' ? checksumAddress(holder) : m.principal
  const mandateHash = hub !== undefined ? mandateHashOf(chainId, hub, m) : null
  // §2.4: one mandate, one key. A recorded session of this key belongs to this mandate when it carries this mandate's
  // hash, or, read from the logs (no hash), when it is on one of this mandate's channels and ends at its expires.
  // §2.4：一单一钥。本钥匙的记录属于本授权书：带本授权书哈希；或取自日志（无哈希）且在本授权书的通道上、到期等于 expires。
  const belongs = belongsTo(m, mandateHash, consumer)
  if (hist) {
    const used = hist.find((e) => e.chainId === chainId && eqAddr(e.key, m.agentKey) && !belongs(e))
    if (used) planFail(`the agent key ${m.agentKey} is in the session history for ${used.mandateHash ? `mandate ${used.mandateHash}` : 'another session'} (${used.consumer} -> ${used.provider} on ${used.escrow}, until ${used.expires}): authorising it again would revive its unsettled vouchers (draft §2.4); have the agent accept a new key`, 'key-reused')
    // review p1m3 recheck 3: the facts were read at pinBlock; an entry of this mandate (any channel), or of a channel this
    // plan funds, recorded at that block or later means the facts may not show that run's transactions yet: funding again
    // over them could fund twice. Wait until that run's transactions are final, then plan again at a later pin
    // 复核 3：事实读于 pinBlock；本授权书的条目（任一通道）或本计划所充通道的条目记于该块或之后，事实可能还看不到那次运行的交易，再充可能充两次
    if (pinBlock !== undefined) {
      const planned = new Set(capped.map((s) => byProvider.get(s.provider.toLowerCase())).filter((e) => e && isAddress(e.escrow)).map((e) => `${e.escrow}:${consumer}:${e.provider}`.toLowerCase()))
      const late = hist.find((h) => h.chainId === chainId && h.block !== null && h.block >= pinBlock && ((eqAddr(h.key, m.agentKey) && belongs(h)) || planned.has(`${h.escrow}:${h.consumer}:${h.provider}`.toLowerCase())))
      if (late) planFail(`the facts were read at block ${pinBlock}, and the session history records ${late.consumer} -> ${late.provider} on ${late.escrow} at block ${late.block}, not before it: that run's transactions may not show at this pin yet, and planning over them could fund the channel twice. Wait until they are final (afterPlan at a later pin), then plan again (review p1m3 recheck 3)`, 'pin-not-after-record', { pinBlock, recordBlock: late.block })
    }
  }
  // Review p1m12 F3: inputs that contradict each other are refused, never resolved by the last one. A zero provider is
  // refused by normalizeMandate already. / 审查 p1m12 F3：相互矛盾的输入一律拒绝，绝不以后者为准。零地址 provider 已被 normalizeMandate 拒绝。
  const namedEscrows = new Set(capped.map((s) => byProvider.get(s.provider.toLowerCase())?.escrow).filter(isAddress).map((a) => a.toLowerCase()))
  const tokenOfEscrow = new Map()   // escrow -> the token its first entry named / 托管 -> 第一个条目给出的代币
  const items = capped.map((s) => {
    const e = byProvider.get(s.provider.toLowerCase())
    if (!e) bad(`providers: no entry for ${s.provider} (its escrow, token and channel)`)
    if (eqAddr(s.provider, m.agent)) planFail(`${s.provider} is the agent's own container: authorising the agent key there would let the agent pay itself (draft §1.1 G5)`, 'agent-key-on-fee-channel')
    // a channel (consumer, consumer): the consumer would fund itself / 自己给自己开通道
    if (eqAddr(s.provider, consumer)) planFail(`${s.provider} is the consumer of the plan (${path === 'holder' ? 'the holder' : 'the principal container'}): a channel to itself pays no one else`, 'provider-is-consumer')
    // fund(escrow) reverts BadProvider on the escrow, and an escrow is never a service / 托管不是服务，fund 会回滚
    if (namedEscrows.has(s.provider.toLowerCase())) planFail(`${s.provider} is an escrow named in this plan, not a service: fund would revert`, 'provider-is-escrow')
    if (e.escrow === null) planFail(`${s.provider} names no escrow in its manifest (payment.escrow): it takes no payment, so no channel can pay it`, 'provider-unresolvable')
    if (!isAddress(e.escrow) || eqAddr(e.escrow, ZERO_ADDRESS)) planFail(`${s.provider}: escrow must be the address its manifest names (payment.escrow)`, 'escrow-not-allowed')
    if (!allowed.has(e.escrow.toLowerCase())) planFail(`${s.provider}: escrow ${e.escrow} is not an audited escrow this SDK knows (none is audited yet) nor in allowEscrows (TAPI-22 §3.5)`, 'escrow-not-allowed')
    if (e.escrowCode === false) planFail(`${s.provider}: escrow ${e.escrow} has no code on chain ${chainId}`, 'escrow-other-chain')
    if (!isAddress(e.token) || !eqAddr(e.token, s.token)) planFail(`${s.provider}: the escrow holds ${e.token ?? '(no token())'}, the mandate names ${s.token}`, 'escrow-token-mismatch')
    // one escrow holds one token (TAPI-22 v3): two entries naming one escrow with two tokens contradict each other
    // 一个托管只持有一种代币：同一托管的两个条目写了不同代币即矛盾
    const k = e.escrow.toLowerCase()
    if (tokenOfEscrow.has(k) && !eqAddr(tokenOfEscrow.get(k), e.token)) planFail(`${s.provider}: escrow ${e.escrow} is given as holding ${e.token}, and as holding ${tokenOfEscrow.get(k)} for another provider; one escrow holds one token`, 'escrow-token-mismatch')
    tokenOfEscrow.set(k, e.token)
    // review p1m3 recheck CE-3, CE-4: the cap is per (mandate, provider), not per channel. The session history records
    // this mandate's key on another channel to this provider (another escrow: the provider moved; another consumer: the
    // circuit changed hands, a second wallet, the other path). Funding this channel too is refused unless that channel is
    // released: the same consumer (the console's own wallet, which will not fund it again), read at the pinned block
    // (`elsewhere`), empty, without a live request, and with the history's claimedAtPlan; then what the key spent there
    // (claimedOf − claimedAtPlan) counts toward this channel's budget. A fact left out refuses here (not "not checked").
    // 复核 CE-3、CE-4：cap 按（授权书, provider）计，不按通道。历史里本授权书的钥匙出现在到同一 provider 的另一条通道上时拒绝，除非那条通道
    // 已放行：同一 consumer、钉块上读到、余额为 0、无存活请求、历史带 claimedAtPlan；放行后钥匙在那里花掉的计入本通道预算。缺事实即拒绝。
    let spentElsewhere = 0n
    {
      if (e.elsewhere !== undefined && !Array.isArray(e.elsewhere)) bad(`${s.provider}: elsewhere must be an array of { escrow, consumer, channel, pendingLive, claimed }`)
      const facts = (e.elsewhere ?? []).map((f, j) => {
        if (!f || typeof f !== 'object' || !isAddress(f.escrow) || !isAddress(f.consumer)) bad(`${s.provider}: elsewhere[${j}] needs escrow and consumer addresses`)
        if (f.pendingLive !== undefined && typeof f.pendingLive !== 'boolean') bad(`${s.provider}: elsewhere[${j}].pendingLive must be a boolean`)
        return { escrow: f.escrow, consumer: f.consumer, channel: uintOf(f.channel ?? 0n, `${s.provider}: elsewhere[${j}].channel`), pendingLive: f.pendingLive === true, claimed: f.claimed == null ? null : uintOf(f.claimed, `${s.provider}: elsewhere[${j}].claimed`) }
      })
      const groups = new Map()
      for (const h of hist ?? []) {
        if (h.chainId !== chainId || !eqAddr(h.provider, s.provider) || !eqAddr(h.key, m.agentKey) || !belongs(h)) continue
        if (eqAddr(h.escrow, e.escrow) && eqAddr(h.consumer, consumer)) continue
        const g = `${h.escrow}:${h.consumer}`.toLowerCase()
        if (!groups.has(g)) groups.set(g, [])
        groups.get(g).push(h)
      }
      for (const hs of groups.values()) {
        const { escrow: pe, consumer: pc } = hs[0]
        const fact = facts.find((f) => eqAddr(f.escrow, pe) && eqAddr(f.consumer, pc))
        const starts = hs.filter((h) => h.claimedAtPlan !== null).map((h) => BigInt(h.claimedAtPlan))
        // review p1m3 recheck 3: the principal container's channel (the container path) is closed through its execute by
        // the current holder, never "from" the container; and the holder path is not told to change keys for it
        // 复核 3：委托方容器的通道（容器路径）由当前持有人经 execute 收尾，不是"从容器发出"；也不因它让持有人路径换钥匙
        const viaContainer = eqAddr(pc, m.principal)
        const current = checksumAddress(currentHolder ?? holder)
        const close = viaContainer
          ? `close it first on the container path: closeOut(mandate, { path: 'container', holder: ${current}, escrows: { ${s.provider}: ${pe} }, history }), the current holder calling the container's execute`
          : `close it first: closeOut(mandate, { holder: ${pc}, escrows: { ${s.provider}: ${pe} }, history }) sent from ${pc}`
        let why = null
        if (!eqAddr(pc, consumer)) {
          why = viaContainer
            ? `it is the principal container's channel (the container path), not this plan's consumer ${consumer}'s: the container can fund it again while the key's session there lasts (until ${m.expires}), so the holder path never counts it as released; ${close}, or keep planning this mandate on the container path (path: 'container'), where that channel is the plan's own`
            : `it is the channel of ${pc}, not of this plan's consumer ${consumer}: that wallet can fund it again while the key's session there lasts (until ${m.expires}), so it is never released; ${close}, and have the agent accept a new key for a new mandate`
        }
        else if (!starts.length) why = `the history has no claimedAtPlan for it, so what the key spent there cannot be told; ${close}, and keep the plan's record`
        else if (!fact || fact.claimed === null) why = `it was not read (its channel and claimedOf at the pinned block are needed); ${close}`
        else if (fact.channel !== 0n) why = `it still holds ${fact.channel}, which the key can spend until ${m.expires}; ${close}`
        else if (fact.pendingLive) why = `a withdraw request is still live on it; finish it (withdraw) or cancel it first`
        if (why) planFail(`${s.provider}: the session history records this mandate's agent key on (${pc}, ${s.provider}) at escrow ${pe}, and ${why}. Funding (${consumer}, ${s.provider}) at ${e.escrow} as well could let the key spend more than the cap ${s.cap} over the two channels (review p1m3 recheck CE-3/CE-4)`, 'funded-elsewhere', { escrow: checksumAddress(pe), consumer: checksumAddress(pc) })
        const start = starts.reduce((a, b) => (a < b ? a : b))
        if (fact.claimed < start) bad(`${s.provider}: claimedOf of (${pc}, ${s.provider}) at ${pe} is ${fact.claimed}, below the ${start} the session history recorded: the entry is not that channel's`)
        spentElsewhere += fact.claimed - start
      }
    }
    // review p1m3 S1: the other funding path's channel to this provider (the principal's on the holder path, the holder's
    // on the container path) already holds money or a session of this key: switching paths would fund the mandate twice
    // 审查 p1m3 S1：另一条出资路径到同一 provider 的通道已有钱或本钥匙的会话：换路径会让授权书被充两次
    if (e.otherPath !== undefined) {
      if (!e.otherPath || typeof e.otherPath !== 'object') bad(`${s.provider}: otherPath must be { channel, session }`)
      const oc = uintOf(e.otherPath.channel ?? 0n, `${s.provider}: otherPath.channel`), os = uintOf(e.otherPath.session ?? 0n, `${s.provider}: otherPath.session`)
      const other = path === 'holder' ? m.principal : checksumAddress(holder)
      if (oc !== 0n || os !== 0n) planFail(`${s.provider}: the channel (${other}, ${s.provider}) of the other funding path ${oc !== 0n ? `holds ${oc}` : ''}${oc !== 0n && os !== 0n ? ' and ' : ''}${os !== 0n ? `gives the agent key a session until ${os}` : ''}: planning this path too could fund the mandate twice (review p1m3 S1); close that channel first (closeOut on the ${path === 'holder' ? 'container' : 'holder'} path), or plan on that path`, 'other-path-funded')
    }
    if (e.pendingLive !== undefined && typeof e.pendingLive !== 'boolean') bad(`${s.provider}: pendingLive must be a boolean`)
    if (e.pendingLive) planFail(`${s.provider}: a withdraw request is live on this channel; cancel it (cancelWithdraw) before funding it again (draft §2.3 rule 4)`, 'withdraw-pending')
    const channel = uintOf(e.channel ?? 0n, `${s.provider}: channel`)
    const cap = BigInt(s.cap)
    if (channel > cap) planFail(`${s.provider}: the channel already holds ${channel}, above the cap ${cap} (draft §2.3 rule 2)`, 'channel-exceeds-cap')
    // §2.4: the key's session on this channel is 0 (authorise it) or exactly expires (already authorised for this
    // mandate: nothing to send); anything else means it was authorised before for something else / 会话为 0 或恰为 expires
    const session = uintOf(e.session ?? 0n, `${s.provider}: session`)
    if (session !== 0n && session !== BigInt(m.expires)) planFail(`${s.provider}: the agent key already has a session on (${consumer}, ${s.provider}) until ${session}, not this mandate's ${m.expires}: a key is never authorised again (draft §2.4); have the agent accept a new key`, 'key-already-authorised')
    const claimed = e.claimed === undefined || e.claimed === null ? null : uintOf(e.claimed, `${s.provider}: claimed`)
    // review p1m3 B1: the session is already this mandate's (the plan was applied): the key may have spent since, so
    // cap − channel is not what is left. The budget is cap − (claimed − claimedAtPlan), from this session's history
    // entry; without it a channel below its cap is refused, never topped up again.
    // 审查 p1m3 B1：会话已是本授权书的（计划已应用过），钥匙此后可能花过钱，cap − channel 不是可充的数。预算 = cap −（claimed − claimedAtPlan），
    // 取自本会话的历史条目；没有它，低于 cap 的通道一律拒绝，绝不再充。
    // review p1m3 recheck: the budget is cap − what the key spent on this mandate's released channels elsewhere − what
    // it spent here, on a fresh channel (session 0) as on one already authorised / 复核：预算 = cap − 他处已花 − 此处已花，新通道同样适用
    let spentHere = 0n, claimedAtPlan = claimed, budgeted = true
    if (session === BigInt(m.expires)) {
      const own = (hist ?? []).filter((h) => h.chainId === chainId && eqAddr(h.escrow, e.escrow) && eqAddr(h.consumer, consumer) && eqAddr(h.provider, s.provider) && eqAddr(h.key, m.agentKey) && h.expires === m.expires && (h.mandateHash === null || h.mandateHash === mandateHash) && h.claimedAtPlan !== null)
      const start = own.length ? own.map((h) => BigInt(h.claimedAtPlan)).reduce((a, b) => (a < b ? a : b)) : null
      if (start !== null && claimed !== null) {
        if (claimed < start) bad(`${s.provider}: claimedOf is ${claimed}, below the ${start} the session history recorded when this mandate's plan funded the channel: the entry is not this channel's`)
        spentHere = claimed - start
        claimedAtPlan = start
      } else {
        budgeted = false
        if (channel < cap) planFail(`${s.provider}: the agent key is already authorised on (${consumer}, ${s.provider}) until this mandate's expires and the channel holds ${channel}, below the cap ${cap}: the key may have spent the difference, and funding it again would let it spend more than the cap. Give the session history with this plan's record (its claimedAtPlan) and the channel's claimedOf, and the plan funds only what the key has not spent`, 'channel-spent')
        // review p1m3 recheck (2): the baseline is never reset. The history's claimedAtPlan is kept even without the claimed
        // fact; without it, today's claimedOf is taken as the baseline only when it is 0 (nothing was ever settled here):
        // a channel at its cap with something settled may have been topped up by hand after the key spent, and taking
        // today's claimedOf would forget that spending / 复核建议 2：基线绝不重置。没有 claimed 时沿用历史的 claimedAtPlan；
        // 历史没有时，只有 claimedOf 为 0（从未结算过）才以它为基线：已结算过而通道在 cap 上，可能是钥匙花后手工补满，以今天的 claimedOf 为基线会忘掉那笔花费
        if (start !== null) claimedAtPlan = start
        else if (claimed !== null && claimed !== 0n) planFail(`${s.provider}: the agent key is already authorised on (${consumer}, ${s.provider}) until this mandate's expires, ${claimed} was settled on the channel, and the session history has no claimedAtPlan for this session: what the key spent cannot be told, and taking today's claimedOf as the baseline would forget it (review p1m3 recheck). Give the session history with this plan's first record`, 'channel-spent')
      }
    }
    const used = spentElsewhere + spentHere
    const budget = used >= cap ? 0n : cap - used
    if (channel > budget) planFail(`${s.provider}: the agent key has spent ${used} under this mandate${spentElsewhere ? ` (${spentElsewhere} on its earlier channels to this provider, ${spentHere} on this one)` : ` on (${consumer}, ${s.provider}) since this mandate's plan funded it`}${budgeted ? '' : ' (at least)'}, and the channel holds ${channel}: together above the cap ${cap}; withdraw the excess`, 'channel-exceeds-budget')
    // review p1m3 recheck 3 (N2): nothing is left of the cap and the channel is fresh (empty, no session of the key): an
    // authorizeSession alone would open a session on an empty channel for nothing; refused, no step at all
    // 复核 3（N2）：cap 已用尽且通道是新的（空、钥匙无会话）：单发 authorizeSession 只是在空通道上开会话；拒绝，不出任何步骤
    if (budget === 0n && channel === 0n && session === 0n) planFail(`${s.provider}: the agent key has already spent ${used} under this mandate on its earlier channels to this provider, the whole cap ${cap}: nothing is left to fund on (${consumer}, ${s.provider}) at ${e.escrow}, and a session on an empty channel serves nothing; nothing was planned (review p1m3 recheck 3)`, 'budget-exhausted', { spent: used.toString(), cap: cap.toString() })
    // §2.3 rule 3: another key the console authorised on this channel can still spend what this plan funds
    // §2.3 规则 3：控制台在这条通道上授权过的另一把钥匙仍能花本计划充的钱
    const live = hist?.find((h) => h.chainId === chainId && eqAddr(h.escrow, e.escrow) && eqAddr(h.consumer, consumer) && eqAddr(h.provider, s.provider) && !eqAddr(h.key, m.agentKey) && h.expires >= now)
    if (live) planFail(`${s.provider}: the key ${live.key} has a session on (${consumer}, ${s.provider}) until ${live.expires} (session history): it could spend what this plan funds; wait until then (draft §2.3 rule 3)`, 'channel-session-live')
    return { provider: s.provider, escrow: checksumAddress(e.escrow), token: checksumAddress(e.token), cap, channel, need: budget - channel, authorised: session !== 0n, claimedAtPlan, spentElsewhere }
  })
  const step = stepFor(path, m.principal, fee)
  const escrows = [...new Map(items.map((it) => [it.escrow.toLowerCase(), { escrow: it.escrow, token: it.token }])).values()]
  const totals = escrows.map((x) => ({ ...x, approve: items.filter((it) => eqAddr(it.escrow, x.escrow)).reduce((a, it) => a + it.need, 0n).toString() }))
  const steps = []
  for (const t of totals) if (t.approve !== '0') steps.push(step('approve', { escrow: t.escrow, token: t.token, amount: t.approve, consumer }, { to: t.token, data: encodeCall('approve', [t.escrow, BigInt(t.approve)]), value: '0x0' }))
  for (const it of items) if (it.need > 0n) steps.push(step('fund', { escrow: it.escrow, token: it.token, provider: it.provider, amount: it.need.toString(), consumer }, { to: it.escrow, data: encodeCall('fund', [it.provider, it.need]), value: '0x0' }))
  for (const it of items) if (!it.authorised) steps.push({ ...step('authorizeSession', { escrow: it.escrow, provider: it.provider, key: m.agentKey, expires: m.expires, consumer }, { to: it.escrow, data: encodeCall('authorizeSession', [it.provider, m.agentKey, BigInt(m.expires)]), value: '0x0' }), sendAfter: m.notBefore })
  // §2.1, §2.5 step 4: after the plan the allowance is 0; if a fund failed midway it is not, and this approve clears it
  // §2.5 第 4 步：计划结束后额度应为 0；中途某笔 fund 失败时不是，用这笔 approve 清零
  const checks = totals.filter((t) => t.approve !== '0').map((t) => ({ kind: 'check-allowance', escrow: t.escrow, token: t.token, owner: consumer, expect: '0', ifNot: step('approve-zero', { escrow: t.escrow, token: t.token, amount: '0', consumer }, { to: t.token, data: encodeCall('approve', [t.escrow, 0n]), value: '0x0' }) }))
  // what the console records in its session history once the authorizeSession steps were sent (S4b)
  // authorizeSession 发出后控制台记入会话历史的条目
  // claimedAtPlan: the channel's claimedOf when this mandate's plan first funded it (carried forward on a re-run), so
  // that a later run and the read-back can tell what the key spent / 首次充值时的 claimedOf（重跑沿用），供之后的重跑与读回算出钥匙花了多少
  const fees = path === 'container' && fee !== null ? feeTotal(chainId, fee, steps.length) : null
  shortOfFee(balance, fee, steps.length, holder)
  // spentElsewhere (review p1m3 recheck): what the key spent on this mandate's released channels to the provider elsewhere;
  // planApplied compares this channel with cap − spentElsewhere. sessionEntry drops it: a re-run reads it again.
  // spentElsewhere：钥匙在已放行的其它通道上花掉的；planApplied 按 cap − spentElsewhere 比较。sessionEntry 不保留它，重跑时重读。
  // block (review p1m3 recheck 3): the pin the facts were read at; a later run pinned at or before it is pin-not-after-record
  // block：读取事实的钉块；之后钉在它或它之前的运行即 pin-not-after-record
  const record = items.map((it) => ({ chainId, escrow: it.escrow, consumer, provider: it.provider, key: m.agentKey, expires: m.expires, mandateHash, claimedAtPlan: it.claimedAtPlan === null ? null : it.claimedAtPlan.toString(), block: pinBlock ?? null, spentElsewhere: it.spentElsewhere.toString() }))
  const notes = [
    'experimental phase 1: unsigned transactions only; nothing here is signed or sent, and only these transactions move money (signing the mandate moves none)',
    `send each authorizeSession at or after the mandate's notBefore (${m.notBefore}): a session is live as soon as it is authorised (draft R17)`,
    'one mandate, one key: never authorise again a key that appears in your session history; to change anything, have the agent accept a new key and sign a new mandate (draft §2.4). Record `record` in the session history once the authorizeSession steps are sent',
    ...(path === 'container' ? ['container path: every execute takes the TapeOut fee in the native coin as its outer value; supply it as executeFee after simulating (the kit\'s holderPlan does, under your maxExecuteFee), the library never writes a fee in (draft §2.1)'] : []),
    ...(fees ? [fees.line] : []),
    ...(steps.length === 0 ? ['every channel is already funded to what this mandate allows with the agent key authorised until expires: nothing to send'] : []),
    ...(items.some((it) => it.authorised) ? ['a channel where the agent key is already authorised is funded only up to cap minus what the key spent since this mandate\'s plan first funded it (claimedOf − the history\'s claimedAtPlan), never back to the cap (review p1m3 B1)'] : []),
    ...(items.some((it) => it.spentElsewhere > 0n) ? ['this mandate\'s agent key was authorised on earlier channels to a provider (another escrow), now empty: the channel here is funded only up to cap minus what the key spent there and here (review p1m3 recheck); never fund those earlier channels again before the mandate expires (their sessions last until then)'] : []),
    'the cap holds per (mandate, provider) over every channel this mandate\'s key was authorised on (any escrow, any consumer) only as far as the session history given here records them: keep every plan\'s record. With the history lost and the provider\'s escrow changed, the earlier channel cannot be found again (sessionLogs scans one escrow you name)',
    // review p1m3 recheck 3 (N1): no history given is not an empty one: say which rules were not checked
    // 复核 3（N1）：没给历史不等于历史为空：写明哪些规则没有检查
    ...(hist === null ? ['no session history was given (history omitted, not []): key-reused, funded-elsewhere and channel-session-live were NOT checked, and a channel this mandate\'s key was authorised on elsewhere (another escrow or consumer) was not looked for: the cap may be funded twice. Give the console\'s history, or [] when the console confirms it has none (checked.history says which)'] : []),
    ...(m.feeCap !== '0' ? ['the fee channel (feeCap > 0) is not planned in this version'] : []),
  ]
  return { path, consumer, chainId, principal: m.principal, agent: m.agent, agentKey: m.agentKey, notBefore: m.notBefore, expires: m.expires, mandateHash, steps, checks, totals, record, checked: { history: hist !== null, signer: signer !== undefined }, ...(fees ? { fees: { perExecute: fees.perExecute, executes: fees.executes, total: fees.total } } : {}), notes }
}

/**
 * @experimental (phase 1) The close-out of a mandate's channels (draft §2.3 rule 6, §2.6): for each capped scope item
 * whose channel holds anything, requestWithdraw(provider, the whole channel) and then withdraw(provider) inside its
 * window [requestedAt + 48 h, requestedAt + 48 h + 7 d]; a channel with a live request only needs the withdraw (a new
 * request would restart the clock); a lapsed request is made again. This is also the console's "revoke" button: the
 * money is safe from a key holder only once the withdraw is executed, and only until the channel is funded again.
 *   chainId, path (default DEFAULT_FUNDING_PATH), holder (REQUIRED on the holder path: the wallet that funded, which
 *   stays the consumer after the circuit changes hands), now (REQUIRED), executeFee and maxExecuteFee (container path,
 *   execute-fee-too-high as in escrowPlan; executeFee needs maxExecuteFee), currentHolder
 *   (container path: execute is the current holder's only: holder-not-current)
 *   channels       one entry per capped scope item: { provider, escrow (null: not known), channel, pending: { amount, requestedAt } | null }
 *   history        (review p1m3 S2) the plan's record or the console's session history: when it records sessions of this
 *                  mandate (same chain, its agent key, its expires, a capped provider) and none for this consumer, the
 *                  close-out is refused (consumer-unknown) instead of reading the wrong consumer's empty channels
 *   fullRequest    (review p1m3 S5) true: a live request for less than the channel is replaced by a request for the whole
 *                  channel (state 'replace'; its clock restarts); default false: the withdraw of that request only
 *   holderBalance  container path: the holder's native coin (holder-short-of-fee, as in escrowPlan)
 * Returns { steps (requestWithdraw first, in scope order, then withdraw), checked: { history } (whether a history was
 * given at all; omitted is not [], review p1m3 recheck 3), items: [{ provider, escrow, state: 'empty' |
 * 'request' | 'requested' | 'lapsed' | 'replace', withdrawFrom, withdrawUntil (Unix seconds, or relative to the request:
 * { afterRequestS }), remaining }], notes }. Refused, in this order: holder-not-current and execute-reverts (container
 * path: what a simulated execute answered when it reverted, draft R20; execute-fee-too-high and holder-short-of-fee
 * come before it), consumer-unknown, escrow-unknown (an entry's escrow is null: where
 * the money is is not known, draft R23), nothing-to-close (every channel is empty; data.consumerConfirmed says whether the
 * history confirmed the consumer), and on the container path holder-short-of-fee for the fee of every execute.
 * 收尾计划（也是"撤销"按钮）：对每条有余额的通道全额 requestWithdraw，再在窗口内 withdraw；已有存活请求只需 withdraw；过期请求重新请求。
 */
export function closeOutPlan(mandate, { chainId, path = DEFAULT_FUNDING_PATH, holder, channels, now, executeFee, maxExecuteFee, currentHolder, executeReverts, holderBalance, history, fullRequest = false } = {}) {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) bad('closeOutPlan needs chainId (a positive integer)')
  if (!ESCROW_PLAN_PATHS.includes(path)) bad(`path must be one of ${ESCROW_PLAN_PATHS.join(', ')}`)
  if (!Number.isSafeInteger(now) || now < 0) bad('closeOutPlan needs now (Unix seconds): whether a request is live depends on it')
  if (path === 'holder' && (!isAddress(holder) || eqAddr(holder, ZERO_ADDRESS))) bad('the holder path needs `holder`, the wallet that funded the channels (the consumer)')
  if (path === 'container' && holder !== undefined && !isAddress(holder)) bad('holder must be an address')
  if (path === 'holder' && executeFee !== undefined) bad('executeFee is for the container path only')
  if (path === 'holder' && maxExecuteFee !== undefined) bad('maxExecuteFee is for the container path only')
  if (path === 'holder' && currentHolder !== undefined) bad('currentHolder is a fact of the container path: on the holder path the wallet that funded closes its own channels, whoever holds the circuit now')
  if (currentHolder !== undefined && !isAddress(currentHolder)) bad('currentHolder must be an address')
  if (executeReverts != null && (path !== 'container' || typeof executeReverts !== 'string')) bad('executeReverts is a fact of the container path: what a simulated execute answered (a string)')
  if (path === 'holder' && holderBalance !== undefined) bad('holderBalance is a fact of the container path')
  if (typeof fullRequest !== 'boolean') bad('fullRequest must be a boolean')
  if (history !== undefined && !Array.isArray(history)) bad('history must be an array of session entries (plan.record or sessionHistory().entries())')
  const hist = history === undefined ? null : history.map(sessionEntry)
  const balance = holderBalance === undefined ? null : uintOf(holderBalance, 'holderBalance')
  const fee = path === 'container' && executeFee != null ? uintOf(executeFee, 'executeFee') : null
  needCeiling(fee, maxExecuteFee)
  const m = normalizeMandate(mandate)
  const capped = m.scope.filter((s) => s.cap !== '0')
  if (!Array.isArray(channels)) bad('channels must be an array with one entry per scope item that has a cap')
  const byProvider = new Map()
  for (const [i, e] of channels.entries()) {
    if (!e || typeof e !== 'object' || !isAddress(e.provider)) bad(`channels[${i}].provider must be an address`)
    if (byProvider.has(e.provider.toLowerCase())) bad(`channels[${i}]: ${e.provider} is listed twice`)
    if (!capped.some((s) => eqAddr(s.provider, e.provider))) bad(`channels[${i}]: ${e.provider} is not a scope item with a cap`)
    if (e.escrow !== null && (!isAddress(e.escrow) || eqAddr(e.escrow, ZERO_ADDRESS))) bad(`channels[${i}].escrow must be the escrow that holds the channel, or null when it is not known`)
    byProvider.set(e.provider.toLowerCase(), e)
  }
  if (path === 'container' && currentHolder !== undefined && holder !== undefined && !eqAddr(holder, currentHolder)) planFail(`${holder} is not the principal's current holder (${checksumAddress(currentHolder)}): the container's execute is the holder's only`, 'holder-not-current')
  if (path === 'container') { feeCeiling(path, fee, maxExecuteFee, m.principal); shortOfFee(balance, fee, 1, holder) }
  // draft R20, R10: a gate of the container (payment, listing) can stop its execute, and with it the close-out of an F1
  // channel / R20、R10：容器的门槛可能拦住 execute，F1 通道也就收不回
  if (path === 'container' && executeReverts != null) planFail(`a simulated execute through ${m.principal} still reverts (${executeReverts.slice(0, 140)}): the F1 channels cannot be closed until it passes (draft R20); they stay exposed to the agent key until ${m.expires}`, 'execute-reverts')
  // draft R23: the provider's manifest no longer names the escrow the money is in (or that escrow has no code): the
  // console names it from its plan's record; never "nothing to close" / R23：清单不再写明钱所在的托管，由控制台按计划记录给出
  const consumer = path === 'holder' ? checksumAddress(holder) : m.principal
  // review p1m3 S2: the sessions the console recorded for this mandate (same chain, its agent key, its expires, one of
  // its capped providers) name the consumer that funded; a close-out for another consumer would read empty channels
  // and say "nothing to close" / 审查 p1m3 S2：控制台为本授权书记录的会话写明了出资的 consumer；对别的 consumer 收尾只会读到空通道
  const recorded = (hist ?? []).filter((h) => h.chainId === chainId && eqAddr(h.key, m.agentKey) && h.expires === m.expires && capped.some((s) => eqAddr(s.provider, h.provider)))
  if (recorded.length && !recorded.some((h) => eqAddr(h.consumer, consumer))) planFail(`the session history records this mandate's sessions for ${[...new Set(recorded.map((h) => h.consumer))].join(', ')}, not ${consumer} (${path === 'holder' ? 'the holder path: the wallet given as holder' : 'the container path: the principal'}): close them on that path, from that wallet`, 'consumer-unknown', { recorded: [...new Set(recorded.map((h) => h.consumer))] })
  const lost = capped.find((s) => byProvider.get(s.provider.toLowerCase())?.escrow === null)
  if (lost) planFail(`${lost.provider}: the escrow its channel is in is not known (its manifest names none, or one without code, draft R23): name it from the plan's record`, 'escrow-unknown')
  const step = stepFor(path, m.principal, fee)
  const requests = [], withdraws = [], items = []
  for (const s of capped) {
    const e = byProvider.get(s.provider.toLowerCase())
    if (!e) bad(`channels: no entry for ${s.provider}`)
    const escrow = checksumAddress(e.escrow)
    const ch = uintOf(e.channel ?? 0n, `${s.provider}: channel`)
    const amount = e.pending ? uintOf(e.pending.amount ?? 0n, `${s.provider}: pending.amount`) : 0n
    const at = e.pending ? Number(uintOf(e.pending.requestedAt ?? 0n, `${s.provider}: pending.requestedAt`)) : 0
    if (ch === 0n) { items.push({ provider: s.provider, escrow, state: 'empty', remaining: '0' }); continue }
    const f = { escrow, provider: s.provider, consumer }
    // review p1m3 S5: with fullRequest, a live request for less than the channel is replaced by one for the whole channel
    // (the escrow lets a new request replace the old one and restarts its clock) / 审查 p1m3 S5：fullRequest 时把部分请求换成全额请求（重新计时）
    const replace = fullRequest && withdrawRequestLive(at, now) && amount < ch
    if (withdrawRequestLive(at, now) && !replace) {
      const out = amount < ch ? amount : ch
      items.push({ provider: s.provider, escrow, state: 'requested', amount: out.toString(), withdrawFrom: at + WITHDRAW_COOLDOWN_S, withdrawUntil: at + WITHDRAW_COOLDOWN_S + WITHDRAW_WINDOW_S, remaining: (ch - out).toString() })
      withdraws.push({ ...step('withdraw', f, { to: escrow, data: encodeCall('withdraw', [s.provider]), value: '0x0' }), sendAfter: at + WITHDRAW_COOLDOWN_S, sendBefore: at + WITHDRAW_COOLDOWN_S + WITHDRAW_WINDOW_S })
      continue
    }
    items.push({ provider: s.provider, escrow, state: replace ? 'replace' : at !== 0 ? 'lapsed' : 'request', amount: ch.toString(), ...(replace ? { replaces: { amount: amount.toString(), requestedAt: at } } : {}), withdrawFrom: { afterRequestS: WITHDRAW_COOLDOWN_S }, withdrawUntil: { afterRequestS: WITHDRAW_COOLDOWN_S + WITHDRAW_WINDOW_S }, remaining: '0' })
    requests.push(step('requestWithdraw', { ...f, amount: ch.toString() }, { to: escrow, data: encodeCall('requestWithdraw', [s.provider, ch]), value: '0x0' }))
    withdraws.push({ ...step('withdraw', f, { to: escrow, data: encodeCall('withdraw', [s.provider]), value: '0x0' }), sendAfterRequestS: WITHDRAW_COOLDOWN_S, sendBeforeRequestS: WITHDRAW_COOLDOWN_S + WITHDRAW_WINDOW_S })
  }
  // review p1m3 S2: without a recorded session of this mandate the consumer is not confirmed: say so / 没有记录的会话即 consumer 未经核对，写明
  if (!requests.length && !withdraws.length) planFail(`every channel of this mandate is empty for the consumer ${consumer}: nothing to close${recorded.length ? '' : `. Not confirmed by the session history (none given, or it records no session of this mandate): if the channels were funded from another wallet or on the ${path === 'holder' ? 'container' : 'holder'} path, close them there; give the plan's record as history to check it`}`, 'nothing-to-close', { consumer, consumerConfirmed: recorded.length > 0 })
  const cfees = path === 'container' && fee !== null ? feeTotal(chainId, fee, requests.length + withdraws.length) : null
  if (path === 'container') shortOfFee(balance, fee, requests.length + withdraws.length, holder)
  const notes = [
    'experimental phase 1: unsigned transactions only; nothing here is signed or sent',
    `until each withdraw is executed, whoever holds the agent key can still spend the channel in one transaction, and its session lasts until ${m.expires} (${isoOf(m.expires)}): do not fund these channels again before then (draft §2.6)`,
    'a request lapses 48 hours + 7 days after it was made: a withdraw not executed by then must be requested again, and until then honest providers serve the channel again (draft §2.6, R21)',
    'a cancelWithdraw undoes the request at once: show the close-out as done only once the withdraw is executed',
    ...(items.some((it) => it.state === 'requested' && it.remaining !== '0') ? ['a live request asks for less than the channel holds: after its withdraw, request the rest again (or plan with fullRequest: true to replace it now with a request for the whole channel, which restarts the 48-hour clock)'] : []),
    ...(items.some((it) => it.state === 'replace') ? ['fullRequest: a live request for part of a channel is replaced by a request for the whole channel; the escrow restarts its clock, so its withdraw comes 48 hours after the new request, not the old one'] : []),
    ...(hist === null || !recorded.length ? [`the consumer ${consumer} was not checked against the session history (none given, or it records no session of this mandate): if the channels were funded from another wallet or path, close them there`] : []),
    ...(m.feeCap !== '0' ? ['the fee channel (feeCap > 0) is not closed by this version'] : []),
    ...(cfees ? [cfees.line] : []),
  ]
  return { path, consumer, chainId, principal: m.principal, steps: [...requests, ...withdraws], items, checked: { history: hist !== null }, ...(cfees ? { fees: { perExecute: cfees.perExecute, executes: cfees.executes, total: cfees.total } } : {}), notes }
}

/**
 * @experimental (phase 1) After the holder sent a plan: the readings at a block after it (createAgentKit(api).afterPlan
 * reads them) compared with the plan, draft §2.5 step 4 and M3: for each check, allowance(consumer, escrow) must be 0
 * (allowance-not-zero, with the plan's approve(escrow, 0) to send); for each capped item, the channel plus what the
 * agent key has spent since the plan must be exactly the cap (channel-not-at-cap), and the agent key's session exactly
 * expires (session-not-set). What the key spent is claimed − the record's claimedAtPlan (review p1m3 B1: a channel the
 * key legitimately spent is not short); when the record has no claimedAtPlan (a plan made without the claimed fact) the
 * channel alone is compared with the cap, and a channel below it may have been spent: never top it up from this alone.
 *   readings  { allowances: [{ escrow, allowance }], channels: [{ provider, channel, session, claimed }] } (claimed is
 *             required for an item whose record has claimedAtPlan; the kit's afterPlan reads it)
 * Returns { ok, problems: [{ code, message, escrow?, provider?, cause? }], approveZero: [steps] }. A channel-not-at-cap
 * has a cause (review p1m3 recheck): 'excess' (above the target), 'fund-failed' (below, and its escrow's allowance is not
 * 0), 'withdrawn-or-not-sent' (below with the allowance at 0: withdrawn by the holder, or a step never sent; nothing to
 * top up unless the holder wants it), 'spent-unknown' (below, and the record has no claimedAtPlan).
 * The target is cap − the record's spentElsewhere (review p1m3 recheck), the cap when it has none.
 * 计划发出后的读回：额度为 0、通道恰为 cap、会话恰为 expires；额度不为 0 时给出 approve(escrow, 0)。
 */
export function planApplied(plan, mandate, readings = {}) {
  if (!plan || !Array.isArray(plan.checks) || !Array.isArray(plan.totals)) bad('plan must be an escrowPlan result')
  const m = normalizeMandate(mandate)
  const problems = [], approveZero = []
  const allowances = new Map((readings.allowances ?? []).map((a) => [String(a.escrow).toLowerCase(), uintOf(a.allowance ?? 0n, 'allowance')]))
  const channels = new Map((readings.channels ?? []).map((c) => [String(c.provider).toLowerCase(), c]))
  for (const k of plan.checks) {
    const a = allowances.get(k.escrow.toLowerCase())
    if (a === undefined) bad(`readings: no allowance for escrow ${k.escrow}`)
    if (a !== 0n) { problems.push({ code: 'allowance-not-zero', escrow: k.escrow, message: `${k.owner} still lets ${k.escrow} pull ${a} of ${k.token}: a fund failed midway; send the approve(escrow, 0)` }); approveZero.push(k.ifNot) }
  }
  for (const s of m.scope.filter((x) => x.cap !== '0')) {
    const c = channels.get(s.provider.toLowerCase())
    if (!c) bad(`readings: no channel for ${s.provider}`)
    const ch = uintOf(c.channel ?? 0n, 'channel'), se = uintOf(c.session ?? 0n, 'session')
    const rec = (Array.isArray(plan.record) ? plan.record : []).find((r) => eqAddr(r.provider, s.provider))
    const start = rec?.claimedAtPlan == null ? null : uintOf(rec.claimedAtPlan, 'record claimedAtPlan')
    // review p1m3 recheck: what the key spent on the mandate's earlier channels to this provider is part of the cap
    // 复核：钥匙在本授权书到该 provider 的早先通道上花掉的也占 cap
    const elsewhere = rec?.spentElsewhere == null ? 0n : uintOf(rec.spentElsewhere, 'record spentElsewhere')
    const target = elsewhere >= BigInt(s.cap) ? 0n : BigInt(s.cap) - elsewhere
    const ofTarget = elsewhere ? `cap ${s.cap} minus the ${elsewhere} the key spent on this mandate's earlier channels: ${target}` : `the cap is ${s.cap}`
    if (start !== null) {
      // review p1m3 B1: what the key spent since the plan counts toward the cap / 审查 p1m3 B1：钥匙自计划以来花掉的计入 cap
      if (c.claimed === undefined || c.claimed === null) bad(`readings: no claimed (claimedOf) for ${s.provider}: the plan recorded claimedAtPlan, and without it a spent channel cannot be told from a short one`)
      const claimed = uintOf(c.claimed, 'claimed')
      if (claimed < start) bad(`readings: claimedOf of ${s.provider} is ${claimed}, below the plan's claimedAtPlan ${start}: not this plan's channel`)
      const spent = claimed - start
      // review p1m3 recheck (3): short of the target, a fund that failed midway leaves its allowance; with the allowance
      // back to 0 the channel was withdrawn from (or a fund step was never sent), which needs nothing
      // 复核建议 3：低于目标时，中途失败的 fund 会留下额度；额度已为 0 即通道被取回过（或某笔 fund 没发），不需要补
      const funded = Array.isArray(plan.steps) && plan.steps.some((st) => st.kind === 'fund' && eqAddr(st.provider, s.provider))
      const left = funded && rec?.escrow ? allowances.get(String(rec.escrow).toLowerCase()) : undefined
      const short = ch + spent < target
      const cause = !short ? 'excess' : left !== undefined && left !== 0n ? 'fund-failed' : 'withdrawn-or-not-sent'
      const what = { excess: ': withdraw the excess', 'fund-failed': `: a fund failed midway (the allowance is still ${left}): send the approve(escrow, 0), then run the plan again with the session history`, 'withdrawn-or-not-sent': ': no allowance is left over, so no fund failed with its approve outstanding: either the channel was withdrawn from since the plan (requestWithdraw + withdraw: expected, nothing to send), or a fund step was never sent; run the plan again with the session history only to fund it back (it funds only what the key has not spent)' }[cause]
      if (ch + spent !== target) problems.push({ code: 'channel-not-at-cap', cause, provider: s.provider, message: `the channel (${plan.consumer}, ${s.provider}) holds ${ch} and the agent key spent ${spent} on it since the plan: ${ch + spent} in all, ${ofTarget}${what}` })
    } else if (ch !== target) problems.push({ code: 'channel-not-at-cap', cause: ch > target ? 'excess' : 'spent-unknown', provider: s.provider, message: `the channel (${plan.consumer}, ${s.provider}) holds ${ch}, ${ofTarget}${ch < target ? ' (if the agent key has spent on it since, this is expected: never top it up from this reading alone; read claimedOf)' : ''}` })
    if (se !== BigInt(m.expires)) problems.push({ code: 'session-not-set', provider: s.provider, message: `the agent key's session on (${plan.consumer}, ${s.provider}) ends at ${se}, the mandate at ${m.expires}` })
  }
  return { ok: problems.length === 0, problems, approveZero }
}

// ---- phase 1, M4 (experimental): the agent runtime's spend limiter (draft §3b.2 last paragraph, §6.1 S5, §10.7) ----
// What the agent key signs is bounded by the channel on chain whatever happens (G1); this bounds it again outside the
// model, so that a prompt injection cannot make the agent "legitimately" sign a large voucher. Per (mandate, provider)
// the ceiling is claimedAtCheck + cap, where claimedAtCheck is the channel's claimedOf at the check that STARTED the work
// (draft §2.3 rule 5) and is never moved up afterwards; a voucher is signed out only when its cumulative is at most the
// ceiling. A cumulative voucher pays at most cumulative − claimedOf, and claimedOf never falls below that start, so
// everything this key's vouchers can ever make the channel pay is at most (highest cumulative signed) − claimedAtCheck ≤
// cap: the same measure as the holder's plan (claimedOf − claimedAtPlan, draft §10.4 B1, §10.5). One channel per
// (mandate, provider): the escrow and the consumer of the start are pinned, and a voucher for any other is refused and
// stops the work (R23). The record is written BEFORE a voucher leaves (write-ahead), one record per agent key, and a
// key without a record never signs (a lost record is a refusal, never a fresh start). Nothing here reads the chain.
// 阶段 1 的 M4：代理运行时的花费限额器。每个（授权书, provider）的上限是开工核验时的 claimedOf 加 cap，之后绝不上移；
// 凭证的 cumulative 不超过它才签出。一个（授权书, provider）只用一条通道：托管与 consumer 在开工时钉住，换了即拒绝并停工。
// 记录在凭证离开之前写入；没有记录的钥匙绝不签名（记录丢失即拒绝，绝不重新开始）。不读链。
export const SPEND_RECORD_VERSION = 1
// the order in which spendDecision refuses / spendDecision 的拒绝顺序
export const SPEND_REFUSALS = Object.freeze(['spend-not-started', 'spend-stopped', 'spend-other-chain', 'spend-out-of-scope', 'spend-escrow-changed', 'spend-consumer-changed', 'spend-not-yet', 'spend-expired', 'spend-bad-amount', 'spend-call-price-ceiling-above-cap', 'spend-call-price-ceiling-unset', 'spend-call-price-above-ceiling', 'spend-cap-exceeded'])
// the default per-call price ceiling (Bruce, 2026-10-08): this share of the (mandate, provider) cap, rounded down to the
// token's smallest unit; a default of 0 is no default (the caller must set maxCallPrice); an explicit one may be above
// it, never above the cap / 单次调用价格上限的默认值：cap 的 10%，向下取整到最小单位；为 0 即没有默认值（须显式设置）；显式值可高于它，不得高于 cap
export const SPEND_DEFAULT_CALL_PRICE_PERCENT = 10
// the reasons that stop an order for good (recorded in the record's `stopped`) / 让一单永久停工的原因
export const SPEND_STOPS = Object.freeze(['spend-mandate-changed', 'spend-revoked', 'spend-expired', 'spend-other-chain', 'spend-escrow-changed', 'spend-consumer-changed', 'spend-voucher-mismatch'])
const spendRefuse = (reason, msg, extra) => { throw new TapeAPIError('AGENT_SPEND_REFUSED', msg, { reason, ...extra }) }
const uintStr = (v, name) => uintOf(v, name).toString()
const addrOf = (v, name) => { if (!isAddress(v) || eqAddr(v, ZERO_ADDRESS)) bad(`${name} must be a non-zero address`); return checksumAddress(v) }
/**
 * @experimental (phase 1, M4) A spend record, checked and normalised (the JSON the limiter keeps per agent key):
 * { v: 1, chainId, agentKey, seq, state: 'accepted' | 'started', mandateHash, consumer, notBefore, expires, stopped: null |
 * { reasons, at }, providers: [{ provider, escrow, token, cap, base, hi }] } (amounts decimal strings; base is the
 * channel's claimedOf at the start, hi the highest cumulative ever signed on it or read settled, never below base; seq
 * the record's version, raised by one at each write, 0 when absent). Throws INVALID_ARGUMENT.
 * 一条花费记录（限额器按代理钥匙保存的 JSON），校验并规范化。
 */
export function spendRecord(r) {
  if (!r || typeof r !== 'object') bad('a spend record is an object')
  if (r.v !== SPEND_RECORD_VERSION) bad(`spend record: v must be ${SPEND_RECORD_VERSION}`)
  if (!Number.isSafeInteger(r.chainId) || r.chainId <= 0) bad('spend record: chainId must be a positive integer')
  // seq (review p1m4): the record's version, raised by one at each write; a record without one is at 0 / 记录的版本号
  if (r.seq != null && (!Number.isSafeInteger(r.seq) || r.seq < 0)) bad('spend record: seq must be a non-negative integer')
  const out = { v: SPEND_RECORD_VERSION, chainId: r.chainId, agentKey: addrOf(r.agentKey, 'spend record: agentKey'), seq: r.seq ?? 0, state: r.state, mandateHash: null, consumer: null, notBefore: null, expires: null, stopped: null, providers: [] }
  if (r.state === 'accepted') return out
  if (r.state !== 'started') bad('spend record: state must be accepted or started')
  if (typeof r.mandateHash !== 'string' || !HASH_RE.test(r.mandateHash.toLowerCase())) bad('spend record: mandateHash must be a bytes32')
  out.mandateHash = r.mandateHash.toLowerCase()
  out.consumer = addrOf(r.consumer, 'spend record: consumer')
  for (const k of ['notBefore', 'expires']) { if (!Number.isSafeInteger(r[k]) || r[k] < 0) bad(`spend record: ${k} must be Unix seconds`); out[k] = r[k] }
  if (r.stopped != null) {
    if (!Array.isArray(r.stopped.reasons) || !r.stopped.reasons.every((x) => typeof x === 'string')) bad('spend record: stopped.reasons must be strings')
    out.stopped = { reasons: [...r.stopped.reasons], at: Number.isSafeInteger(r.stopped.at) ? r.stopped.at : null }
  }
  if (!Array.isArray(r.providers) || r.providers.length === 0) bad('spend record: providers must list the capped providers')
  for (const p of r.providers) {
    const x = { provider: addrOf(p?.provider, 'spend record: provider'), escrow: addrOf(p.escrow, 'spend record: escrow'), token: addrOf(p.token, 'spend record: token'), cap: uintStr(p.cap, 'spend record: cap'), base: uintStr(p.base, 'spend record: base'), hi: uintStr(p.hi, 'spend record: hi') }
    if (x.cap === '0') bad('spend record: a provider without a cap has no channel to spend on')
    if (BigInt(x.hi) < BigInt(x.base)) bad('spend record: hi is never below base')
    if (out.providers.some((y) => eqAddr(y.provider, x.provider))) bad('spend record: a provider is listed once')
    out.providers.push(x)
  }
  return out
}
/**
 * @experimental (phase 1, M4) The record a check STARTS: from a verifyMandate(signed, { enforcement: 'escrow-channel' })
 * result that is ok with enforcement 'escrow-channel' (and only such a one), the channel of each capped provider pinned:
 * its escrow, the consumer, and base = its claimedAtCheck, the start of the ceiling base + cap. Pure.
 * 由开工核验的结果钉住每个带金额 provider 的通道：托管、consumer、base = claimedAtCheck。纯函数。
 */
export function spendPin(check, { chainId, agentKey } = {}) {
  if (!check || check.ok !== true || check.enforcement !== 'escrow-channel' || check.phase !== 1) spendRefuse('spend-not-enforced', 'only a check that is ok with enforcement escrow-channel starts the spending: verifyMandate(signed, { enforcement: \'escrow-channel\' }) and nothing else', { problems: (check?.problems ?? []).map((p) => p.code) })
  const m = normalizeMandate(check.mandate)
  if (agentKey !== undefined && !eqAddr(agentKey, m.agentKey)) spendRefuse('spend-key-mismatch', `the check is of a mandate for agent key ${m.agentKey}, not ${agentKey}`)
  const providers = m.scope.filter((s) => s.cap !== '0').map((s) => {
    const item = (check.scope ?? []).find((x) => eqAddr(x.provider, s.provider))
    if (!item || item.escrow == null || item.claimedAtCheck == null) bad(`the check has no channel reading for ${s.provider}`)
    return { provider: s.provider, escrow: item.escrow, token: s.token, cap: s.cap, base: item.claimedAtCheck, hi: item.claimedAtCheck }
  })
  return spendRecord({ v: SPEND_RECORD_VERSION, chainId, agentKey: m.agentKey, state: 'started', mandateHash: check.mandateHash, consumer: check.consumer, notBefore: m.notBefore, expires: m.expires, stopped: null, providers })
}
/**
 * @experimental (phase 1, M4) May the agent key sign a voucher of `cumulative` for `price` to `provider` on `escrow` for
 * `consumer` now? The first rule that applies, in SPEND_REFUSALS order: no check started the record; the record stopped; another chain; a provider
 * that is not a capped scope item; another escrow or consumer than the start pinned; outside [notBefore, expires]; a price
 * or cumulative of 0; the per-call price ceiling: `maxPrice` when given (the caller's maxCallPrice for this provider; above
 * the provider's cap is spend-call-price-ceiling-above-cap), otherwise SPEND_DEFAULT_CALL_PRICE_PERCENT of the cap rounded
 * down (0 is spend-call-price-ceiling-unset: set maxCallPrice), and a price above it is spend-call-price-above-ceiling;
 * a cumulative above base + cap. None of the three ceiling refusals stops the order. `stop` says whether the reason
 * stops the order for good. Allowed: { ok: true, hi (the new highest cumulative), spent (hi − base: the most this key's
 * vouchers can make the channel pay), remaining (cap − spent) }. Pure.
 * 能否签出这张凭证；按 SPEND_REFUSALS 的顺序给出第一条适用的拒绝。单次调用价格上限：给了 maxPrice 用它（不得高于 cap），
 * 否则为 cap 的 10% 向下取整（为 0 即须显式设置）；三条上限拒绝都不停工。纯函数。
 */
export function spendDecision(record, { chainId, provider, escrow, consumer, cumulative, price, now, maxPrice } = {}) {
  const r = spendRecord(record)
  const no = (refused, message) => ({ ok: false, refused, stop: SPEND_STOPS.includes(refused), message })
  if (r.state !== 'started') return no('spend-not-started', 'the work has not started: no check started this key')
  if (r.stopped) return no('spend-stopped', `the order was stopped (${r.stopped.reasons.join(', ')}): this key signs nothing more`)
  if (chainId !== r.chainId) return no('spend-other-chain', `the voucher would be for chain ${chainId}, the mandate's is ${r.chainId}`)
  const pin = isAddress(provider) ? r.providers.find((x) => eqAddr(x.provider, provider)) : undefined
  if (!pin) return no('spend-out-of-scope', `${provider} is not a provider with a cap in the mandate's scope`)
  if (!isAddress(escrow) || !eqAddr(escrow, pin.escrow)) return no('spend-escrow-changed', `${provider} now names escrow ${escrow}; the work started on ${pin.escrow} (R23): stopped`)
  if (!isAddress(consumer) || !eqAddr(consumer, r.consumer)) return no('spend-consumer-changed', `the voucher would be for consumer ${consumer}; the work started for ${r.consumer}: stopped`)
  if (!Number.isSafeInteger(now)) bad('now must be Unix seconds')
  if (now < r.notBefore) return no('spend-not-yet', `the mandate is valid from ${r.notBefore}, now ${now}`)
  if (now > r.expires) return no('spend-expired', `the mandate expired at ${r.expires}, now ${now}: stopped`)
  const c = uintOf(cumulative, 'cumulative'), p = uintOf(price, 'price')
  if (c === 0n || p === 0n) return no('spend-bad-amount', 'a voucher is for a price above 0 and a cumulative above 0')
  const base = BigInt(pin.base), cap = BigInt(pin.cap), ceiling = base + cap
  // the per-call price ceiling (Bruce, 2026-10-08) / 单次调用价格上限
  const how = `set maxCallPrice for ${pin.provider} explicitly (in the token's smallest unit, at most the cap ${cap})`
  let callCeiling
  if (maxPrice !== undefined && maxPrice !== null) {
    callCeiling = uintOf(maxPrice, 'maxPrice')
    if (callCeiling > cap) return no('spend-call-price-ceiling-above-cap', `the maxCallPrice ${callCeiling} for ${pin.provider} is above the mandate's cap ${cap} for it: one call may cost at most the cap; ${how}`)
  } else {
    callCeiling = cap * BigInt(SPEND_DEFAULT_CALL_PRICE_PERCENT) / 100n
    if (callCeiling === 0n) return no('spend-call-price-ceiling-unset', `the default per-call ceiling, ${SPEND_DEFAULT_CALL_PRICE_PERCENT}% of the cap ${cap} for ${pin.provider}, rounds down to 0 in the token's smallest unit, so there is none: ${how}`)
  }
  if (p > callCeiling) return no('spend-call-price-above-ceiling', `the call costs ${p}, above the per-call ceiling ${callCeiling} for ${pin.provider} (${maxPrice !== undefined && maxPrice !== null ? 'the maxCallPrice given' : `the default, ${SPEND_DEFAULT_CALL_PRICE_PERCENT}% of the cap ${cap}`}); not signed, not stopped: to allow it, ${how}`)
  if (c > ceiling) return no('spend-cap-exceeded', `a voucher of cumulative ${c} on (${r.consumer}, ${pin.provider}) would let ${c - base} be paid since the start (claimedOf ${base}), above the mandate's cap ${cap}`)
  const hi = c > BigInt(pin.hi) ? c : BigInt(pin.hi)
  return { ok: true, hi: hi.toString(), spent: (hi - base).toString(), remaining: (ceiling - hi).toString() }
}
/**
 * @experimental (phase 1, M4) A later check (each call, each milestone) against the record: the reasons that stop the work
 * for good (`stop`: another mandate hash, a revoked or expired mandate, another consumer, a provider that names another
 * escrow than the start pinned, R23) and the check's own problems (`problems`: the step is refused while any is there:
 * a live withdraw request, an empty channel, ...). A check with no problem of its own that is not an enforced phase-1
 * check (phase 1, enforcement 'escrow-channel', a reading with escrow and claimedAtCheck for every pinned provider) has
 * the problem spend-not-enforced (review p1m4: a phase-0 result proves nothing about the channels). `hi`: each
 * provider's highest cumulative raised to the claimedOf the check read on the pinned escrow for the pinned consumer when
 * that is higher (whatever was settled counts, by anyone: never less; another consumer's channel raises nothing).
 * `hi` is bookkeeping (spent, remaining): spendDecision bounds a voucher by base + cap only. ok only with no stop and
 * no problem. Pure.
 * 之后每次核验与记录比对：永久停工的原因（stop）与本次核验自己的问题（problems，有则拒绝这一步）；没有自身问题却不是强制执行的
 * 阶段 1 核验（阶段 1、escrow-channel、每个钉住的 provider 都有读数）即 spend-not-enforced；hi 至少抬到在钉住的托管与 consumer 上
 * 读到的 claimedOf（hi 只是记账，上限只看 base + cap）。纯函数。
 */
export function spendRecheck(record, check) {
  const r = spendRecord(record)
  if (r.state !== 'started') bad('spendRecheck needs a started record')
  if (!check || typeof check !== 'object') bad('check must be a verifyMandate result')
  const codes = (check.problems ?? []).map((p) => p.code)
  const stop = []
  if (typeof check.mandateHash === 'string' && check.mandateHash.toLowerCase() !== r.mandateHash) stop.push('spend-mandate-changed')
  if (codes.includes('mandate-revoked')) stop.push('spend-revoked')
  if (codes.includes('mandate-expired')) stop.push('spend-expired')
  const sameConsumer = check.consumer != null && eqAddr(check.consumer, r.consumer)
  if (check.consumer != null && !sameConsumer) stop.push('spend-consumer-changed')
  let readings = true
  const hi = r.providers.map((p) => {
    const item = (check.scope ?? []).find((x) => eqAddr(x.provider, p.provider))
    if (item?.escrow == null || item?.claimedAtCheck == null) readings = false
    if (item?.escrow != null && !eqAddr(item.escrow, p.escrow) && !stop.includes('spend-escrow-changed')) stop.push('spend-escrow-changed')
    // review p1m4: only the pinned channel's claimedOf counts: the pinned escrow AND the pinned consumer
    // 审查 p1m4：只有钉住的通道（托管与 consumer 都对）的 claimedOf 才计入
    const claimed = sameConsumer && item?.claimedAtCheck != null && item?.escrow != null && eqAddr(item.escrow, p.escrow) ? BigInt(item.claimedAtCheck) : 0n
    return (claimed > BigInt(p.hi) ? claimed : BigInt(p.hi)).toString()
  })
  // review p1m4: a check without problems of its own must still be an enforced phase-1 check with every reading
  // (a phase-0 result, enforcement 'none', no scope readings, proves nothing about the channels)
  // 审查 p1m4：没有自身问题的核验也必须是强制执行的阶段 1 核验、读数齐全（阶段 0 的结果不说明通道的任何情况）
  if (codes.length === 0 && (check.phase !== 1 || check.enforcement !== 'escrow-channel' || !readings)) codes.push('spend-not-enforced')
  return { ok: stop.length === 0 && codes.length === 0 && check.ok === true, stop, problems: codes, hi }
}
// the order in which spendResume refuses (phase 1, restart) / spendResume 的拒绝顺序
export const SPEND_RESUME_REFUSALS = Object.freeze(['spend-state-lost', 'spend-stopped', 'spend-key-lost', 'spend-key-unreadable', 'spend-key-mismatch', 'spend-resume-mismatch'])
/**
 * @experimental (phase 1, restart) May an order resume after a restart with the key its vault opened? The record of its
 * agent key (null: none), the chain and agent key the order names, `key` (the address the opened secret derives to, or
 * 'missing' when the store holds no sealed key, 'unreadable' when the vault could not open it) and `mandateHash` (the
 * hash of the fresh check of the order's stored mandate; null for an order that has no mandate yet). The first that
 * applies, in SPEND_RESUME_REFUSALS order: no record; a stopped record (never resumed: stopped, revoked, expired, another
 * escrow or consumer...); no sealed key; a key that does not open; a key, chain or record of another agent key; a
 * started record of another mandate than the check's, or an accepted one given a mandate. ok: the caller then checks
 * again (spendRecheck) before anything is signed. Pure.
 * 重启后能否以保险箱打开的钥匙恢复订单。按 SPEND_RESUME_REFUSALS 的顺序：无记录；已停工（绝不恢复）；无密文；打不开；
 * 钥匙、链或记录不是这把钥匙的；已开工的记录与核验的授权书不同，或尚未开工的记录却给了授权书。通过后调用方还要复核才签名。纯函数。
 */
export function spendResume(record, { chainId, agentKey, key, mandateHash = null } = {}) {
  const no = (refused, message) => ({ ok: false, refused, message })
  if (record == null) return no('spend-state-lost', `no spend record for agent key ${agentKey}: an order without its record never resumes (a lost record is not a fresh start)`)
  const r = spendRecord(record)
  if (r.stopped) return no('spend-stopped', `the order of agent key ${r.agentKey} was stopped (${r.stopped.reasons.join(', ')}): it never resumes, and its sealed key is destroyed`)
  if (key === 'missing') return no('spend-key-lost', `the store holds no sealed key for agent key ${r.agentKey}: it was never kept, or was destroyed when the order ended; the order cannot resume`)
  if (key === 'unreadable') return no('spend-key-unreadable', `the sealed key of agent key ${r.agentKey} does not open: a wrong passphrase or key, a blob changed in the store, or the blob of another key; nothing is signed, and the blob is kept (restart with the right passphrase)`)
  if (chainId !== r.chainId || !isAddress(agentKey) || !eqAddr(agentKey, r.agentKey) || !isAddress(key) || !eqAddr(key, r.agentKey)) return no('spend-key-mismatch', `the sealed key opens to ${key} on chain ${chainId} for the order's agent key ${agentKey}; the record is of ${r.agentKey} on chain ${r.chainId}: nothing is signed`)
  if (r.state === 'started' ? (typeof mandateHash !== 'string' || mandateHash.toLowerCase() !== r.mandateHash) : mandateHash != null) return no('spend-resume-mismatch', r.state === 'started' ? `the check is of mandate ${mandateHash}; the record of agent key ${r.agentKey} started on ${r.mandateHash}: the order's stored mandate does not match its record, not resumed` : `the record of agent key ${r.agentKey} has not started, yet a mandate (${mandateHash}) was given: not resumed`)
  return { ok: true }
}
/**
 * @experimental (phase 1, M4) The agent runtime's spend limiter around api.payer({ consumer, sessionKey: agentKey })
 * (draft §6.1 S5). One record per agent key in `store` ({ get(key), set(key, value, { ifSeq }) }, strings, may be async;
 * default memory: a restart forgets the records, so a key that outlives its process never signs again). The record is
 * created when the key is announced (accept), pinned by the check that starts the work (start), compared with every later
 * check (recheck), and consulted and written before each voucher leaves (payer(...).reserve). A key whose record is
 * missing never signs (spend-state-lost): a restart without the store is a refusal, never a fresh ceiling.
 *
 * ONE WRITER PER RECORD is the premise (review p1m4): within one limiter every read-modify-write of a record runs alone,
 * and between limiters (two processes on one database) the record's `seq` is compared. Every write re-reads the record
 * first; a record that moved on (another writer) is never overwritten: a stop found there refuses (spend-stopped), and
 * anything else is decided again on the fresh record (a voucher already signed is released and refused when it no
 * longer fits). A stop is also written, before the record, under a key of its own (`<key>:stopped`) that only a stop
 * writes and that is read with the record, and a voucher leaves only when that key is still empty after the record was
 * written: no other writer can erase a stop, whatever the store. The re-read leaves a window between it and the write
 * for everything else (two starts of one key pinning different bases, a hi written lower again): only a store whose
 * set(key, value, { ifSeq }) writes when the stored record's seq equals ifSeq (null: when there is none) and returns
 * false otherwise (compare-and-set) closes it; with a store that ignores ifSeq, one writer per record. The default memory
 * store honours ifSeq.
 *   accept({ chainId, agentKey })            a new key; a key the store already knows is spend-key-known
 *   start({ chainId, check })                the record of the check that starts the work; once started, the same
 *                                            mandate keeps its start (base never moves), a stopped record is
 *                                            spend-stopped, a check of another escrow or consumer stops it (the stops
 *                                            of spendRecheck), another mandate is spend-key-reused
 *   recheck({ chainId, check })              spendRecheck, the stop written to the record, hi raised
 *   payer({ chainId, payer, maxPrice, signed })  a payer of the same shape as api.payer's (maxPrice: the per-call
 *                                            price ceiling, one amount for every provider or { [provider]: amount };
 *                                            a provider without one gets the default, 10% of its cap, see
 *                                            spendDecision): reserve(svc, price) refuses
 *                                            (AGENT_SPEND_REFUSED, data.reason one of SPEND_REFUSALS,
 *                                            spend-voucher-mismatch, spend-state-lost, spend-state-conflict or
 *                                            spend-channel-short) before or after the inner payer signs, and a refused
 *                                            voucher is released and never returned; an allowed one carries the
 *                                            unsigned member mandateHash, and the signed mandate `signed` until a
 *                                            voucher to that provider was accepted (its lease committed) through this
 *                                            payer: a released voucher, or a new payer after a restart, attaches it again
 *   record({ chainId, agentKey }), stop({ chainId, agentKey, reason })
 * Phase 1, restart (with `vault`, a KeyVault: the operator's passphrase, key or KMS; never without one):
 *   keepKey({ chainId, agentKey, secret })   the key's secret sealed by the vault and stored under `<key>:key` (only the
 *                                            blob is stored, never the secret); the record must exist and not be stopped
 *   resume({ chainId, agentKey, check })     after a restart, on a new limiter over the same store: the record read, the
 *                                            sealed key opened and matched (spendResume: a stopped record, no key, a key
 *                                            that does not open or is another's, another mandate refuse, failing
 *                                            closed), then, for a started record, `check` (a fresh verifyMandate of the
 *                                            order's stored mandate) compared as recheck does (a stop is written and
 *                                            refuses); { record, secret, recheck }. base, hi, seq and the stop key keep
 *                                            their rules: resume writes only through the same compare-and-set path
 *   forgetKey({ chainId, agentKey })         the sealed key destroyed (the order ended); every stop destroys it too
 * A key the store has no record of, or no sealed key for, never resumes.
 * spend-channel-short (no stop): the last recheck read less available on the pinned channel than the price, so the
 * provider would refuse the voucher; nothing is signed until a later recheck reads more.
 * 代理运行时的花费限额器，包在 api.payer({ consumer, sessionKey }) 外面。每把钥匙一条记录；没有记录的钥匙绝不签名。
 * 前提是每条记录只有一个写者：进程内串行；跨进程比对记录的 seq，写之前先重读，记录变了绝不覆盖（已停工即拒绝）；
 * 只有支持 set(key, value, { ifSeq }) 比较并写入的存储才能关上重读与写入之间的窗口。
 */
export function createSpendLimiter({ store, clock = () => Math.floor(Date.now() / 1000), vault } = {}) {
  if (store !== undefined && (typeof store?.get !== 'function' || typeof store?.set !== 'function')) bad('store must be { get(key), set(key, value, { ifSeq }) }')
  if (typeof clock !== 'function') bad('clock must be a function returning Unix seconds')
  if (vault !== undefined && (typeof vault?.seal !== 'function' || typeof vault?.open !== 'function')) bad('vault must be a key vault { seal(bytes, { context }), open(blob, { context }) }')
  const mem = new Map()
  const seqIn = (s) => (s == null || s === '' ? null : (JSON.parse(s).seq ?? 0))
  // the default store compares and sets / 默认存储比较并写入
  const st = store ?? { get: (k) => mem.get(k) ?? null, set: (k, v, o) => { if (o && 'ifSeq' in o && seqIn(mem.get(k)) !== o.ifSeq) return false; mem.set(k, v); return true }, delete: (k) => { mem.delete(k) } }
  // phase 1, restart: the agent key sealed by the vault, under a key of its own; destroyed by every stop (and by
  // forgetKey when the order ends) / 阶段 1 的重启：保险箱封存的代理钥匙存在自己的键下；任何停工（以及订单结束时的 forgetKey）都销毁它
  const keyBlobKey = (k) => `${k}:key`
  const dropBlob = async (k) => { if (typeof st.delete === 'function') await st.delete(keyBlobKey(k)); else await st.set(keyBlobKey(k), '') }
  const locks = new Map()
  const keyOf = (chainId, agentKey) => {
    if (!Number.isSafeInteger(chainId) || chainId <= 0) bad('chainId must be a positive integer')
    return `tapeapi-spend:${chainId}:${addrOf(agentKey, 'agentKey').toLowerCase()}`
  }
  // one record, one queue: every read-modify-write of a record runs alone in this limiter / 一条记录一个队列
  const serial = (k, fn) => { const p = (locks.get(k) ?? Promise.resolve()).then(fn, fn); locks.set(k, p.catch(() => {})); return p }
  // review p1m4: a stop is also kept under a key of its own that only a stop ever writes, so no writer of the record (a
  // write-ahead save that lost a race) can erase it, whatever the store; the record is read with it
  // 审查 p1m4：停工另存在只有停工才写的键下，任何记录写者（输掉竞争的先记账）都抹不掉它，不论存储如何；读记录时合并
  const stopKey = (k) => `${k}:stopped`
  const stopMark = async (k) => { const s = await st.get(stopKey(k)); if (s == null || s === '') return null; const x = JSON.parse(s); return { reasons: Array.isArray(x?.reasons) ? x.reasons.map(String) : ['spend-stopped'], at: Number.isSafeInteger(x?.at) ? x.at : null } }
  const load = async (k) => {
    const s = await st.get(k)
    if (s == null || s === '') return null
    const r = spendRecord(JSON.parse(s))
    if (r.state === 'started' && !r.stopped) { const m = await stopMark(k); if (m) r.stopped = m }
    return r
  }
  const seqOf = (r) => (r ? r.seq : null)
  // the first stop is kept: a stop key already written is never replaced / 第一次停工保留，已写的停工键绝不替换
  // a stop also destroys the sealed key: a stopped order never resumes, whatever is restarted / 停工同时销毁封存的钥匙
  const markStop = async (k, stopped) => { if (!(await stopMark(k))) await st.set(stopKey(k), JSON.stringify(stopped)); await dropBlob(k) }
  // review p1m4: write `r`, the next version of the record read at seq `from` (null: none). The record is read again
  // first; one that moved on is a conflict, never overwritten, and a store that honours ifSeq refuses a write that lost
  // the race after the re-read. Returns { record } or { conflict: the record as it is now (null: gone) }.
  // 审查 p1m4：写入前重读；记录变了即冲突、绝不覆盖；支持 ifSeq 的存储拒绝重读之后输掉竞争的写入。
  async function put(k, r, from) {
    const cur = await load(k)
    if (seqOf(cur) !== from || (cur?.stopped && !r.stopped)) return { conflict: cur }
    const next = spendRecord({ ...r, seq: from === null ? 0 : from + 1 })
    if ((await st.set(k, JSON.stringify(next), { ifSeq: from })) === false) return { conflict: await load(k) }
    return { record: next }
  }
  const TRIES = 8
  const conflicted = (agentKey) => spendRefuse('spend-state-conflict', `the spend record of agent key ${agentKey} kept changing under this limiter (another writer on the same store): nothing written`)
  // read, decide, write; on a conflict decide again on the fresh record. decide(cur) returns { record, write, after? }
  // and may throw (a refusal); after(record) runs once the record is written / 读、判、写；冲突即按新记录重判
  async function update(k, agentKey, decide) {
    for (let i = 0; i < TRIES; i++) {
      const cur = await load(k)
      const was = cur?.stopped ?? null           // decide may change cur in place / decide 可能就地修改 cur
      const d = await decide(cur)
      if (!d.write) return d.after ? d.after(d.record) : d.record
      // a stop goes to its own key first: it holds even if the record's write below never lands / 停工先写自己的键
      if (d.record.stopped && !was) await markStop(k, d.record.stopped)
      const w = await put(k, d.record, seqOf(cur))
      if (w.record) return d.after ? d.after(w.record) : w.record
    }
    return conflicted(agentKey)
  }
  const lost = (agentKey) => spendRefuse('spend-state-lost', `no spend record for agent key ${agentKey}: it was never accepted here, or the record was lost; a key without its record never signs (a lost record is not a fresh start)`)
  const stoppedRefusal = (r) => spendRefuse('spend-stopped', `the order was stopped (${r.stopped.reasons.join(', ')}): this key signs nothing more`, { stopped: r.stopped })
  // a stop is written on the record as it is now, and never replaces an earlier stop / 停工写在当前记录上，绝不覆盖先前的停工
  const stopWith = (k, agentKey, reasons) => update(k, agentKey, (cur) => {
    if (!cur) lost(agentKey)
    if (cur.state !== 'started') bad('only a started record can be stopped')
    if (cur.stopped) return { record: cur, write: false }
    cur.stopped = { reasons: [...reasons], at: clock() }
    return { record: cur, write: true }
  })
  // item 7 of review p1m4: what the last recheck read available on each pinned channel (memory only) / 最近一次复核读到的可用额
  const avail = new Map()
  // recheck's body, for a caller already in the record's queue (recheck, resume) / 复核的主体，供已在该记录队列里的调用方使用
  const recheckOn = (k, agentKey, check) => update(k, agentKey, (cur) => {
    if (!cur) lost(agentKey)
    const out = spendRecheck(cur, check)
    let changed = false
    cur.providers.forEach((p, i) => { if (out.hi[i] !== p.hi) { p.hi = out.hi[i]; changed = true } })
    if (out.stop.length && !cur.stopped) { cur.stopped = { reasons: out.stop, at: clock() }; changed = true }
    return {
      record: cur, write: changed,
      after: (rec) => {
        // item 7: remember what the pinned channel has available, from a reading on it only / 只记钉住通道上的读数
        for (const p of rec.providers) {
          const item = (check.scope ?? []).find((x) => eqAddr(x.provider, p.provider))
          const mine = item?.available != null && item?.escrow != null && eqAddr(item.escrow, p.escrow) && check.consumer != null && eqAddr(check.consumer, rec.consumer)
          if (mine) avail.set(`${k}|${p.provider.toLowerCase()}`, uintOf(item.available, 'available'))
          else avail.delete(`${k}|${p.provider.toLowerCase()}`)
        }
        return { ...out, stopped: rec.stopped }
      },
    }
  })
  const self = {
    async accept({ chainId, agentKey } = {}) {
      const k = keyOf(chainId, agentKey)
      return serial(k, () => update(k, agentKey, (cur) => {
        if (cur) spendRefuse('spend-key-known', `agent key ${agentKey} already has a spend record: a key is announced once`)
        return { record: spendRecord({ v: SPEND_RECORD_VERSION, chainId, agentKey, state: 'accepted' }), write: true }
      }))
    },
    async start({ chainId, check } = {}) {
      const pinned = spendPin(check, { chainId })
      const k = keyOf(chainId, pinned.agentKey)
      return serial(k, () => update(k, pinned.agentKey, (cur) => {
        if (!cur) lost(pinned.agentKey)
        if (cur.state === 'accepted') return { record: pinned, write: true }
        if (cur.mandateHash !== pinned.mandateHash) spendRefuse('spend-key-reused', `agent key ${pinned.agentKey} started on mandate ${cur.mandateHash}; one key serves one mandate`)
        // review p1m4: the same mandate again (a restart, a retry) never revives a stopped order, and a check of another
        // escrow or consumer than the start pinned stops it, as recheck does: the start is never moved
        // 审查 p1m4：同一授权书再次开工不会复活已停工的单；读到的托管或 consumer 与钉住的不同即停工（与复核相同）
        if (cur.stopped) stoppedRefusal(cur)
        const out = spendRecheck(cur, check)
        if (out.stop.length) {
          cur.stopped = { reasons: out.stop, at: clock() }
          return { record: cur, write: true, after: () => spendRefuse(out.stop[0], `the check that would restart the work does not match the start (${out.stop.join(', ')}): stopped; the start is never moved to another channel`, { stopped: cur.stopped }) }
        }
        // its start is kept, never re-based; hi is raised to the claimedOf read now on the pinned channel (whatever was
        // settled counts) / 保留开工基线；hi 至少抬到现在在钉住的通道上读到的 claimedOf
        let changed = false
        cur.providers.forEach((p, i) => { if (out.hi[i] !== p.hi) { p.hi = out.hi[i]; changed = true } })
        return { record: cur, write: changed }
      }))
    },
    async recheck({ chainId, check } = {}) {
      const agentKey = check?.mandate?.agentKey ?? check?.agentKey
      const k = keyOf(chainId, agentKey)
      return serial(k, () => recheckOn(k, agentKey, check))
    },
    async record({ chainId, agentKey } = {}) { return load(keyOf(chainId, agentKey)) },
    async stop({ chainId, agentKey, reason = 'spend-stopped' } = {}) {
      const k = keyOf(chainId, agentKey)
      return serial(k, () => stopWith(k, agentKey, [reason]))
    },
    // ---- phase 1, restart: the agent key kept sealed, so that an order resumes after a restart / 阶段 1 的重启 ----
    async keepKey({ chainId, agentKey, secret } = {}) {
      if (!vault) bad('keepKey needs a limiter made with a key vault (createSpendLimiter({ store, vault }))')
      const k = keyOf(chainId, agentKey)
      if (typeof secret !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(secret)) bad('secret must be the agent key\'s 32-byte private key as 0x hex')
      if (!eqAddr(privateKeyToAddress(secret), agentKey)) bad(`the secret is not the key of ${agentKey}`)
      return serial(k, async () => {
        const r = await load(k)
        if (!r) lost(agentKey)
        if (r.stopped) stoppedRefusal(r)
        const blob = await vault.seal(hexToBytes(secret), { context: spendKeyContext(chainId, agentKey) })
        if (typeof blob !== 'string' || blob.length === 0) bad('the key vault must seal to a non-empty string')
        await st.set(keyBlobKey(k), blob)
        return true
      })
    },
    async forgetKey({ chainId, agentKey } = {}) {
      const k = keyOf(chainId, agentKey)
      return serial(k, () => dropBlob(k))
    },
    async resume({ chainId, agentKey, check } = {}) {
      if (!vault) bad('resume needs a limiter made with a key vault (createSpendLimiter({ store, vault }))')
      const k = keyOf(chainId, agentKey)
      return serial(k, async () => {
        const rec = await load(k)
        const mandateHash = check === undefined || check === null ? null : (check.mandateHash ?? null)
        // review p1-restart: the record first. No record, or a stopped one, refuses before the sealed key is touched (the
        // vault is never asked to open it: no KDF run, no secret in memory); a stopped one's blob is destroyed
        // 审查 p1-restart：先看记录。无记录或已停工即拒绝，不碰密文（不让保险箱打开它、不跑 KDF、内存里不出现密钥）；已停工的密文销毁
        if (rec === null || rec.stopped) {
          const d = spendResume(rec, { chainId, agentKey, key: 'missing', mandateHash })
          if (d.refused === 'spend-stopped') await dropBlob(k)
          spendRefuse(d.refused, d.message, d.refused === 'spend-stopped' ? { stopped: rec.stopped } : undefined)
        }
        // the sealed key, opened: its address, or why not / 打开封存的钥匙：得到地址，或打不开的原因
        let key = 'missing', secret = null
        const blob = await st.get(keyBlobKey(k))
        if (blob != null && blob !== '') {
          try {
            const bytes = await vault.open(blob, { context: spendKeyContext(chainId, agentKey) })
            if (!(bytes instanceof Uint8Array) || bytes.length !== 32) throw new Error('not 32 bytes')
            secret = '0x' + bytesToHex(bytes)
            key = privateKeyToAddress(secret)
          } catch { key = 'unreadable'; secret = null }
        }
        const d = spendResume(rec, { chainId, agentKey, key, mandateHash })
        if (!d.ok) {
          if (d.refused === 'spend-stopped') await dropBlob(k)
          spendRefuse(d.refused, d.message, d.refused === 'spend-stopped' ? { stopped: rec.stopped } : undefined)
        }
        if (rec.state === 'accepted') return { record: rec, secret, recheck: null }
        // started: the fresh check against the record, as every step does: a stop is written (and destroys the sealed key),
        // hi is raised, base never moves; any other problem only refuses the steps until it is gone
        // 已开工：用新的核验与记录比对（与每一步相同）：停工写入（并销毁密文）、hi 抬高、base 不动；其它问题只拒绝之后的步骤
        const out = await recheckOn(k, agentKey, check)
        if (out.stopped) { secret = null; spendRefuse(out.stop[0] ?? 'spend-stopped', `the check made to resume the order stops it (${out.stopped.reasons.join(', ')}): not resumed; its sealed key is destroyed`, { stopped: out.stopped }) }
        return { record: await load(k), secret, recheck: out }
      })
    },
    payer({ chainId, payer: inner, maxPrice, signed } = {}) {
      if (!inner || typeof inner.reserve !== 'function' || typeof inner.cumulativeOf !== 'function') bad('payer must be an api.payer({ consumer, sessionKey }) payer')
      // the per-call ceiling: one amount, or one per provider (the providers' tokens may differ); none: the default
      // 单次调用价格上限：一个数，或按 provider 各给一个（各 provider 的代币可能不同）；不给即默认值
      // review p1-restart: an explicit ceiling is above 0 (0 would refuse every call: say so instead of signing nothing),
      // and the per-provider form is a plain object (an array or a class instance is a mistake, not a table)
      // 审查 p1-restart：显式上限必须大于 0（0 会拒绝每一次调用：直接报错，而不是什么都不签）；按 provider 的形式必须是普通对象
      const ceilings = new Map()
      let ceilingAll
      const positive = (v, name) => { const n = uintOf(v, name); if (n === 0n) bad(`${name} must be above 0: a ceiling of 0 would refuse every call (leave maxPrice out for the default, ${SPEND_DEFAULT_CALL_PRICE_PERCENT}% of each cap)`); return n }
      if (maxPrice !== undefined && maxPrice !== null) {
        if (typeof maxPrice === 'object') {
          const proto = Object.getPrototypeOf(maxPrice)
          if (Array.isArray(maxPrice) || (proto !== Object.prototype && proto !== null)) bad('maxPrice must be one amount, or a plain object { [provider]: amount }')
          for (const [p, v] of Object.entries(maxPrice)) ceilings.set(addrOf(p, 'maxPrice provider').toLowerCase(), positive(v, `maxPrice for ${p}`))
        } else ceilingAll = positive(maxPrice, 'maxPrice')
      }
      const ceilingOf = (provider) => (typeof provider === 'string' ? ceilings.get(provider.toLowerCase()) : undefined) ?? ceilingAll
      const agentKey = addrOf(inner.signer, 'payer.signer')
      const k = keyOf(chainId, agentKey)
      // review p1m4: the providers a voucher of this payer was accepted by (its lease committed); until then every voucher
      // to a provider carries the signed mandate / 审查 p1m4：本付款器已有凭证被接受的 provider；此前每张凭证都附签名授权书
      const introduced = new Set()
      // extra (the payment-voucher draft's { rate, strictV, waitMs }) is passed on to the inner payer / 草稿的 extra 原样转给内层 payer
      // review L1: the inner payer may wait for an in-flight voucher of the channel (up to waitMs). That wait happens OUTSIDE
      // this agent's lock (whenFree), and inside it the inner reserve is told not to wait (noWait): if the channel became busy
      // again in between, the lock is left and the wait repeats. So a stop, or a reserve to another provider, never waits
      // behind it, and a voucher of a stopped order never leaves. / 内层 payer 可能要等通道的在途凭证：这个等待在本代理的锁之外
      // （whenFree），锁内让内层不等（noWait）；其间通道又忙了就出锁再等。停工与对其它 provider 的预留都不会被它挡住，已停工的凭证不会放出。
      async function reserve(svc, price, extra) {
        if (typeof inner.whenFree !== 'function') return reserveLocked(svc, price, extra, false)
        const deadline = Date.now() + Number(extra?.waitMs ?? 60_000)
        for (;;) {
          await inner.whenFree(svc, extra, Math.max(0, deadline - Date.now()))
          try { return await reserveLocked(svc, price, extra, true) } catch (e) {
            if (!(e?.code === 'PAYMENT_BUSY' && e.data?.noWait === true && Date.now() < deadline)) throw e
          }
        }
      }
      function reserveLocked(svc, price, extra, noWait) {
        return serial(k, async () => {
          let r = await load(k)
          if (!r) lost(agentKey)
          const amount = uintOf(price, 'price')
          const req = { chainId, provider: svc?.container, escrow: svc?.manifest?.payment?.escrow, consumer: inner.consumer, price: amount, now: clock(), maxPrice: ceilingOf(svc?.container) }
          const refuse = async (d) => { if (d.stop && r.state === 'started') await stopWith(k, agentKey, [d.refused]); spendRefuse(d.refused, d.message) }
          // before signing: every rule, the cap against the least cumulative the payer can sign (committed + price)
          // 签名之前：全部规则；cap 按 payer 能签的最小累计额（已确认 + 价格）比
          let floor = amount
          try { floor = BigInt(inner.cumulativeOf(svc)) + amount } catch { /* an unknown service is refused below */ }
          let d = spendDecision(r, { ...req, cumulative: floor })
          if (!d.ok) await refuse(d)
          const left = avail.get(`${k}|${String(svc.container).toLowerCase()}`)
          if (left !== undefined && left < amount) spendRefuse('spend-channel-short', `the last check read ${left} available on (${r.consumer}, ${svc.container}), below the price ${amount}: the provider would refuse the voucher; nothing signed (not stopped)`)
          const lease = noWait ? await inner.reserve(svc, amount, { ...(extra ?? {}), noWait: true }) : extra === undefined ? await inner.reserve(svc, amount) : await inner.reserve(svc, amount, extra)
          try {
            d = spendDecision(r, { ...req, cumulative: lease.next })
            if (!d.ok) await refuse(d)
            // the voucher must be the one counted: this key, consumer and provider, the pinned escrow and chain
            // 凭证必须就是被计入的那一张：本钥匙、consumer、provider，钉住的托管与链
            const pin = r.providers.find((x) => eqAddr(x.provider, svc.container))
            const v = lease.voucher
            let who = null
            try { who = recoverAddress(voucherDigest(chainId, pin.escrow, { consumer: v.consumer, provider: v.provider, cumulative: BigInt(v.cumulative), expires: v.expires }), v.sig) } catch { who = null }
            if (!who || !eqAddr(who, agentKey) || !eqAddr(v.consumer, r.consumer) || !eqAddr(v.provider, pin.provider) || BigInt(v.cumulative) !== BigInt(lease.next)) {
              await stopWith(k, agentKey, ['spend-voucher-mismatch'])
              spendRefuse('spend-voucher-mismatch', `the payer signed a voucher that is not the one counted (signer ${who}, consumer ${v.consumer}, provider ${v.provider}, cumulative ${v.cumulative}, on escrow ${pin.escrow}): stopped`)
            }
            // write ahead: the highest cumulative is on record before the voucher leaves; a record that moved on under
            // this voucher (another writer) is decided again, and a stop found there refuses (review p1m4)
            // 先记账：凭证离开之前最高累计额已入记录；记录被别的写者改过即按新记录重判，已停工即拒绝（审查 p1m4）
            for (let i = 0; ; i++) {
              r.providers.find((x) => eqAddr(x.provider, svc.container)).hi = d.hi
              const w = await put(k, r, r.seq)
              if (w.record) { r = w.record; break }
              if (i + 1 >= TRIES) conflicted(agentKey)
              r = w.conflict
              if (!r) lost(agentKey)
              if (r.stopped) stoppedRefusal(r)
              d = spendDecision(r, { ...req, now: clock(), cumulative: lease.next })
              if (!d.ok) await refuse(d)
            }
            // a stop that landed while the record was written (a store without ifSeq can lose it there) is on its own
            // key: the voucher does not leave / 写记录期间落下的停工在自己的键上：凭证不离开
            const late = await stopMark(k)
            if (late) stoppedRefusal({ stopped: late })
            const p = String(svc.container).toLowerCase()
            const voucher = { ...v, mandateHash: r.mandateHash, ...(!introduced.has(p) && signed ? { mandate: signed } : {}) }
            const commit = async () => { await lease.commit(); introduced.add(p) }
            return { ...lease, commit, voucher, spent: d.spent, remaining: d.remaining }
          } catch (e) { lease.release(); throw e }
        })
      }
      const wrapped = {
        consumer: inner.consumer, signer: inner.signer, mandateLimited: true,
        cumulativeOf: (svc) => inner.cumulativeOf(svc),
        inflightOf: (svc) => inner.inflightOf?.(svc),
        // the payment-voucher draft's halt lives on the inner payer's account / 草稿的停止状态在内层 payer 的账户上
        halt: (svc, why) => inner.halt?.(svc, why),
        whenFree: (svc, extra, waitMs) => (typeof inner.whenFree === 'function' ? inner.whenFree(svc, extra, waitMs) : Promise.resolve()),
        haltOf: (svc) => inner.haltOf?.(svc) ?? null,
        clearHalt: (svc) => inner.clearHalt?.(svc),
        // the counter may be set or resynced: what is signed next is checked against the ceiling all the same
        // 计数器可以设置或重新同步：之后签出的照样按上限检查
        setCumulative: (svc, v) => inner.setCumulative(svc, v),
        resync: (svc, last, evidence, extra) => (extra === undefined ? inner.resync(svc, last, evidence) : inner.resync(svc, last, evidence, extra)),
        reserve,
        async voucherFor(svc, price) { const lease = await reserve(svc, price); await lease.commit(); return lease.voucher },
      }
      return wrapped
    },
  }
  return self
}

// ---- phase 1, M7 (experimental): the spend statement a delivery may carry, and its reconciliation (draft §2.3 rule 5,
// §6.1 S8, R16) ----
// What the principal's channels paid since the work started is a chain fact: claimedOf(t) − claimedOf(t₀) per capped
// provider, t₀ the check that started the work (the limiter's base) and t the agent's last check before it signs the
// delivery. The agent states both readings in its signed deliver result (member `spend`, covered by the envelope's
// signature, not by receiptsHash); a verifier compares them with its own reading at its pinned block and with the
// receipts × the providers' prices. claimedOf moves only when a provider settles, and a provider may settle up to 48 hours
// later, so at delivery an honest agent's amount is at most what the key authorised (a lower bound of it, on a channel
// only this mandate uses). The statement is the agent's own word: a dishonest one can state less, and only the
// verifier's own reading of claimedOf is evidence; what the key can make the channel pay is bounded by the channel's
// balance alone (G1). A hash-only receipt signs only its
// requestHash (its method, which names the price, is informative), the price is the manifest's at the verifier's block
// (in BEM units: pricing in another token is not specified), so every mismatch is a warning, never a problem. Only a
// statement that is malformed, names a provider without a cap, or does not add up is a problem.
// 阶段 1 的 M7：交付可带的花费说明与对账。每个带金额 provider：claimedOf(t) − claimedOf(t₀)，t₀ 是开工核验（限额器的 base），
// t 是代理签交付前的最后一次核验。代理在签名的交付结果里写下两个读数（成员 spend，由信封签名覆盖，不在 receiptsHash 里）；核验方
// 与自己在钉块上的读数、以及回执 × 单价比对。claimedOf 只在 provider 结算时变，结算可晚 48 小时，所以诚实代理在交付时写的金额不超过钥匙
// 已授权的金额（通道只供本授权书用时是它的下界）；说明只是代理之言，不诚实的代理可以少写，只有核验方自己读到的 claimedOf 才是证据，
// 钥匙能让通道付出多少只受通道余额约束（G1）；
// 只含哈希的回执只签 requestHash（决定单价的 method 不签），单价取核验时的清单（BEM 单位），所以不符一律是警告；只有格式错、
// 写了不带金额的 provider、算不平才是问题。
export const SPEND_EVIDENCE_PROBLEMS = Object.freeze(['spend-evidence-malformed', 'spend-provider-out-of-scope', 'spend-evidence-inconsistent'])
// the codes spendEvidence reports; the kit adds spend-evidence-absent (verifyEvidence, verifyTaskThread: a phase-1
// delivery with no `spend` member at all), which this pure function never sees / spendEvidence 报的码；kit 另报 spend-evidence-absent
export const SPEND_EVIDENCE_WARNINGS = Object.freeze(['spend-escrow-changed', 'spend-above-chain', 'spend-above-cap', 'spend-exceeds-receipts', 'spend-below-receipts', 'spend-evidence-incomplete'])
const U256_STR = /^(0|[1-9][0-9]*)$/
const u256Str = (v) => typeof v === 'string' && U256_STR.test(v) && BigInt(v) < 1n << 256n
/**
 * @experimental (phase 1, M7) The statement an agent puts in its deliver result as `spend` (draft §6.1 S8): per provider of
 * the started `record`, in its order, { provider, escrow, claimedAtStart (the record's base: claimedOf at the check that
 * started the work), claimedAtDelivery, spent (claimedAtDelivery − claimedAtStart) }, from `check`, the agent's last
 * verifyMandate result before it signs the delivery. A provider is left out unless the check names the record's consumer
 * and reads the provider's channel on the pinned escrow with a claimedAtCheck at least the base (claimedOf never falls:
 * a lower reading is not used, and no amount is ever made up). Amounts are decimal strings. Pure.
 * 代理放进交付结果 spend 成员的说明：按记录的 provider 顺序，取签交付前最后一次核验的读数；consumer 不同、托管不是钉住的、读数缺失或低于
 * base 的 provider 不写（绝不编造金额）。纯函数。
 */
export function spendStatement(record, check) {
  const r = spendRecord(record)
  if (r.state !== 'started') bad('spendStatement needs a started record')
  if (!check || typeof check !== 'object') bad('check must be a verifyMandate result')
  if (check.consumer == null || !isAddress(check.consumer) || !eqAddr(check.consumer, r.consumer)) return []
  const out = []
  for (const p of r.providers) {
    const item = (Array.isArray(check.scope) ? check.scope : []).find((x) => x && isAddress(x.provider) && eqAddr(x.provider, p.provider))
    if (!item || !isAddress(item.escrow) || !eqAddr(item.escrow, p.escrow) || !u256Str(item.claimedAtCheck)) continue
    const at = BigInt(item.claimedAtCheck), base = BigInt(p.base)
    if (at < base) continue
    out.push({ provider: p.provider, escrow: p.escrow, claimedAtStart: p.base, claimedAtDelivery: at.toString(), spent: (at - base).toString() })
  }
  return out
}
/**
 * @experimental (phase 1, M7) A delivery's spend statement reconciled (draft §6.1 S8, R16). Inputs:
 *   spend      the deliver result's `spend` member
 *   mandate    the thread's mandate (its capped scope items)
 *   calls      the delivery's receipts that verified, as [{ provider, method, ok }]; only ok ones count
 *   readings   the verifier's own channel readings at its pinned block, [{ provider, escrow, claimedAtCheck }] (the
 *              phase-1 check's `scope`), or null: no comparison with the chain
 *   prices     { [provider, lower case]: { [method]: price } } (decimal strings, the manifest's priceBEM in base units),
 *              or null: no reconciliation with the receipts
 * Problems, in this order: spend-evidence-malformed (not an array, or more entries than capped providers: nothing else is
 * checked; an entry that is not an object with a provider and a non-zero escrow address and the three amounts as decimal
 * strings, or a provider named twice); spend-provider-out-of-scope (not a capped scope item); spend-evidence-inconsistent
 * (claimedAtDelivery below claimedAtStart, or spent not their difference). Warnings, per entry left: spend-escrow-changed
 * (the verifier reads the provider on another escrow: no comparison), spend-above-chain (the verifier's claimedOf on the
 * same escrow is below claimedAtDelivery: the statement is not on chain at the verifier's block), spend-above-cap (the
 * amount measured, spentNow when it is known, else spent, above the cap: someone else settled on the channel too), then
 * spend-exceeds-receipts or spend-below-receipts (the amount
 * compared, spentNow = the verifier's claimedOf − claimedAtStart when it reads the same escrow at or above the start, else
 * spent, against expected = the sum of the prices of the provider's ok calls, when every such call's method has a price);
 * last, spend-evidence-incomplete for each capped provider no entry names. Items: { provider, escrow, claimedAtStart,
 * claimedAtDelivery, spent, claimedNow, spentNow, calls, expected, reconciled: 'equal' | 'above' | 'below' | null }.
 * ok when there is no problem. Pure.
 * 交付花费说明的对账。问题：格式错、写了不带金额的 provider、算不平；其余不符一律是警告（换了托管、链上读数低于说明、超过 cap、
 * 多于或少于回执 × 单价、漏写带金额的 provider）。纯函数。
 */
export function spendEvidence(spend, { mandate, calls = [], readings = null, prices = null } = {}) {
  const m = normalizeMandate(mandate)
  const capped = m.scope.filter((s) => s.cap !== '0')
  const problems = [], warnings = [], items = []
  const out = { ok: false, problems, warnings, items }
  if (!Array.isArray(spend) || spend.length > capped.length) {
    problems.push({ code: 'spend-evidence-malformed', message: `spend must be an array of at most ${capped.length} entries, one per capped provider` })
    return out
  }
  const named = new Set()
  const seen = new Set()
  for (const [i, e] of spend.entries()) {
    const at = `spend[${i}]`
    const pv = e && typeof e === 'object' && isAddress(e.provider) ? e.provider.toLowerCase() : null
    if (pv) named.add(pv)
    if (!pv || !isAddress(e.escrow) || eqAddr(e.escrow, ZERO_ADDRESS) || !u256Str(e.claimedAtStart) || !u256Str(e.claimedAtDelivery) || !u256Str(e.spent)) {
      problems.push({ code: 'spend-evidence-malformed', message: `${at}: { provider, escrow, claimedAtStart, claimedAtDelivery, spent }, addresses and decimal strings` })
      continue
    }
    if (seen.has(pv)) { problems.push({ code: 'spend-evidence-malformed', provider: checksumAddress(e.provider), message: `${at}: ${checksumAddress(e.provider)} is named twice` }); continue }
    seen.add(pv)
    const s = capped.find((x) => eqAddr(x.provider, pv))
    if (!s) { problems.push({ code: 'spend-provider-out-of-scope', provider: checksumAddress(e.provider), message: `${at}: ${checksumAddress(e.provider)} is not a provider with a cap in the mandate's scope` }); continue }
    const start = BigInt(e.claimedAtStart), atDel = BigInt(e.claimedAtDelivery), spent = BigInt(e.spent)
    if (atDel < start || spent !== atDel - start) { problems.push({ code: 'spend-evidence-inconsistent', provider: s.provider, message: `${at}: spent ${spent} is not claimedAtDelivery ${atDel} − claimedAtStart ${start}` }); continue }
    const item = { provider: s.provider, escrow: checksumAddress(e.escrow), claimedAtStart: e.claimedAtStart, claimedAtDelivery: e.claimedAtDelivery, spent: e.spent, claimedNow: null, spentNow: null, calls: 0, expected: null, reconciled: null }
    items.push(item)
    const warn = (code, message) => warnings.push({ code, provider: s.provider, message })
    const rd = Array.isArray(readings) ? readings.find((x) => x && isAddress(x.provider) && eqAddr(x.provider, s.provider)) : null
    if (rd && isAddress(rd.escrow) && u256Str(rd.claimedAtCheck)) {
      if (!eqAddr(rd.escrow, e.escrow)) warn('spend-escrow-changed', `${s.provider} is read on escrow ${checksumAddress(rd.escrow)}; the statement is for ${item.escrow}: not compared with the chain`)
      else {
        const now = BigInt(rd.claimedAtCheck)
        item.claimedNow = now.toString()
        if (now >= start) item.spentNow = (now - start).toString()
        if (now < atDel) warn('spend-above-chain', `the statement says claimedOf ${atDel} at delivery; the chain reads ${now} at the verifier's block`)
      }
    }
    // review m7 F2: the verifier's own reading wins over the statement's word (spentNow when it reads the same escrow at or
    // above the start, else spent): a statement that says 50 under a cap of 50 does not hide a chain that reads 60
    // 审查 m7 F2：核验方自己的读数优先于说明的话（读到同一托管且不低于开工值时用 spentNow，否则用 spent）
    const paid = item.spentNow !== null ? BigInt(item.spentNow) : spent
    if (paid > BigInt(s.cap)) warn('spend-above-cap', `the channel paid ${paid} since the start, above the cap ${s.cap}: something else settled on it too`)
    const mine = (Array.isArray(calls) ? calls : []).filter((c) => c && c.ok === true && isAddress(c.provider) && eqAddr(c.provider, s.provider))
    item.calls = mine.length
    const table = prices && typeof prices === 'object' ? prices[s.provider.toLowerCase()] : undefined
    if (table && typeof table === 'object' && mine.every((c) => typeof c.method === 'string' && Object.hasOwn(table, c.method) && u256Str(table[c.method]))) {
      const expected = mine.reduce((a, c) => a + BigInt(table[c.method]), 0n)
      item.expected = expected.toString()
      const measured = item.spentNow !== null ? BigInt(item.spentNow) : spent
      item.reconciled = measured === expected ? 'equal' : measured > expected ? 'above' : 'below'
      if (item.reconciled === 'above') warn('spend-exceeds-receipts', `the channel paid ${measured} since the start, more than the ${mine.length} receipted call(s) at their prices (${expected}): calls left out of the evidence, or someone else settled on the channel`)
      if (item.reconciled === 'below') warn('spend-below-receipts', `the channel paid ${measured} since the start, less than the ${mine.length} receipted call(s) at their prices (${expected}): a provider that has not settled yet (it may, for 48 hours), or calls paid from another channel (R16)`)
    }
  }
  for (const s of capped) if (!named.has(s.provider.toLowerCase())) warnings.push({ code: 'spend-evidence-incomplete', provider: s.provider, message: `the statement names no entry for ${s.provider}` })
  out.ok = problems.length === 0
  return out
}
