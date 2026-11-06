// @experimental A gatekeeper in this process (Policy Circuit Gate TAP draft §4.2, §4.4, §7): a service that re-runs the
// policy circuit its counterparty's principal bound, before it serves or settles, and keeps the trace. It fails closed
// in every row of §7: any read it cannot make, any problem of the binding, any request it cannot encode, any result other
// than exactly 0x01 is a denial. It constrains only this gatekeeper: the agent's wallet may ignore the policy, and a
// limit over a period counts only the requests this gatekeeper saw (§0.2). Nothing here sends a transaction.
// 实验性：本进程内的守门方（草稿 §4.2、§4.4、§7）：服务方在服务或结算之前重跑对方委托人绑定的策略电路，并保留轨迹。§7 的每一行都失败即拒绝：
// 读不到、绑定有问题、请求无法编码、结果不是恰好 0x01，一律拒绝。它只约束这个守门方：代理的钱包可以不理会它，按周期的上限只计本守门方
// 见到的请求。这里不发送任何交易。
//
// The trace store is append-only JSON lines (policyTraceFileStore: a file, mode 600, with a lock file; or
// memoryPolicyTraceStore), one line per beat:
//   { "tapeapiPolicyTrace": 1, "bindingHash", "type": "start", "ts", "reason" }      a trace (re)starts at ts, state zero
//   { "tapeapiPolicyTrace": 1, "bindingHash", "type": "entry", "request", "cumulative"?, "verdict" }
// The state is never stored: it is rebuilt by replaying the entries since the last start (§4.2 item 3), so a trace that
// does not replay (a broken line, a recorded verdict the circuit does not give) is `trace-unavailable`, never a fresh
// start. A stateful policy whose store holds no trace for the binding is refused until the caller starts one
// (startTrace), which is written down: a gatekeeper that restarts from zero widens the limit, so it must say so (§7).
// 轨迹存储是只追加的 JSON 行，每拍一行。状态从不单独保存：按最后一次 start 之后的条目重放得出，所以重放不了的轨迹（坏行、记录的结论
// 与电路不符）即 trace-unavailable，绝不悄悄从零开始。有状态策略在存储里没有该绑定的轨迹时一律拒绝，直到调用方显式 startTrace
// （写入记录）：守门方从零重来等于放宽限额，必须留下记录。
import { TapeAPIError } from '@tapeapi/sdk'
import { encodeParams, bytesToHex, selector, toHex, isAddress } from '@tapeapi/sdk/abi'
import { chainById } from '@tapeapi/sdk/chains'
import { PolicyCircuitError, loadPolicyCircuit } from './tapnet.js'
import { isObj, fromHex, checkPolicyRequest, evaluatePolicyRequest, replayPolicyTrace, checkPolicyTables } from './policy-word.js'
import { verifyPolicyBinding, choosePolicyBinding, policySubject } from './policy-binding.js'

export const POLICY_TRACE_VERSION = 1
const invalid = (msg) => { throw new TapeAPIError('INVALID_ARGUMENT', msg) }
const STRICT = Object.freeze({ answers: 'tap10', strict: true })
const isRevert = (e) => e instanceof TapeAPIError && e.code === 'RPC_ERROR' && (Number(e.data?.rpcCode) === 3 || e.data?.rpcRevert === true)
const MAGIC_1271 = '0x1626ba7e' + '0'.repeat(56)
const SITE_WITH_HOLDER = new Set(['ok', 'unpaid', 'not-opened'])

// ---- stores / 存储 ----
/** A trace store in memory (one process; lost on restart). / 内存轨迹存储（单进程，重启即丢）。 */
export function memoryPolicyTraceStore() {
  let text = ''
  return { read: () => text, append(s) { text += s } }
}
/**
 * A trace store in a file (append-only JSON lines, mode 600). `fs` is node:fs (readFileSync, appendFileSync, and for the
 * lock writeFileSync, unlinkSync); without the last two there is no lock. Several gates on one file read each other's
 * lines under the lock before every decision. / 文件轨迹存储（只追加，权限 600）；有锁时多个守门方每次判定前在锁内读取彼此的行。
 */
export function policyTraceFileStore(path, fs, { staleMs = 30_000, waitMs = 10_000 } = {}) {
  if (typeof path !== 'string' || !path) invalid('policyTraceFileStore needs a file path')
  if (typeof fs?.readFileSync !== 'function' || typeof fs?.appendFileSync !== 'function') invalid('policyTraceFileStore needs fs: { readFileSync, appendFileSync, writeFileSync?, unlinkSync?, chmodSync? } from node:fs')
  return {
    path,
    read() {
      let text
      try { text = fs.readFileSync(path, 'utf8') } catch (e) { if (e?.code === 'ENOENT') return ''; throw e }
      if (typeof fs.chmodSync === 'function') { try { fs.chmodSync(path, 0o600) } catch { /* the read stands */ } }
      return text
    },
    append(s) { fs.appendFileSync(path, s, { mode: 0o600 }) },
    ...(typeof fs.writeFileSync === 'function' && typeof fs.unlinkSync === 'function' ? { lock: () => fileLock(`${path}.lock`, fs, { staleMs, waitMs }) } : {}),
  }
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
async function fileLock(file, fs, { staleMs, waitMs }) {
  const start = Date.now()
  const me = JSON.stringify({ pid: typeof process !== 'undefined' ? process.pid : null, ms: start, n: Math.random() })
  for (let i = 0; ; i++) {
    try { fs.writeFileSync(file, me, { flag: 'wx', mode: 0o600 }); break } catch (e) {
      if (e?.code !== 'EEXIST') throw e
      let held = null
      try { held = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { held = null }
      if (held && Number.isFinite(held.ms) && Date.now() - held.ms > staleMs) { try { fs.unlinkSync(file) } catch { /* someone else did */ } continue }
      if (Date.now() - start > waitMs) throw new Error(`the trace store is locked by another gate (${file}); remove it if no process holds it`)
      await pause(Math.min(2 + i, 25))
    }
  }
  return () => { try { if (fs.readFileSync(file, 'utf8') === me) fs.unlinkSync(file) } catch { /* gone already */ } }
}

// ---- the binder reader / 绑定者读取 ----
/**
 * A binder reader for verifyPolicyBinding and createPolicyGate, on an SDK client (createTapeAPI) and, for EIP-1271 and
 * kind 2, its quorum RPC client (`rpc`, @tapeapi/sdk/rpc). The holder is read with api.siteStatus at one TAP-10 pinned
 * block; EIP-1271 asks `isValidSignature` at that same block (another TAP-10 pinned block when none is known), with
 * strict agreement. Kind 1: the holder of the mandate's principal (pass the mandate); kind 2: the consumer, or its holder
 * when the consumer is a contract (pass the session); kind 3: the holder of the circuit whose container is the account;
 * kind 4: none. Any failed read throws, which the checks report as `binderChecked: false`.
 * 绑定者读取函数：持有人经 api.siteStatus 在一个 TAP-10 钉块上读取；EIP-1271 在同一个块上以严格共识询问 isValidSignature。读取失败即抛出，
 * 检查结果报 binderChecked: false。
 */
export function policyBinderFromApi(api, { rpc = null, chainId = 56 } = {}) {
  if (typeof api?.siteStatus !== 'function') invalid('policyBinderFromApi needs an SDK client (createTapeAPI) with siteStatus')
  const maxLag = chainById(chainId)?.tap10MaxPinLag
  const holderOf = async (container) => {
    const st = await api.siteStatus({ chainId, container })
    if (!st || !SITE_WITH_HOLDER.has(st.status) || !isAddress(st.holder)) throw new TapeAPIError('NOT_FOUND', `${container}: TAP-10 site status ${st?.status ?? 'unknown'}, no holder`, { data: { status: st?.status ?? null } })
    return { binder: st.holder.toLowerCase(), pinned: st.pinned ? { number: st.pinned.number, hash: st.pinned.hash } : null }
  }
  const needRpc = () => { if (!rpc) throw new TapeAPIError('INVALID_ARGUMENT', 'this read needs `rpc` (createRpc from @tapeapi/sdk/rpc)'); return rpc }
  const blockOf = async (pinned) => {
    if (pinned?.hash) return { blockHash: pinned.hash, requireCanonical: true }
    if (!maxLag) throw new TapeAPIError('INVALID_ARGUMENT', `chain ${chainId} is not a TapeOut chain this SDK supports`)
    const b = await needRpc().tap10Block({ maxLag })
    return { blockHash: b.hash, requireCanonical: true }
  }
  return {
    async resolve(kind, subject, { mandate = null, session = null, chainId: asked } = {}) {
      // A binding checked in another chain's domain names a binder of that chain: never read it here (FIXED R30-C4).
      // 在别的链的域里核对的绑定，其绑定者属于那条链：绝不在这里读。
      if (asked !== undefined && asked !== null && Number(asked) !== chainId) throw new TapeAPIError('INVALID_ARGUMENT', `this binder reader reads chain ${chainId}, the binding is checked on chain ${asked}`)
      if (kind === 3) return holderOf('0x' + subject.slice(26))
      if (kind === 1) {
        if (!isObj(mandate) || !isAddress(mandate.principal)) throw new TapeAPIError('INVALID_ARGUMENT', 'a mandate binding\'s binder is read from the mandate: pass `mandate`')
        return holderOf(mandate.principal)
      }
      if (kind === 2) {
        if (!isObj(session) || !isAddress(session.consumer)) throw new TapeAPIError('INVALID_ARGUMENT', 'an escrow-session binding\'s binder is read from the session: pass `session`')
        const block = await blockOf(null)
        const code = String(await needRpc().call('eth_getCode', [session.consumer, block], STRICT))
        if (code === '0x') return { binder: session.consumer.toLowerCase(), pinned: { hash: block.blockHash } }
        return holderOf(session.consumer)
      }
      return null
    },
    async isValidSignature(address, digest, sig, pinned) {
      const r = needRpc()
      const block = await blockOf(pinned)
      if (String(await r.call('eth_getCode', [address, block], STRICT)) === '0x') return false
      const data = selector('isValidSignature(bytes32,bytes)') + bytesToHex(encodeParams(['bytes32', 'bytes'], [toHex(fromHex(digest)), sig]))
      let out
      try { out = String(await r.ethCall(address, data, block, STRICT)).toLowerCase() } catch (e) { if (isRevert(e) || (e instanceof TapeAPIError && e.code === 'ABI_INVALID')) return false; throw e }
      // the whole first word, as OpenZeppelin's SignatureChecker reads it / 核对完整的第一个字
      return out.length >= 66 && out.slice(0, 66) === MAGIC_1271
    },
  }
}

// ---- the gate / 守门方 ----
const deny = (problem, extra = {}) => ({ verdict: 'deny', problem, problems: [problem], ...extra })
const codeOf = (e) => (e instanceof PolicyCircuitError ? e.code : null)

/**
 * Create a gatekeeper for one subject. Options: `chainId`, `binding` + `sig` (or `bindings: [{ binding, sig }]`, chosen as
 * §5.4 says), `tables`, `policyFile` (Uint8Array) or `fetchPolicyFile(netlistHash)`, `binder` (an address or a reader
 * such as policyBinderFromApi), `revocations` (an array, or a function read again before every decision), `store`
 * (memoryPolicyTraceStore by default), `clock` (seconds; the gatekeeper assigns `ts`), and `mandate` / `session` (the
 * subject record, for `binding-outlives-subject` and the binder). A kind-2 binding needs `session`: its subject is only a
 * hash, so without the session the gate cannot tell an x402 channel from a #59 / #60 one (INVALID_ARGUMENT, data.reason
 * 'policy-session-required'). The binder is resolved again before every decision, so a transfer of the circuit ends
 * the earlier holder's bindings at the next decision. Otherwise it never throws for the binding: a gate whose binding
 * does not check out denies every request, and `status()` says why.
 * 为一个主体创建守门方。第 2 类绑定必须给 session（subject 只是哈希，没有它认不出 x402 通道）。每次判定前重新解析绑定者，电路转手后旧绑定
 * 在下一次判定时失效。除此之外，绑定有问题时不抛出：这个守门方拒绝一切请求，status() 写明原因。
 */
export async function createPolicyGate(opts = {}) {
  const { chainId, tables, binder = null, clock = () => Math.floor(Date.now() / 1000), mandate = null, session = null, declaredStateful = null } = opts
  if (!(Number.isSafeInteger(chainId) && chainId > 0)) invalid('createPolicyGate needs chainId')
  if (typeof clock !== 'function') invalid('clock is a function returning Unix seconds')
  const store = opts.store ?? memoryPolicyTraceStore()
  if (typeof store?.read !== 'function' || typeof store?.append !== 'function') invalid('store is { read, append, lock? }')
  const candidates = opts.bindings ?? [{ binding: opts.binding, sig: opts.sig }]
  if (!Array.isArray(candidates) || !candidates.length) invalid('createPolicyGate needs binding and sig, or bindings')
  if (session && isObj(session)) policySubject.escrowSession(session)   // an x402-batch channel is refused here / 拒绝 x402-batch 通道
  // A kind-2 subject is keccak256(escrow ‖ consumer ‖ provider ‖ key): only the session shows which contract it is, so
  // the x402 refusal above runs only with it. The binding is in hand, so this is known now (FIXED R30-C5: such a gate
  // opened as `conditional`). / 第 2 类 subject 只是哈希，只有 session 能看出是哪个合约；没有 session 时上面的 x402 拒绝根本不会执行。
  if (!isObj(session) && candidates.some((c) => isObj(c?.binding) && Number(c.binding.subjectKind) === 2)) {
    throw new TapeAPIError('INVALID_ARGUMENT', 'a kind-2 (escrow-session) binding needs `session` ({ escrow, consumer, provider, key, expires }): its subject is only a hash, so without the session an x402 channel cannot be told from a #59 / #60 one', { data: { reason: 'policy-session-required' } })
  }
  const readRevocations = async () => {
    const r = typeof opts.revocations === 'function' ? await opts.revocations() : opts.revocations ?? []
    if (!Array.isArray(r)) throw new Error('revocations must be an array')
    return r
  }
  const files = new Map()
  const fileFor = async (netlistHash) => {
    if (opts.policyFile instanceof Uint8Array) return opts.policyFile
    if (typeof opts.fetchPolicyFile !== 'function') return null
    if (!files.has(netlistHash)) {
      let f = null
      try { f = await opts.fetchPolicyFile(netlistHash) } catch { f = null }
      files.set(netlistHash, f instanceof Uint8Array ? f : null)
    }
    return files.get(netlistHash)
  }
  // The binder is resolved again for every decision, and EIP-1271 (for the binding and for each revocation) is asked at
  // the block that resolve pinned: nothing about the binder is kept between decisions. After the circuit (or a mandate's
  // principal) changes hands, an earlier binding fails §5.3 item 3 at the next decision; a read that fails denies, never
  // an earlier answer (FIXED R30-C3: the first binder, its pinned block and an EIP-1271 "yes" were kept for life).
  // 每次判定都重新解析绑定者，EIP-1271（绑定与每条撤销）都在这次解析钉住的块上询问：判定之间不保留任何绑定者信息。电路（或授权书的委托人）
  // 转手后，旧绑定在下一次判定时第 3 项失败；读取失败即拒绝，绝不沿用之前的回答。原先第一次的绑定者、钉块和 EIP-1271 的"是"终身保留。
  async function check(c, now) {
    let revs
    try { revs = await readRevocations() } catch { return { status: 'problems', problems: ['revocations-unavailable'], enforceable: false } }
    const file = await fileFor(c.binding?.netlistHash)
    try {
      return await verifyPolicyBinding(chainId, c.binding, c.sig, tables, {
        binder, now, policyFile: file, fileUnavailable: file === null, revocations: revs, mandate, session, declaredStateful,
      })
    } catch (e) {
      if (codeOf(e)) return { status: 'problems', problems: [codeOf(e)], enforceable: false }
      if (e instanceof TapeAPIError) return { status: 'problems', problems: [e.data?.reason ?? 'binding-unusable'], enforceable: false, error: e.message }
      throw e
    }
  }

  // ---- choose the binding at creation / 创建时选定绑定 ----
  let chosen = null, closed = null, result = null, circuit = null
  try { checkPolicyTables(tables) } catch (e) { closed = codeOf(e) ?? 'tables-malformed' }
  if (!closed) {
    const now = clock()
    const checked = []
    for (const c of candidates) checked.push({ binding: c?.binding, sig: c?.sig, result: await check(c ?? {}, now) })
    if (checked.length === 1) { chosen = checked[0]; result = chosen.result }
    else {
      let pick
      try { pick = choosePolicyBinding(checked) } catch (e) { pick = { chosen: null, problem: 'binding-unusable' } }
      if (pick.problem) closed = pick.problem
      else { chosen = pick.chosen; result = chosen.result }
    }
    if (!closed && (result.status !== 'ok' || !(result.enforceable === true || result.enforceable === 'conditional'))) {
      closed = result.problems?.[0] ?? (result.displayOnly ? 'binding-display-only' : result.binderChecked === false ? 'binder-not-checked' : 'policy-file-unavailable')
    }
    if (!closed) {
      try { circuit = loadPolicyCircuit(await fileFor(chosen.binding.netlistHash)) } catch (e) { closed = codeOf(e) ?? 'policy-file-unavailable' }
    }
  }
  const bindingHash = result?.bindingHash ?? null
  const kind = chosen ? Number(chosen.binding.subjectKind) : null
  const escrow = kind === 2
  const window = chosen ? { notBefore: chosen.binding.notBefore, expires: chosen.binding.expires } : null

  // ---- the trace / 轨迹 ----
  let entries = [], started = false, state = null, lastTs = -1n, lastCum = 0n, seenText = null, traceBroken = null
  function load() {
    let text
    try { text = store.read() } catch (e) { traceBroken = `the trace store cannot be read: ${e?.message ?? e}`; return }
    if (typeof text !== 'string') { traceBroken = 'the trace store returned no text'; return }
    if (text === seenText) return
    // Lines before the last start of this binding are history; a line that is not JSON after it breaks the trace (it
    // may be this binding's). / 本绑定最后一次 start 之前的行只是历史；其后出现非 JSON 行即视为轨迹损坏（可能是本绑定的）。
    const mine = []
    let at = -1, badAfter = false
    for (const raw of text.split('\n')) {
      if (!raw.trim()) continue
      let v
      try { v = JSON.parse(raw) } catch { badAfter = true; continue }
      if (!isObj(v) || v.tapeapiPolicyTrace !== POLICY_TRACE_VERSION || v.bindingHash !== bindingHash) continue
      if (v.type === 'start') { at = mine.length; mine.push(v); badAfter = false } else if (v.type === 'entry') mine.push(v)
      else { traceBroken = `a trace line of unknown type ${JSON.stringify(v.type)}`; return }
    }
    if (badAfter && at >= 0) { traceBroken = 'a line of the trace store after the last start is not JSON'; return }
    if (at < 0) { started = false; entries = []; state = circuit.zeroState(); lastTs = -1n; lastCum = 0n; seenText = text; traceBroken = mine.length ? 'trace entries without a start' : null; return }
    const list = mine.slice(at + 1).map((v) => ({ request: v.request, ...(escrow ? { cumulative: v.cumulative } : {}), verdict: v.verdict }))
    try {
      const r = replayPolicyTrace(circuit, tables, list, { ...window, escrowCumulative: escrow })
      state = circuit.stateful ? fromHex(r.finalState) : new Uint8Array(0)
      lastTs = list.length ? BigInt(list[list.length - 1].request.ts) : BigInt(mine[at].ts)
      lastCum = 0n
      if (escrow) list.forEach((e, i) => { if (r.results[i].verdict === 'allow') lastCum = BigInt(e.cumulative) })
      entries = list; started = true; seenText = text; traceBroken = null
    } catch (e) { traceBroken = `the trace does not replay: ${codeOf(e) ?? e?.message ?? e}` }
  }
  const line = (o) => JSON.stringify({ tapeapiPolicyTrace: POLICY_TRACE_VERSION, bindingHash, ...o }) + '\n'
  let queue = Promise.resolve()
  const serial = (f) => { const run = queue.then(f); queue = run.catch(() => {}); return run }
  async function locked(f) {
    const release = typeof store.lock === 'function' ? await store.lock() : null
    try { return await f() } finally { if (release) release() }
  }
  function start(reason, ts) {
    store.append(line({ type: 'start', ts, reason: String(reason ?? '') }))
    seenText = null
    load()
  }
  if (!closed) {
    await serial(() => locked(() => {
      load()
      // a combinational policy keeps its trace for audit only: its first use starts it / 组合策略的轨迹只供审计：首次使用时开始
      if (!traceBroken && !started && !circuit.stateful) { try { start('first use (combinational policy)', clock()) } catch (e) { traceBroken = `the trace store cannot be written: ${e?.message ?? e}` } }
    }))
  }
  const enforceable = result?.enforceable ?? null

  async function admitOne(req) {
    if (closed) return deny(closed, { bindingHash })
    const ts = clock()
    if (!Number.isSafeInteger(ts) || ts < 0) return deny('clock-invalid', { bindingHash })
    // §4.4: time and revocation before every decision, and the binder again (R30-C3). These are network reads: they run
    // before the trace lock is taken, so a slow read cannot hold the lock past staleMs (N4); the decision still waits for
    // them (`serial`), and the trace is read under the lock as before. / 每次判定前重查时间、撤销与绑定者。这些是网络读取，
    // 放在取轨迹锁之前，慢读取不会占着锁超过 staleMs（N4）；判定仍等它们完成，轨迹照旧在锁内读取。
    const r = await check(chosen, ts)
    return locked(async () => {
      load()
      if (traceBroken) return deny('trace-unavailable', { bindingHash, ts, detail: traceBroken })
      if (!started) return deny('trace-unavailable', { bindingHash, ts, detail: 'no trace for this binding in the store: startTrace({ reason }) begins one, and is recorded' })
      if (r.status !== 'ok' || !(r.enforceable === true || r.enforceable === 'conditional')) return deny(r.problems?.[0] ?? 'binder-not-checked', { bindingHash, ts, problems: r.problems?.length ? r.problems : ['binder-not-checked'], ...(r.binderError ? { detail: r.binderError } : {}) })
      if (!isObj(req)) return deny('request-malformed', { bindingHash, ts })
      const { amount, cumulative, ...rest } = req
      let request, cum = null
      try {
        if (escrow) {
          if (amount !== undefined || cumulative === undefined) return deny('trace-malformed', { bindingHash, ts, detail: 'an escrow-session gate takes the voucher\'s cumulative, not an amount' })
          cum = BigInt(checkPolicyRequest({ ...rest, amount: cumulative, ts }).amount)
          if (cum < lastCum) return deny('trace-cumulative-decreases', { bindingHash, ts })
          request = { ...rest, amount: (cum - lastCum).toString(), ts }
        } else {
          if (cumulative !== undefined || amount === undefined) return deny('request-malformed', { bindingHash, ts, detail: 'this gate takes an amount' })
          request = { ...rest, amount: typeof amount === 'string' ? amount : String(checkPolicyRequest({ ...rest, amount, ts }).amount), ts }
        }
        checkPolicyRequest(request)
      } catch (e) { if (codeOf(e)) return deny(codeOf(e), { bindingHash, ts }); throw e }
      if (BigInt(ts) < lastTs) return deny('trace-not-monotone', { bindingHash, ts })
      const res = evaluatePolicyRequest(circuit, request, tables, circuit.stateful ? state : null)
      const recorded = { asset: request.asset, counterparty: request.counterparty, kind: request.kind, ts, ...(escrow ? {} : { amount: request.amount }) }
      const written = line({ type: 'entry', request: recorded, ...(escrow ? { cumulative: cum.toString() } : {}), verdict: res.verdict })
      const before = seenText
      try { store.append(written) } catch (e) {
        // not written, not counted: the state does not move / 没写进去就不算：状态不推进
        seenText = null
        return deny('trace-unavailable', { bindingHash, ts, detail: `the trace store cannot be written: ${e?.message ?? e}` })
      }
      entries.push({ request: recorded, ...(escrow ? { cumulative: cum.toString() } : {}), verdict: res.verdict })
      if (circuit.stateful) state = fromHex(res.newState)
      lastTs = BigInt(ts)
      if (escrow && res.verdict === 'allow') lastCum = cum
      // Our own line, and the state above already includes it: the store now holds what was read plus that line, so the next
      // decision replays only when the store holds anything else (another gate's line, an edit). It re-read and replayed
      // the whole trace before every decision, O(n) each (FIXED R30-C2). / 自己的这一行已计入上面的状态：存储里应是读到的内容
      // 加这一行，下次判定只有在存储里还有别的内容（别的守门方的行、改动）时才重放。原先每次判定都整段重放，每次 O(n)。
      seenText = before === null ? null : before + written
      const { newState, outputs, ...shown } = res
      return { ...shown, problems: [], bindingHash, ts, amount: request.amount, enforceable: r.enforceable }
    })
  }

  return Object.freeze({
    /** Decide one request: `{ amount | cumulative, asset, counterparty, kind }`; serve or settle only on verdict 'allow'. */
    admit: (req) => serial(() => admitOne(req)).catch((e) => deny('gate-error', { bindingHash, detail: e?.message ?? String(e) })),
    /** The trace since the last start, in replayPolicyTrace's entry form. / 自上次开始以来的轨迹。 */
    trace: () => entries.map((e) => ({ ...e, request: { ...e.request } })),
    /** Begin (or restart) the trace at the gatekeeper's time, from the zero state, and record why. / 开始或重开轨迹并记录原因。 */
    startTrace: ({ reason } = {}) => serial(() => locked(() => {
      if (closed) return deny(closed, { bindingHash })
      if (typeof reason !== 'string' || !reason) invalid('startTrace needs { reason }: it is recorded in the trace')
      // a broken or missing trace is restarted only on purpose, and the restart is recorded / 坏的或缺失的轨迹只能有意重开，并留下记录
      start(reason, clock())
      return { started: true, bindingHash }
    })),
    status: () => ({
      open: !closed, problem: closed, bindingHash, enforceable, binding: result, stateful: circuit?.stateful ?? null,
      traceStarted: started, traceProblem: traceBroken, display: result?.display ?? null,
    }),
  })
}
