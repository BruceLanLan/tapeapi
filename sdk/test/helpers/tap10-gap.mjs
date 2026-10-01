// Runs the official TAP-10 v1.1 test cases (fixtures/tap10-test-cases.json) through this SDK's entry points, offline, and
// reports, per case, what the SDK does next to what TAP-10 expects. Pure: no network (every RPC goes to the in-process
// fake chain; the global fetch is replaced by a thrower while the cases run). It changes nothing in the SDK.
// Used by scripts/tap10-gap.mjs (the table) and sdk/test/tap10-gap.test.mjs (pins today's results).
// 用我们 SDK 的入口离线跑官方 TAP-10 v1.1 的测试用例，逐例对比"SDK 实际所做"与"TAP-10 期望"。纯离线：所有 RPC 走进程内假链，
// 运行期间全局 fetch 被替换为抛错函数。不改变 SDK 的任何行为。供 scripts/tap10-gap.mjs（出表）与 sdk/test/tap10-gap.test.mjs（钉住当前结果）使用。
//
// Equivalence rules (the SDK has no TAP-10 status vocabulary, so each rule below is a judgement made here, in the open):
// 比较规则（SDK 没有 TAP-10 的结果码，所以下面每条都是在这里明说的判断）：
//   input error   = resolve() rejects a name-shaped input with MANIFEST_INVALID before sending any RPC request. / 在发出任何 RPC 之前拒绝。
//   no-such-cpu   = resolve() rejects with NOT_FOUND "processor <n> does not exist", reading only the named chain. / 只读名字所指的链。
//   no-such-token / not-tapeout = the SDK must fail with an error that tells these apart from "this container has no
//                   manifest"; otherwise they are not reproduced. / 必须能与"该容器没有清单"区分，否则视为未复现。
//   identity      = parseTapeName() yields the same chain, processor number, #ID (and canonical name when the TAP gives one).
// A verdict is CONFORMS, GAP (the SDK's result differs), or NOT-JUDGED (needs mainnet state, see the fixture's needsChainReason).
// CONFORMS only says the part this script can judge offline equals TAP-10; on-chain parts are listed as `unjudged`.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createTapeAPI, CHAINS, CHAIN_IDS, MANIFEST_KEY, parseTapeName, isNameShaped, TapeAPIError } from '../../src/index.js'
import { selector, encodeCall, decodeCall, functionBySelector } from '../../src/abi.js'
import { privateKeyToAddress, signDigest, delegationDigest } from '../../src/sig.js'
import { createFakeChain, ADDR } from './fake-chain.mjs'

export const FIXTURE = fileURLToPath(new URL('../fixtures/tap10-test-cases.json', import.meta.url))
export const loadFixture = () => JSON.parse(readFileSync(FIXTURE, 'utf8'))

// The reads TAP-10 requires that the SDK's ABI table does not even contain (selectors recomputed here, not copied).
// TAP-10 要求而 SDK 的 ABI 表里根本没有的读取（选择器在此重新计算）。
export const TAP10_READS = Object.freeze({
  cpuCount: selector('cpuCount()'),                       // §4.2 step 1
  isOpened: selector('isOpened(address,uint256)'),        // §4.2 step 5
  isLive: selector('isLive(string,address)'),             // §6.3 (1)
  isContainerLive: selector('isContainerLive(address)'),  // §6.3 (2)
})

const nodes = (id) => [`http://rpc${id}-a`, `http://rpc${id}-b`]
const OPTS = { quorum: 2, hub: ADDR.hub, siteRegistry: ADDR.siteRegistry, factory: ADDR.factory }

// ── the fake world: one fake chain per TapeOut chain, one counting fetch ────────────────────────────────────────────
// 假世界：每条 TapeOut 链一条假链，一个带计数的 fetch。
export function buildWorld() {
  const chains = {
    56: createFakeChain(),
    196: createFakeChain({ chainId: 196, addr: { ...ADDR, factory: CHAINS[196].factory } }),
    8453: createFakeChain({ chainId: 8453, addr: { ...ADDR, factory: CHAINS[8453].factory } }),
  }
  const sent = []                  // every JSON-RPC call: { chainId, method, selector } / 每个 JSON-RPC 调用
  const zeroProcessor = { 56: false, 196: false, 8453: false }   // answer cpuAt(0) like cpuAt(7) / 让 cpuAt(0) 与 cpuAt(7) 同答
  const fetch = async (url, init) => {
    const m = /^http:\/\/rpc(56|196|8453)-/.exec(String(url))
    if (!m) throw new Error(`offline: no route to ${url}`)
    const id = Number(m[1])
    let body = JSON.parse(init.body)
    const each = (Array.isArray(body) ? body : [body])
    for (const r of each) sent.push({ chainId: id, method: r.method, selector: r.method === 'eth_call' ? String(r.params[0].data).slice(0, 10) : null })
    // The fake factory answers cpuAt(7) only. Where a case needs processor 0 to exist, cpuAt(0) is rewritten to cpuAt(7)
    // here, in front of the shared fake (which is not edited). / 假工厂只答 cpuAt(7)；用例需要 0 号处理器存在时在此改写。
    if (zeroProcessor[id]) {
      const rewrite = (r) => (r.method === 'eth_call' && functionBySelector(r.params[0].data) === 'cpuAt' && decodeCall('cpuAt', r.params[0].data)[0] === 0n)
        ? { ...r, params: [{ ...r.params[0], data: encodeCall('cpuAt', [7n]) }, ...r.params.slice(1)] } : r
      body = Array.isArray(body) ? body.map(rewrite) : rewrite(body)
    }
    return chains[id].fetch(String(url), { ...init, body: JSON.stringify(body) })
  }
  const api = (extra = {}) => createTapeAPI({
    rpcUrls: nodes(56), fetch, ...OPTS, chains: { 196: { rpcUrls: nodes(196) }, 8453: { rpcUrls: nodes(8453) } }, ...extra,
  })
  return { chains, sent, fetch, api, zeroProcessor }
}

const perChain = (sent, from) => Object.fromEntries(CHAIN_IDS.map((id) => [id, sent.slice(from).filter((x) => x.chainId === id).length]))

/** resolve(input) as a caller sees it, with the RPC calls it caused per chain. / 调用方看到的 resolve(input)，及其各链 RPC 次数。 */
export async function tryResolve(world, api, input) {
  const from = world.sent.length
  try { const svc = await api.resolve(input); return { ok: true, chainId: svc.chainId, rpc: perChain(world.sent, from) } }
  catch (e) {
    if (!(e instanceof TapeAPIError)) throw e
    return { ok: false, code: e.code, message: e.message, rpc: perChain(world.sent, from) }
  }
}
const rpcTotal = (r) => Object.values(r.rpc).reduce((a, b) => a + b, 0)
const head = (s, n = 90) => String(s).replace(/\s+/g, ' ').slice(0, n)

// ── a full, valid BNB service in the fake chain (for the "which reads does a resolution make" measurement) ────────────
const HOLDER_KEY = '0x' + '11'.repeat(32), SIGNER_KEY = '0x' + '22'.repeat(32)
function installService(world, tokenId = 4246) {
  const holder = privateKeyToAddress(HOLDER_KEY), signer = privateKeyToAddress(SIGNER_KEY)
  const expires = Math.floor(Date.now() / 1000) + 30 * 86400
  const c = world.chains[56]
  c.setOwner(tokenId, holder); c.setAccount(tokenId, ADDR.container); c.setContainerToken(ADDR.container, { tokenId })
  c.writeFile(ADDR.container, MANIFEST_KEY, JSON.stringify({
    tapeapi: '0.1', name: 'svc', circuits: ADDR.circuits, tokenId: String(tokenId), container: ADDR.container, signer,
    delegation: { expires, sig: signDigest(delegationDigest(56, ADDR.hub, { container: ADDR.container, signer, expires }), HOLDER_KEY) },
    endpoints: { live: ['https://svc.example.com/tapeapi/v1'], async: false },
    methods: [{ name: 'ping', priceBEM: '0', params: {}, returns: {} }],
    payment: { escrow: '0x' + '41'.repeat(20), unit: 'BEM', decimals: 8 },
  }))
}

// ── per-kind runners; each returns { verdict, ours, obs, tag?, note?, unjudged? } ──────────────────────────────────────
// `ours`: one line for the table; `obs`: the raw observation the test pins; `tag`: the TAP-10 strength of the requirement.
// ours：表里的一行；obs：测试钉住的原始观察；tag：TAP-10 对该要求的强度。

const same = (parsed, id) => parsed && !parsed.error && parsed.chainId === id.chainId && parsed.processor === id.processorNumber && parsed.tokenId === id.tokenId
  && (id.canonicalName === undefined || parsed.name === id.canonicalName)

// Cases whose expected result is a chain, processor number and #ID for a name (or a form of one).
async function identityOfInput(c) {
  const parsed = parseTapeName(c.input)
  const want = c.expected.identity
  const unjudged = c.expectedOnChain ? Object.keys(c.expectedOnChain) : []
  const shouldTag = c.source.includes('SHOULD') || /display label|URL|processor contract#ID/.test(c.form) ? 'SHOULD §3.4' : 'MUST §3.1'
  if (parsed && !parsed.error) {
    const ok = same(parsed, want)
    return { verdict: ok ? 'CONFORMS' : 'GAP', ours: `name: chain ${parsed.chainId}, processor ${parsed.processor}, #${parsed.tokenId}, ${parsed.name}`,
      obs: { parse: 'name', chainId: parsed.chainId, processor: parsed.processor, tokenId: parsed.tokenId, name: parsed.name }, unjudged }
  }
  if (parsed?.error) {
    const w = buildWorld(); const r = await tryResolve(w, w.api(), c.input)
    return { verdict: 'GAP', tag: shouldTag, ours: `refused: ${r.code} "${head(parsed.error, 60)}" (0 RPC)`,
      obs: { parse: 'error', code: r.code, message: r.message, rpcTotal: rpcTotal(r) }, unjudged }
  }
  // not name-shaped: what resolve() makes of it (a processor contract#ID string, for instance)
  const w = buildWorld(); const r = await tryResolve(w, w.api(), c.input)
  return { verdict: 'GAP', tag: shouldTag, ours: `not an input form: ${r.code} "${head(r.message, 50)}" (treated as a directory label)`,
    obs: { parse: 'not-name-shaped', code: r.code, message: r.message, rpcTotal: rpcTotal(r) }, unjudged }
}

// Input error cases (TAP-10: rejected, no guessing).
async function inputError(c) {
  const w = buildWorld()
  const r = await tryResolve(w, w.api(), c.input)
  const shaped = isNameShaped(c.input)
  if (!r.ok && shaped && r.code === 'MANIFEST_INVALID' && rpcTotal(r) === 0) {
    return { verdict: 'CONFORMS', ours: `refused: ${r.code} "${head(r.message, 60)}" (0 RPC)`, obs: { shaped, code: r.code, message: r.message, rpcTotal: 0 } }
  }
  // A string that is not name-shaped is looked up as a directory label: show it with and without a configured directory.
  const w2 = buildWorld(); const r2 = await tryResolve(w2, w2.api({ directory: ADDR.directory }), c.input)
  return {
    verdict: 'GAP', tag: 'MUST §3.4',
    ours: `not refused: no directory -> ${r.code} "${head(r.message, 40)}"; with a directory -> ${r2.code} "${head(r2.message, 40)}" after ${rpcTotal(r2)} RPC (guessed a label)`,
    obs: { shaped, noDirectory: { code: r.code, message: r.message, rpcTotal: rpcTotal(r) }, withDirectory: { code: r2.code, message: r2.message, rpcTotal: rpcTotal(r2) } },
  }
}

// A name for a processor / token that does not exist (cases 17, 18, 19).
async function missingOnChain(c) {
  const w = buildWorld()
  const name = parseTapeName(c.input)
  const wantStatus = c.expected.status
  if (wantStatus === 'no-such-cpu') {
    const r = await tryResolve(w, w.api(), c.input)
    const onlyChain = CHAIN_IDS.filter((id) => r.rpc[id] > 0)
    const okChain = c.expected.chainId === undefined ? true : onlyChain.length === 1 && onlyChain[0] === c.expected.chainId
    const ok = !r.ok && r.code === 'NOT_FOUND' && /^processor \d+ does not exist$/.test(r.message) && okChain && onlyChain.every((id) => id === name.chainId)
    return { verdict: ok ? 'CONFORMS' : 'GAP', ours: `${r.code} "${r.message}", chains read: ${onlyChain.join(',') || 'none'}`,
      obs: { code: r.code, message: r.message, chainsRead: onlyChain }, note: 'no TAP-10 status code: NOT_FOUND plus the message tells it apart from no-such-token' }
  }
  // no-such-token: processor 0 exists, accountOf derives an address, ownerOf(#ID) reverts (nothing minted).
  w.zeroProcessor[56] = true
  const container = '0x' + 'd0'.repeat(20)
  w.chains[56].setAccount(name.tokenId, container)
  const r = await tryResolve(w, w.api(), c.input)
  // control: the same name when the token DOES exist but its container has published no manifest
  const w2 = buildWorld(); w2.zeroProcessor[56] = true
  w2.chains[56].setAccount(name.tokenId, container); w2.chains[56].setOwner(name.tokenId, privateKeyToAddress(HOLDER_KEY))
  const control = await tryResolve(w2, w2.api(), c.input)
  const indistinct = !r.ok && !control.ok && r.code === control.code && r.message === control.message
  return {
    verdict: indistinct ? 'GAP' : 'CONFORMS', tag: 'MUST §4.2/§4.4',
    ours: `${r.code} "${head(r.message, 70)}"; the same error when the token exists but has no manifest (control)`,
    obs: { code: r.code, message: r.message, controlCode: control.code, controlMessage: control.message, indistinguishable: indistinct },
    note: 'the manifest is read before ownerOf, so a missing token and a missing manifest look the same',
  }
}

// A container address that is not a TapeOut container (case 20).
async function notTapeout(c) {
  const w = buildWorld()
  const api = w.api()
  const viaResolve = await tryResolve(w, api, c.input)
  let viaTokenOf
  try { await api.chain.tokenOf(c.input); viaTokenOf = { ok: true } } catch (e) { viaTokenOf = { ok: false, code: e.code, message: e.message } }
  // control: a real container with no manifest
  const w2 = buildWorld(); const real = '0x' + 'c1'.repeat(20); w2.chains[56].setContainerToken(real, { tokenId: 1 })
  const control = await tryResolve(w2, w2.api(), real)
  const stepOne = !viaTokenOf.ok && viaTokenOf.code === 'NOT_FOUND' && /not a TapeOut container/.test(viaTokenOf.message)
  const indistinct = !viaResolve.ok && !control.ok && viaResolve.code === control.code && /no file at/.test(viaResolve.message) && /no file at/.test(control.message)
  return {
    verdict: stepOne && !indistinct ? 'CONFORMS' : 'GAP', tag: 'MUST §4.3 step 1',
    ours: `resolve(): ${viaResolve.code} "${head(viaResolve.message, 50)}" (same as a real container with no manifest); chain.tokenOf(): ${viaTokenOf.code} "${head(viaTokenOf.message, 55)}"`,
    obs: { resolve: { code: viaResolve.code, message: viaResolve.message }, tokenOf: viaTokenOf, controlCode: control.code, controlMessage: control.message },
    note: 'chain.tokenOf() does the §4.3 step 1 read and says not a container; resolve() reads the manifest first and does not',
  }
}

// A container address, to a name (cases 6, 13): what can the SDK say about it?
async function containerToName(c) {
  const w = buildWorld()
  const want = c.expected.identity ?? { chainId: 56, processorNumber: '0', tokenId: '4246' }
  const circuits = c.id === 'TAP10-13' ? '0x0565EA48CA41Ae559d8d491dbb0a9ec945DB551b' : '0x50A994E71615474b55559fF4F500928fbc339DD9'
  const tokenId = c.id === 'TAP10-13' ? 1 : 4246
  w.chains[want.chainId].setContainerToken(c.input, { circuits, tokenId, chainId: want.chainId })
  const api = w.api()
  const chainId = await api.chainOfContainer(c.input)
  const tok = await api.forChain(chainId).chain.tokenOf(c.input)
  const keys = Object.keys(tok).sort()
  const hasNumber = 'processor' in tok || 'processorNumber' in tok
  return {
    verdict: chainId === want.chainId && tok.tokenId === String(tokenId) && hasNumber ? 'CONFORMS' : 'GAP', tag: 'MUST §4.3 step 3',
    ours: `chainOfContainer -> ${chainId}; tokenOf -> {${keys.join(', ')}}: no processor number, so no name (chain.cpuAt goes number -> contract only)`,
    obs: { chainId, tokenOfKeys: keys, tokenId: tok.tokenId, hasProcessorNumber: hasNumber },
    unjudged: Object.keys(c.expectedOnChain ?? {}),
    note: 'the SDK finds the chain and the #ID, not the processor number: it has no reverse scan of factory.cpuAt',
  }
}

// processor contract#ID without chain information (case 16): the SDK path, if any, that can say `ambiguous`.
async function ambiguous(c) {
  const w = buildWorld(); const r = await tryResolve(w, w.api(), c.input)
  return { verdict: 'GAP', tag: 'MUST §4.1', ours: `not an input form: ${r.code} "${head(r.message, 50)}" (${rpcTotal(r)} RPC); no code path produces ambiguous`,
    obs: { code: r.code, message: r.message, rpcTotal: rpcTotal(r) } }
}

// Accepted implementations (case 27): chains.js against TAP-10 Deployments.
function acceptedImplementations(c) {
  const lc = (a) => String(a).toLowerCase()
  const problems = []
  for (const [id, roles] of Object.entries(c.expected.accepted)) {
    const chain = CHAINS[id]
    for (const [role, field] of [['siteStore', 'siteRegistry'], ['payment', 'binding']]) {
      const want = roles[role]
      if (lc(chain[field]) !== lc(want.proxy)) problems.push(`${id} ${role} proxy ${chain[field]} is not ${want.proxy}`)
      const have = (chain.expectedImpl[lc(want.proxy)] ?? []).map(lc).sort()
      const need = want.impls.map(lc).sort()
      if (JSON.stringify(have) !== JSON.stringify(need)) problems.push(`${id} ${role} implementations ${have.join('|') || 'none'} differ from ${need.join('|')}`)
    }
  }
  return { verdict: problems.length ? 'GAP' : 'CONFORMS', ours: problems.length ? problems.join('; ') : 'chains.js lists the same proxies and accepted implementations on 56, 196 and 8453',
    obs: { problems }, note: 'data only: whether a resolution refuses an unlisted implementation is a separate finding (analysis 2.4 item 1, not a TAP-10 test case)' }
}

// The reads a full resolution makes (structural, qualifies every "status half" of the cases above).
export async function readsOfAFullResolution() {
  const w = buildWorld(); installService(w)
  const svc = await w.api().resolve('4246.7.tape')
  const names = [...new Set(w.sent.filter((x) => x.selector).map((x) => functionBySelector(x.selector + '0'.repeat(64)) ?? x.selector))].sort()
  const issued = new Set(w.sent.map((x) => x.selector).filter(Boolean))
  const absent = Object.fromEntries(Object.entries(TAP10_READS).map(([k, sel]) => [k, !issued.has(sel)]))
  return { resolved: !!svc.container, calls: names, neverIssued: absent, anyIssued: Object.values(absent).some((v) => !v) }
}

const KINDS = {
  identity: identityOfInput, inputError, missingOnChain, notTapeout, containerToName, ambiguous,
}
function kindOf(c) {
  if (c.n === 27) return 'accepted'
  if ([7, 8, 9, 10].includes(c.n)) return null
  if (c.n === 6 || c.n === 13) return 'containerToName'
  if (c.n === 16) return 'ambiguous'
  if (c.n === 17 || c.n === 18 || c.n === 19) return 'missingOnChain'
  if (c.n === 20) return 'notTapeout'
  if (c.expected.status === 'input-error') return 'inputError'
  if (c.expected.identity) return 'identity'
  return null
}

/** Run every fixture case. Throws if anything tries to reach the network. / 运行全部用例；一旦有东西想联网就抛错。 */
export async function runAll() {
  const fixture = loadFixture()
  const realFetch = globalThis.fetch
  let leaked = 0
  globalThis.fetch = () => { leaked++; throw new Error('tap10-gap is offline: a network request was attempted') }
  try {
    const rows = []
    for (const c of fixture.cases) {
      const kind = kindOf(c)
      const base = { id: c.id, n: c.n, row: c.row, input: c.input, expected: c.expectedText, source: c.source, needsChain: c.needsChain, needsChainReason: c.needsChainReason ?? null }
      if (kind === null) { rows.push({ ...base, verdict: 'NOT-JUDGED', ours: '-', obs: null, tag: null, note: c.needsChainReason, unjudged: [] }); continue }
      const res = kind === 'accepted' ? acceptedImplementations(c) : await KINDS[kind](c)
      rows.push({ ...base, tag: null, note: null, unjudged: [], ...res })
    }
    if (leaked) throw new Error('network request attempted')
    return { fixture, rows, structural: await readsOfAFullResolution(), summary: summarize(rows) }
  } finally { globalThis.fetch = realFetch }
}

export function summarize(rows) {
  const count = (v) => rows.filter((r) => r.verdict === v).length
  return { rows: new Set(rows.map((r) => r.row)).size, cases: rows.length, judged: rows.length - count('NOT-JUDGED'), conforms: count('CONFORMS'), gaps: count('GAP'), notJudged: count('NOT-JUDGED') }
}

// ── the conformance mode (createTapeAPI({ conform: 'tap10' }), 1.4) / 一致模式 ────────────────────────────────────────
// The same cases, run in the conformance mode against conform chains (helpers/conform-chain.mjs: the opener, DomainBinding,
// cpuCount and per-node heads answered by address, every contract at its real TAP-10 address). The processors the cases
// name are put at their real numbers: 0x50A9…9DD9 is processor 0 on BNB Smart Chain, 0x0565…551b processor 1 on Base and on
// X Layer; containers are derived by ERC-6551 exactly as the opener does, so they come out equal to the containers TAP-10
// lists (0x86DD…, 0x4591…, 0x374f…). Site statuses are not judged here (they depend on mainnet state): only identity,
// identity outcomes, input errors and the reads a resolution makes.
// 同样的用例，在一致模式下对 conform 链运行（开通器、DomainBinding、cpuCount 与各节点头块按地址回答，每个合约都在其真实的 TAP-10
// 地址）。用例提到的处理器放在其真实编号上；容器按 ERC-6551 推导（与开通器相同），因此与 TAP-10 列出的容器相等。站点状态不在此判定
// （取决于主网状态）：只判身份、身份结果、输入错误与一次解析所做的读取。
import { createConformChain } from './conform-chain.mjs'

const GENESIS = '0x50A994E71615474b55559fF4F500928fbc339DD9', L2_ONE = '0x0565EA48CA41Ae559d8d491dbb0a9ec945DB551b'
const TAP10_CONTAINERS = { 1: '0x86DDaEF00401E3F10418398D67D7189fc458eA95', 11: '0x4591b393399452eA24ECB10424CdBA194F1c4E64', 15: '0x374fa57399f356030847Eb0c56851bE9a1194E5D' }
const containerOfCase = (n) => ([1, 2, 3, 4, 5].includes(n) ? TAP10_CONTAINERS[1] : [11, 12].includes(n) ? TAP10_CONTAINERS[11] : n === 15 ? TAP10_CONTAINERS[15] : undefined)

export function buildConformWorld() {
  const fill = (first) => Array.from({ length: 8 }, (_, i) => first[i] ?? '0x' + (0x70 + i).toString(16).repeat(20))
  const chains = {
    56: createConformChain({ chainId: 56, processors: fill({ 0: GENESIS }) }),
    196: createConformChain({ chainId: 196, processors: fill({ 1: L2_ONE }) }),
    8453: createConformChain({ chainId: 8453, processors: fill({ 1: L2_ONE }) }),
  }
  const holder = privateKeyToAddress(HOLDER_KEY)
  chains[56].circuit(4246, { processor: 0, holder })
  chains[8453].circuit(1, { processor: 1, holder }); chains[8453].circuit(1, { processor: 5, holder })
  chains[196].circuit(1, { processor: 1, holder })
  const sent = []
  const fetch = async (url, init) => {
    const m = /^http:\/\/rpc(56|196|8453)-/.exec(String(url))
    if (!m) throw new Error(`offline: no route to ${url}`)
    const id = Number(m[1])
    const body = JSON.parse(init.body)
    for (const r of (Array.isArray(body) ? body : [body])) sent.push({ chainId: id, method: r.method, selector: r.method === 'eth_call' ? String(r.params[0].data).slice(0, 10) : null })
    return chains[id].fetch(String(url), init)
  }
  const api = (extra = {}) => createTapeAPI({
    conform: 'tap10', rpcUrls: nodes(56), quorum: 2, fetch, quiet: true, onWarning: () => {}, chains: { 196: { rpcUrls: nodes(196) }, 8453: { rpcUrls: nodes(8453) } }, ...extra,
  })
  return { chains, sent, fetch, api, holder }
}
async function tryConform(world, run) {
  const from = world.sent.length
  try { const v = await run(); return { ok: true, value: v, rpc: perChain(world.sent, from) } }
  catch (e) { if (!(e instanceof TapeAPIError)) throw e; return { ok: false, code: e.code, status: e.data?.status ?? null, message: e.message, rpc: perChain(world.sent, from) } }
}
const CONFORM_KINDS = {
  // identity of a name in any TAP-10 form, and of a processor contract#ID, from siteStatus / 用 siteStatus 判身份
  async identity(c) {
    const w = buildConformWorld()
    const want = c.expected.identity
    const r = await tryConform(w, () => w.api().siteStatus(c.input))
    if (!r.ok) return { verdict: 'GAP', ours: `${r.code} ${r.status}: ${head(r.message, 70)}`, obs: { code: r.code, status: r.status } }
    const s = r.value
    const wantContainer = containerOfCase(c.n)
    const ok = s.chainId === want.chainId && s.processor === want.processorNumber && s.tokenId === want.tokenId
      && (want.canonicalName === undefined || s.name === want.canonicalName) && (wantContainer === undefined || s.container === wantContainer)
    return { verdict: ok ? 'CONFORMS' : 'GAP', ours: `chain ${s.chainId}, processor ${s.processor ?? 'unknown'}, #${s.tokenId}, ${s.name ?? 'no name'}, container ${s.container}`,
      obs: { chainId: s.chainId, processor: s.processor, tokenId: s.tokenId, name: s.name, container: s.container },
      ...(ok ? {} : { note: 'the processor number of a processor contract needs the reverse scan of factory.cpuAt (1.5)' }) }
  },
  async inputError(c) {
    const w = buildConformWorld()
    const r = await tryConform(w, () => w.api({ directory: ADDR.directory }).resolve(c.input))
    const ok = !r.ok && r.code === 'INVALID_ARGUMENT' && r.status === 'input-error' && rpcTotal(r) === 0
    return { verdict: ok ? 'CONFORMS' : 'GAP', ours: `${r.code} ${r.status} (${rpcTotal(r)} RPC, a directory configured)`, obs: { code: r.code, status: r.status, rpcTotal: rpcTotal(r) } }
  },
  async missingOnChain(c) {
    const w = buildConformWorld()
    const r = await tryConform(w, () => w.api().resolve(c.input))
    const name = parseTapeName(c.input)
    const chainsRead = CHAIN_IDS.filter((id) => r.rpc[id] > 0)
    if (c.expected.status === 'no-such-cpu') {
      const ok = !r.ok && r.code === 'NOT_FOUND' && r.status === 'no-such-cpu' && chainsRead.length === 1 && chainsRead[0] === name.chainId && (c.expected.chainId === undefined || chainsRead[0] === c.expected.chainId)
      return { verdict: ok ? 'CONFORMS' : 'GAP', ours: `${r.code} ${r.status}, chains read: ${chainsRead.join(',')}`, obs: { code: r.code, status: r.status, chainsRead } }
    }
    // no-such-token, against a token that exists with no manifest (the control) / 对照：token 存在但没有清单
    const w2 = buildConformWorld(); w2.chains[56].circuit(name.tokenId, { processor: 0, holder: w2.holder })
    const control = await tryConform(w2, () => w2.api().resolve(c.input))
    const ok = !r.ok && r.code === 'NOT_FOUND' && r.status === 'no-such-token' && !control.ok && control.status === 'no-manifest'
    return { verdict: ok ? 'CONFORMS' : 'GAP', ours: `${r.code} ${r.status}; the control (token, no manifest): ${control.code} ${control.status}`, obs: { code: r.code, status: r.status, controlCode: control.code, controlStatus: control.status } }
  },
  async notTapeout(c) {
    const w = buildConformWorld()
    const r = await tryConform(w, () => w.api().resolve(c.input))
    const ok = !r.ok && r.code === 'NOT_FOUND' && r.status === 'not-tapeout'
    return { verdict: ok ? 'CONFORMS' : 'GAP', ours: `${r.code} ${r.status}: ${head(r.message, 60)}`, obs: { code: r.code, status: r.status },
      ...(ok ? {} : { note: 'not-tapeout needs every active chain read (TAP-10 §4.1); 1.4 reads one chain and says unsupported (1.5)' }) }
  },
  async containerToName(c) {
    const w = buildConformWorld()
    const r = await tryConform(w, () => w.api().siteStatus(c.input))
    const want = c.expected.reverseName ?? null
    const name = r.ok ? r.value.name : null
    return { verdict: want !== null && name === want ? 'CONFORMS' : 'GAP', ours: r.ok ? `chain ${r.value.chainId}, status ${r.value.status}, name ${name ?? 'unknown (no reverse scan)'}` : `${r.code} ${r.status}`,
      obs: r.ok ? { chainId: r.value.chainId, status: r.value.status, name, processor: r.value.processor } : { code: r.code, status: r.status },
      note: 'reverse resolution to a name needs the processor-number scan and, without chain information, every active chain (1.5)' }
  },
  async ambiguous(c) {
    const w = buildConformWorld()
    const r = await tryConform(w, () => w.api().siteStatus(c.input))
    const chainsRead = CHAIN_IDS.filter((id) => r.rpc[id] > 0)
    return { verdict: !r.ok && r.status === 'ambiguous' ? 'CONFORMS' : 'GAP', ours: r.ok ? `resolved on chain ${r.value.chainId} only (status ${r.value.status}); chains read: ${chainsRead.join(',')}` : `${r.code} ${r.status}`,
      obs: r.ok ? { chainId: r.value.chainId, status: r.value.status, chainsRead } : { code: r.code, status: r.status }, note: 'every active chain and `ambiguous` are 1.5' }
  },
}

/** The reads a full resolution makes in the conformance mode. / 一致模式下一次完整解析所做的读取。 */
export async function readsOfAConformResolution() {
  const w = buildConformWorld()
  const c = w.chains[56]
  const container = TAP10_CONTAINERS[1]
  const signer = privateKeyToAddress(SIGNER_KEY), expires = Math.floor(Date.now() / 1000) + 30 * 86400
  c.writeFile(container, MANIFEST_KEY, JSON.stringify({
    tapeapi: '0.1', name: 'svc', circuits: GENESIS, tokenId: '4246', container, signer,
    delegation: { expires, sig: signDigest(delegationDigest(56, CHAINS[56].hub, { container, signer, expires }), HOLDER_KEY) },
    endpoints: { live: ['https://svc.example.com/tapeapi/v1'], async: false }, methods: [{ name: 'ping', priceBEM: '0', params: {}, returns: {} }],
  }))
  const svc = await w.api().resolve('4246.0.tape')
  const issued = new Set(w.sent.map((x) => x.selector).filter(Boolean))
  const absent = Object.fromEntries(Object.entries(TAP10_READS).map(([k, sel]) => [k, !issued.has(sel)]))
  return { resolved: svc.container === container, site: svc.conform.site, neverIssued: absent }
}

/** Every fixture case in the conformance mode. / 一致模式下的全部用例。 */
export async function runAllConform() {
  const fixture = loadFixture()
  const realFetch = globalThis.fetch
  let leaked = 0
  globalThis.fetch = () => { leaked++; throw new Error('tap10-gap is offline: a network request was attempted') }
  try {
    const rows = []
    for (const c of fixture.cases) {
      const kind = kindOf(c)
      const base = { id: c.id, n: c.n, row: c.row, input: c.input, expected: c.expectedText, source: c.source, needsChain: c.needsChain }
      if (kind === null) { rows.push({ ...base, verdict: 'NOT-JUDGED', ours: '-', obs: null }); continue }
      const res = kind === 'accepted' ? acceptedImplementations(c) : await CONFORM_KINDS[kind](c)
      rows.push({ ...base, note: null, ...res })
    }
    if (leaked) throw new Error('network request attempted')
    return { rows, structural: await readsOfAConformResolution(), summary: summarize(rows) }
  } finally { globalThis.fetch = realFetch }
}
