// TapeAPI Playground: resolve a TapeOut service and call it with the real SDK, showing what the SDK checked.
// Hand-written. The SDK is vendored by scripts/build-playground.mjs, which also writes the vendor/<hash>/ path below;
// bare @noble imports go through the import map.
// Everything the manifest or a provider says is untrusted text: it reaches the page through textContent only.
// 调试台：用真实的 SDK 解析并调用 TapeOut 服务，展示 SDK 核对了什么。手写；SDK 由 scripts/build-playground.mjs 放入 vendor/<hash>/，
// 下面导入里的路径也由它写入。
// 清单与提供者给出的一切都是不可信文本，只经 textContent 进入页面。
import { createTapeAPI, TapeAPIError, parseUnits, sig, abi, rpcUrlsFor, operatorOf, CHAINS, chainByArea } from './vendor/87f18f4a0b/tapeapi-sdk/index.js'

// The SDK's default nodes: three distinct operators (NodeReal, Alchemy, 48 Club); the SDK counts agreement by operator.
// SDK 的默认节点：三家不同运营方；SDK 按运营方计票。
// A name with an area code (1.2.344.tape on X Layer, 1.3.5.tape on Base) is read on that chain through the SDK's default
// nodes for it, with the same operator quorum. / 带区号的名字在那条链上读取，用 SDK 对该链的默认节点，法定数相同。
const RPC_URLS = rpcUrlsFor(56)
const QUORUM = 2
const operatorsOn = (chainId) => new Set(rpcUrlsFor(chainId).map(operatorOf)).size
const PUBLIC_EXAMPLES = {   // prefilled params for the public service's methods / 公共服务各方法的示例参数
  balance: { address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c' },   // WBNB contract: holds a lot of BNB
  tokenInfo: { token: '0x55d398326f99059fF775485246999027B3197955' },   // USDT (BSC)
  tokenBalance: { token: '0x55d398326f99059fF775485246999027B3197955', address: '0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE' },
  nftOwner: { contract: '0xe02c26c7432A7121168AA9B610DE24eCf9a1a414', tokenId: '11' },   // circuit #11 of processor 1013
  pairPrice: { pair: '0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE' },   // PancakeSwap V2 WBNB/USDT
  tapeName: { name: '12.1013.tape' },
}

// ── language / 语言 ──────────────────────────────────────────────────────────────────────────────────────────────
const T = {
  zh: {
    section: '调试台', docs: '手册', theme: '主题', light: '浅色', dark: '深色', other: 'English', copy: '复制', copied: '已复制',
    title: '调试台',
    lede: '输入一个 TapeOut 服务名，在浏览器里解析并调用它。每一项核对都由 @tapeapi/sdk 在本页完成，与仓库中的 SDK 是同一份代码；没有中间服务器替你判断。',
    'h.service': '解析服务', 'h.methods': '选择方法', 'h.call': '调用', 'h.code': '在你的代码里',
    'target.label': '服务', resolve: '解析',
    'target.hint': '可以填名称 <code>11.1013.tape</code>（#ID.处理器编号.tape；X Layer 与 Base 上的名字带区号，如 <code>1.2.344.tape</code>）、BNB Chain 上的容器地址 <code>0x…</code>，或处理器合约加编号 <code>0x… #11</code>。',
    'manifest.raw': '清单 JSON（SDK 校验后）',
    'params.json': '参数 JSON', call: '调用',
    'code.sdk': 'JavaScript（@tapeapi/sdk，会做上面的全部核对）',
    'code.curl': 'curl（只发请求，不核对签名与链上身份）',
    foot: '只读：本页不连接钱包，也不需要任何密钥。链上读取经 3 家不同运营方的公共 BSC 节点、至少 2 家一致（quorum 2）。',
    resolving: '正在读链：定位容器、读取清单、核对委托……',
    resolved: (ms, n) => `已解析并核对，用时 ${ms} ms，向节点发出 ${n} 个 RPC 请求。`,
    failed: '失败', calling: '正在调用……',
    'c.chain': '链', 'c.chain.how': '服务的身份、清单与委托都在这条链上读取；委托的签名域是 (该链 chainId, 该链的 DeWebHub)',
    'c.name': '名称', 'c.name.how': (p) => `工厂 cpuAt(${p}) 给出处理器合约`,
    'c.cpu': '处理器', 'c.cpu.how': '工厂 isCPU 为真：确实是 TapeOut 处理器，不是仿冒的 ERC-721',
    'c.container': '容器', 'c.container.how': '由中枢 accountOf(处理器, #ID) 推导，与清单里的 container 一致',
    'c.holder': '当前持有人', 'c.holder.how': (q, n) => `ownerOf，${n} 家运营方中至少 ${q} 家一致`,
    'c.manifest': '清单', 'c.manifest.how': '.well-known/tapeapi.json：字节的 SHA-256 与 SiteRegistry 链上记录一致',
    'c.delegation': '委托签名者', 'c.delegation.how': '由 EIP-712 委托签名恢复，等于当前持有人',
    'c.expires': '委托到期', 'c.endpoint': '端点', 'c.signer': '服务签名密钥', 'c.signer.how': '每个回答都必须由它签名',
    days: (d) => d >= 0 ? `（还有 ${d} 天）` : '（已过期）',
    bytes: (n) => `${n} 字节`,
    free: '免费', priced: (p) => `${p} BEM`,
    needsPayer: '需要付款方（托管合约尚未部署），本页只能调用免费方法。',
    optional: '可选', noParams: '这个方法没有参数。',
    jsonEdited: '（已手动编辑，调用时以此为准）', badJson: '参数不是合法的 JSON 对象',
    verified: '已验证：回答由清单里的签名密钥签名，并绑定本次请求', errSigned: '提供者返回了已签名的错误',
    errLocal: '调用失败',
    'o.latency': '耗时', 'o.signer': '签名者', 'o.id': '请求 id', 'o.ts': '签名时间', 'o.block': '信封 block', 'o.pinned': 'blockPinned',
    'o.result': '结果', 'o.wire': '原始信封（线上收到的字节）', 'o.request': '请求',
    'o.data': '错误数据',
    hints: {
      RPC_UNAVAILABLE: '公共 BSC 节点没有及时回应（网络或节点限流）。稍后再试。',
      RPC_DISAGREE: '节点之间答案不一致，SDK 拒绝采用。稍后再试。',
      MANIFEST_INVALID: '这个容器没有有效的 TapeAPI 清单，或清单与链上记录不符。',
      DELEGATION_INVALID: '清单的委托不是当前持有人签的，或已过期。',
      NOT_FOUND: '没有找到这个服务。',
      PROVIDER_UNAVAILABLE: '服务端点没有返回已签名的回答（离线、被拦截或网络问题）。',
      BAD_SIGNATURE: '回答的签名不对：SDK 拒绝把它当作结果。',
      RATE_LIMITED: '服务在限流，稍后再试。',
      PAYMENT_REQUIRED: '这个方法收费，需要付款方。',
      BAD_REQUEST: '参数不被接受：检查上面的参数。',
    },
    badTarget: '看不懂这个输入：请填 11.1013.tape、容器地址，或“处理器合约 #编号”。',
    badArea: (a) => `区号 ${a} 没有对应的链：X Layer 是 2，Base 是 3；BNB Chain 的名字不带区号。`,
    noProcessor: (p) => `处理器 ${p} 不存在（工厂 cpuAt 回滚）。`,
    sdkComment: (n) => `// ${n}：容器、持有人、清单哈希、委托、每个回答的签名都在本地核对`,
    curlNote: '# 注意：curl 不核对签名，也不核对链上身份',
  },
  en: {
    section: 'Playground', docs: 'Docs', theme: 'Theme', light: 'Light', dark: 'Dark', other: '中文', copy: 'Copy', copied: 'Copied',
    title: 'Playground',
    lede: 'Type a TapeOut service name, then resolve and call it from your browser. Every check is made on this page by @tapeapi/sdk, the same SDK code as in the repository; no server in the middle decides for you.',
    'h.service': 'Resolve a service', 'h.methods': 'Pick a method', 'h.call': 'Call', 'h.code': 'In your code',
    'target.label': 'Service', resolve: 'Resolve',
    'target.hint': 'A name such as <code>11.1013.tape</code> (#ID.processor.tape; names on X Layer and Base carry their area code, e.g. <code>1.2.344.tape</code>), a container address on BNB Chain <code>0x…</code>, or a processor contract and number <code>0x… #11</code>.',
    'manifest.raw': 'Manifest JSON (as validated by the SDK)',
    'params.json': 'Params JSON', call: 'Call',
    'code.sdk': 'JavaScript (@tapeapi/sdk, which makes every check above)',
    'code.curl': 'curl (sends the request; checks neither signature nor on-chain identity)',
    foot: 'Read-only: this page connects no wallet and needs no key. Chain reads go to public BSC nodes of 3 different operators, at least 2 of which must agree (quorum 2).',
    resolving: 'Reading the chain: locating the container, reading the manifest, checking the delegation…',
    resolved: (ms, n) => `Resolved and checked in ${ms} ms, with ${n} RPC requests to the nodes.`,
    failed: 'Failed', calling: 'Calling…',
    'c.chain': 'Chain', 'c.chain.how': 'identity, manifest and delegation are read on this chain; the delegation is signed for (its chainId, its DeWebHub)',
    'c.name': 'Name', 'c.name.how': (p) => `factory cpuAt(${p}) gives the processor contract`,
    'c.cpu': 'Processor', 'c.cpu.how': 'factory isCPU is true: a real TapeOut processor, not a look-alike ERC-721',
    'c.container': 'Container', 'c.container.how': 'derived by the hub, accountOf(processor, #ID), and equal to the manifest\'s container',
    'c.holder': 'Current holder', 'c.holder.how': (q, n) => `ownerOf, at least ${q} of ${n} node operators agree`,
    'c.manifest': 'Manifest', 'c.manifest.how': '.well-known/tapeapi.json: SHA-256 of the bytes equals the SiteRegistry record on chain',
    'c.delegation': 'Delegation signer', 'c.delegation.how': 'recovered from the EIP-712 delegation; equals the current holder',
    'c.expires': 'Delegation expires', 'c.endpoint': 'Endpoint', 'c.signer': 'Service signing key', 'c.signer.how': 'every answer must be signed by it',
    days: (d) => d >= 0 ? ` (in ${d} days)` : ' (expired)',
    bytes: (n) => `${n} bytes`,
    free: 'free', priced: (p) => `${p} BEM`,
    needsPayer: 'Needs a payer (escrow not deployed); this page calls free methods only.',
    optional: 'optional', noParams: 'This method takes no parameters.',
    jsonEdited: '(edited by hand; this is what will be sent)', badJson: 'params are not a valid JSON object',
    verified: 'Verified: signed by the manifest\'s signing key and bound to this request', errSigned: 'The provider returned a signed error',
    errLocal: 'The call failed',
    'o.latency': 'Latency', 'o.signer': 'Signer', 'o.id': 'Request id', 'o.ts': 'Signed at', 'o.block': 'Envelope block', 'o.pinned': 'blockPinned',
    'o.result': 'Result', 'o.wire': 'Raw envelope (the bytes received)', 'o.request': 'Request',
    'o.data': 'Error data',
    hints: {
      RPC_UNAVAILABLE: 'The public BSC nodes did not answer in time (network or rate limits). Try again shortly.',
      RPC_DISAGREE: 'The nodes gave different answers, so the SDK used none. Try again shortly.',
      MANIFEST_INVALID: 'This container has no valid TapeAPI manifest, or it does not match the chain.',
      DELEGATION_INVALID: 'The manifest\'s delegation was not signed by the current holder, or it expired.',
      NOT_FOUND: 'No such service.',
      PROVIDER_UNAVAILABLE: 'The endpoint returned no signed answer (offline, blocked, or a network problem).',
      BAD_SIGNATURE: 'The answer\'s signature is wrong, so the SDK refused it as a result.',
      RATE_LIMITED: 'The service is rate limiting. Try again shortly.',
      PAYMENT_REQUIRED: 'This method is priced and needs a payer.',
      BAD_REQUEST: 'The parameters were refused: check them above.',
    },
    badTarget: 'Cannot read this: enter 11.1013.tape, a container address, or "processor contract #number".',
    badArea: (a) => `Area code ${a} names no chain: X Layer is 2, Base is 3; a BNB Chain name carries none.`,
    noProcessor: (p) => `Processor ${p} does not exist (factory cpuAt reverted).`,
    sdkComment: (n) => `// ${n}: container, holder, manifest hash, delegation and every answer's signature are checked locally`,
    curlNote: '# note: curl checks neither the signature nor the on-chain identity',
  },
}
const root = document.documentElement
let lang = root.getAttribute('data-lang') === 'en' ? 'en' : 'zh'
const t = (k, ...a) => { const v = T[lang][k] ?? T.en[k] ?? k; return typeof v === 'function' ? v(...a) : v }
const store = (k, v) => { try { localStorage.setItem(k, v) } catch { /* private window / 隐私窗口 */ } }

// ── DOM helpers: text only, never HTML from the network / 只用文本，绝不把网络内容当 HTML ─────────────────────────
const $ = (id) => document.getElementById(id)
function el(tag, attrs, ...kids) {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue
    if (k === 'class') e.className = v
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v)
    else e.setAttribute(k, v === true ? '' : v)
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) e.append(c instanceof Node ? c : String(c))
  return e
}
const code = (s) => el('code', null, s)
const json = (v) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x), 2)
const pre = (text) => el('div', { class: 'code' }, el('pre', null, text))

// ── SDK instance with a traced fetch, so the page can show the exact bytes on the wire ─────────────────────────
// 带追踪的 fetch：页面能展示线上的原始字节，并统计链上读取次数。
let svc = null, located = null, wire = null, rpcReads = 0
async function tracedFetch(url, init) {
  const u = String(url)
  const provider = !!svc && svc.manifest.endpoints.live.some((e) => u.startsWith(`${e}/`))
  if (!provider) rpcReads++
  const res = await fetch(url, init)
  if (provider) {
    const rec = { url: u, request: init?.body ?? null, status: res.status, response: null }
    wire = rec
    rec.done = res.clone().text().then((x) => { rec.response = x }, () => {})
  }
  return res
}
// 4 s per node: a node that drops the connection must not hold every read for the 8 s default. / 每节点 4 秒。
const api = createTapeAPI({ rpcUrls: RPC_URLS, quorum: QUORUM, rpcTimeoutMs: 4000, fetch: tracedFetch })

// ── locate: name, container, or processor contract + number / 定位：名称、容器，或处理器合约加编号 ─────────────
// <#ID>.<processor>.tape on BNB Smart Chain, <#ID>.<area>.<processor>.tape on X Layer (2) and Base (3)
const NAME_RE = /^(\d{1,15})\.(?:(\d{1,7})\.)?(\d{1,15})\.tape$/i
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/
const PAIR_RE = /^(0x[0-9a-fA-F]{40})\s*(?:[#:,/\s]\s*)#?\s*(\d{1,78})$/
async function locate(input) {
  const s = input.trim()
  let m
  if ((m = NAME_RE.exec(s))) {
    const id = BigInt(m[1]), proc = BigInt(m[3])
    if (id < 1n) throw new Error(lang === 'zh' ? '#ID 从 1 开始' : '#ID starts at 1')
    // no area code: BNB Smart Chain; 0 and 1 are reserved; an unassigned code names no chain / 无区号为 BNB；0、1 保留
    const chain = m[2] === undefined ? CHAINS[56] : Number(m[2]) > 1 ? chainByArea(Number(m[2])) : null
    if (!chain) throw new Error(t('badArea', m[2]))
    let raw
    const data = abi.selector('cpuAt(uint256)') + abi.bytesToHex(abi.encodeParams(['uint256'], [proc]))
    try { raw = await api.forChain(chain.chainId).rpc.ethCall(chain.factory, data) }
    catch (e) { if (e instanceof TapeAPIError && e.code === 'RPC_ERROR') throw new TapeAPIError('NOT_FOUND', t('noProcessor', proc)); throw e }
    const circuits = abi.checksumAddress(abi.decodeParams(['address'], raw)[0])
    const name = `${id}.${chain.area === null ? '' : `${chain.area}.`}${proc}.tape`
    return { kind: 'name', name, processor: proc.toString(), chainId: chain.chainId, target: { ...(chain.chainId !== 56 ? { chainId: chain.chainId } : {}), circuits, tokenId: id.toString() } }
  }
  if (ADDR_RE.test(s)) return { kind: 'container', target: abi.checksumAddress(s) }
  if ((m = PAIR_RE.exec(s))) return { kind: 'pair', target: { circuits: abi.checksumAddress(m[1]), tokenId: BigInt(m[2]).toString() } }
  throw new Error(t('badTarget'))
}

// ── rendering / 渲染 ───────────────────────────────────────────────────────────────────────────────────────────
// The status line is kept as a key and arguments, so a language switch re-renders it. / 状态行存为键与参数，切换语言时重绘。
let status = null
function setStatus(key, ...args) { status = key ? [key, args] : null; $('resolve-status').textContent = key ? t(key, ...args) : '' }

// A TapeAPIError shows its code and a plain hint; anything else (our own input checks) shows its message only.
// TapeAPIError 显示错误码与说明；其它错误（本页自己的输入检查）只显示消息。
function errorBox(e) {
  if (!(e instanceof TapeAPIError)) return el('div', { class: 'errbox' }, e?.message || String(e))
  const hint = T[lang].hints[e.code]
  return el('div', { class: 'errbox' }, code(e.code), ' ', e.message, hint ? el('div', { class: 'muted' }, hint) : null)
}

function checkRow(mark, key, value, how) {
  return el('li', null, el('span', { class: mark === '✓' ? 'mk' : 'mk info', 'aria-hidden': 'true' }, mark),
    el('span', { class: 'k' }, key), el('span', { class: 'v' }, value, how ? el('span', { class: 'how' }, how) : null))
}

function renderChecks() {
  const box = $('checks')
  if (!svc) { box.hidden = true; return }
  const m = svc.manifest
  // the delegation domain of the service's own chain: (chainId, that chain's DeWebHub) / 服务所在链的委托域
  const chainId = svc.chainId ?? 56
  const digest = sig.delegationDigest(chainId, CHAINS[chainId].delegation.verifyingContract, { container: m.container, signer: m.signer, expires: m.delegation.expires })
  const signedBy = abi.checksumAddress(sig.recoverAddress(digest, m.delegation.sig))
  const days = Math.floor((m.delegation.expires * 1000 - Date.now()) / 86400000)
  const locale = lang === 'zh' ? 'zh-CN' : 'en'
  const rows = []
  rows.push(checkRow('•', t('c.chain'), `${CHAINS[chainId].name} (chainId ${chainId})`, t('c.chain.how')))
  if (located?.kind === 'name') rows.push(checkRow('✓', t('c.name'), code(located.name), t('c.name.how', located.processor)))
  rows.push(checkRow('✓', t('c.cpu'), el('span', null, code(abi.checksumAddress(m.circuits)), ` #${m.tokenId}`), t('c.cpu.how')))
  rows.push(checkRow('✓', t('c.container'), code(svc.container), t('c.container.how')))
  rows.push(checkRow('✓', t('c.holder'), code(svc.verified.holder), t('c.holder.how', QUORUM, operatorsOn(chainId))))
  if (svc.file) rows.push(checkRow('✓', t('c.manifest'), el('span', null, t('bytes', svc.file.size), ', sha256 ', code(svc.file.sha256Hash)), t('c.manifest.how')))
  rows.push(checkRow('✓', t('c.delegation'), code(signedBy), t('c.delegation.how')))
  rows.push(checkRow('•', t('c.expires'), new Date(m.delegation.expires * 1000).toLocaleString(locale) + t('days', days)))
  rows.push(checkRow('•', t('c.endpoint'), m.endpoints.live.map((u, i) => [i ? ', ' : '', code(u)])))
  rows.push(checkRow('•', t('c.signer'), code(abi.checksumAddress(m.signer)), t('c.signer.how')))
  box.replaceChildren(el('ul', { class: 'checks' }, rows))
  box.hidden = false
  $('manifest-json').textContent = json(m)
  $('manifest-box').hidden = false
}

// The SDK's own reading of the price (its call() asks for a payer exactly when this is not 0). / 与 SDK 对价格的判断一致。
const isFree = (d) => { try { return parseUnits(d.priceBEM) === 0n } catch { return false } }
let selected = null
function renderMethods() {
  if (!svc) { $('s-methods').hidden = true; return }
  const list = svc.manifest.methods.map((d) => el('button', {
    type: 'button', class: 'method', 'aria-pressed': String(d.name === selected),
    onclick: () => select(d.name),
  },
  el('span', { class: 'mn' }, code(d.name), el('span', { class: isFree(d) ? 'price' : 'price paid' }, isFree(d) ? t('free') : t('priced', d.priceBEM))),
  d.description ? el('span', { class: 'md' }, d.description) : null))
  $('methods').replaceChildren(...list)
  $('s-methods').hidden = false
}

// Params notation, e.g. 'address', 'number?', "number|'finalized'|'latest'? (default finalized)", "string? (hint)".
// 参数写法：去掉末尾括号里的提示，末尾 ? 表示可选，按 | 拆分，引号里的是字面值。
function parseNotation(raw) {
  if (typeof raw !== 'string') return { raw, optional: true, types: ['json'], literals: [], hint: '' }
  let s = raw.trim(), hint = ''
  const h = /\s*\(([^()]*)\)\s*$/.exec(s)
  if (h) { hint = h[1]; s = s.slice(0, h.index).trim() }
  let optional = false
  if (s.endsWith('?')) { optional = true; s = s.slice(0, -1).trim() }
  const types = [], literals = []
  for (const p of s.split('|').map((x) => x.trim()).filter(Boolean)) {
    const q = /^'(.*)'$|^"(.*)"$/.exec(p)
    if (q) literals.push(q[1] ?? q[2]); else types.push(p.toLowerCase())
  }
  return { raw, optional, types, literals, hint }
}
function convert(spec, text) {
  const v = String(text).trim()
  if (v === '') return undefined
  if (spec.literals.includes(v)) return v
  if (spec.types.includes('number') && /^\d{1,15}$/.test(v)) return Number(v)
  if (spec.types.includes('boolean') && (v === 'true' || v === 'false')) return v === 'true'
  if (spec.types.some((x) => x === 'json' || x === 'object' || x === 'array' || x.endsWith('[]'))) { try { return JSON.parse(v) } catch { return v } }
  return v
}

let specs = {}, jsonEdited = false
function currentDef() { return svc?.manifest.methods.find((d) => d.name === selected) || null }
function paramsFromForm() {
  const out = {}
  for (const [k, spec] of Object.entries(specs)) {
    const input = $(`f-${k}`)
    const v = convert(spec, input.value)
    if (v !== undefined) out[k] = v
  }
  return out
}
function syncJson() {
  jsonEdited = false
  $('params-json').value = json(paramsFromForm())
  $('params-json').removeAttribute('aria-invalid')
  $('json-note').textContent = ''
  renderSnippets()
}
function paramsNow() {
  if (!jsonEdited) return paramsFromForm()
  const v = JSON.parse($('params-json').value || '{}')
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(t('badJson'))
  return v
}

function select(name, { keepOutcome = false } = {}) {
  selected = name
  const def = currentDef()
  if (!def) return
  for (const b of $('methods').children) b.setAttribute('aria-pressed', String(b.querySelector('code').textContent === name))
  $('call-name').textContent = def.name
  $('call-desc').textContent = def.description || ''
  const example = PUBLIC_EXAMPLES[def.name] || {}
  specs = {}
  const fields = []
  for (const [k, notation] of Object.entries(def.params || {})) {
    const spec = parseNotation(notation)
    specs[k] = spec
    const listId = spec.literals.length ? `dl-${k}` : null
    const input = el('input', {
      id: `f-${k}`, class: 'mono', spellcheck: 'false', autocapitalize: 'off', list: listId,
      placeholder: spec.hint || (typeof notation === 'string' ? notation : ''),
      oninput: () => { input.setAttribute('aria-invalid', String(spec.types.includes('address') && input.value.trim() !== '' && !ADDR_RE.test(input.value.trim()))); syncJson() },
    })
    const ex = example[k]
    if (ex !== undefined) input.value = String(ex)
    fields.push(el('div', { class: 'field' },
      el('label', { class: 'lbl', for: `f-${k}` }, code(k), ' ', el('code', null, typeof notation === 'string' ? notation : json(notation)),
        spec.optional ? el('span', { class: 'opt' }, ` · ${t('optional')}`) : null),
      input,
      listId ? el('datalist', { id: listId }, spec.literals.map((l) => el('option', { value: l }))) : null))
  }
  $('fields').replaceChildren(...(fields.length ? fields : [el('p', { class: 'nofields' }, t('noParams'))]))
  const free = isFree(def)
  $('call-btn').disabled = !free
  $('call-note').textContent = free ? '' : t('needsPayer')
  if (!keepOutcome) $('outcome').hidden = true
  $('s-call').hidden = false
  $('s-code').hidden = false
  syncJson()
  saveUrl()
}

// ── snippets / 代码片段 ────────────────────────────────────────────────────────────────────────────────────────
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
function renderSnippets() {
  const def = currentDef()
  if (!svc || !def) return
  let params
  try { params = paramsNow() } catch { params = {} }
  const chainId = svc.chainId ?? 56
  const target = located?.kind === 'container' || !located
    ? (chainId === 56 ? `'${svc.container}'` : `{ chainId: ${chainId}, container: '${svc.container}' }`)
    : `{ ${chainId === 56 ? '' : `chainId: ${chainId}, `}circuits: '${abi.checksumAddress(svc.manifest.circuits)}', tokenId: '${svc.manifest.tokenId}' }`
  const label = located?.kind === 'name' ? located.name : svc.manifest.name || svc.container
  const p = JSON.stringify(params)
  $('code-sdk').textContent = [
    "import { createTapeAPI, rpcUrlsFor } from '@tapeapi/sdk'",
    '',
    'const api = createTapeAPI({',
    '  rpcUrls: rpcUrlsFor(56),   // ' + RPC_URLS.map((u) => new URL(u).host).join(', '),
    `  quorum: ${QUORUM},`,
    ...(chainId === 56 ? [] : [`  // ${CHAINS[chainId].name}: rpcUrlsFor(${chainId}) unless you pass chains: { ${chainId}: { rpcUrls } }`]),
    '})',
    t('sdkComment', label),
    `const svc = await api.resolve(${target})`,
    `const r = await api.call(svc, '${def.name}', ${p === '{}' ? '{}' : p})`,
    'console.log(r.result, r.verified)',
  ].join('\n')
  const body = JSON.stringify({ id: 'playground-1', method: def.name, params })
  $('code-curl').textContent = [
    t('curlNote'),
    `curl -s ${svc.manifest.endpoints.live[0] || '<endpoint>'}/${def.name} \\`,
    "  -H 'content-type: application/json' \\",
    `  -d ${shq(body)}`,
  ].join('\n')
}

// ── actions / 操作 ─────────────────────────────────────────────────────────────────────────────────────────────
let busy = false
async function doResolve(ev) {
  ev?.preventDefault()
  if (busy) return
  busy = true
  $('resolve-btn').disabled = true
  svc = null; located = null; selected = null; rpcReads = 0
  for (const id of ['s-methods', 's-call', 's-code', 'checks', 'manifest-box']) $(id).hidden = true
  setStatus('resolving')
  const t0 = performance.now()
  try {
    located = await locate($('target').value)
    const s = await api.resolve(located.target)
    svc = s
    setStatus('resolved', Math.round(performance.now() - t0), rpcReads)
    renderChecks()
    renderMethods()
    const want = new URLSearchParams(location.search).get('method')
    const first = s.manifest.methods.find((d) => d.name === want) || s.manifest.methods.find(isFree) || s.manifest.methods[0]
    if (first) select(first.name)
    saveUrl()
  } catch (e) {
    svc = null
    setStatus(null)
    $('checks').replaceChildren(errorBox(e)); $('checks').hidden = false
  } finally {
    busy = false
    $('resolve-btn').disabled = false
  }
}

async function doCall(ev) {
  ev?.preventDefault()
  const def = currentDef()
  if (!svc || !def || !isFree(def)) return
  const out = $('outcome')
  let params
  try { params = paramsNow() } catch (e) {
    $('params-json').setAttribute('aria-invalid', 'true')
    out.replaceChildren(el('div', { class: 'outcome' }, errorBox(e))); out.hidden = false
    return
  }
  $('call-btn').disabled = true
  $('call-note').textContent = t('calling')
  wire = null
  const t0 = performance.now()
  let r = null, err = null
  try { r = await api.call(svc, def.name, params) } catch (e) { err = e }
  const ms = Math.round(performance.now() - t0)
  if (wire?.done) await wire.done   // the traced copy of the body / 追踪的响应副本
  $('call-btn').disabled = false
  $('call-note').textContent = ''
  const blocks = []
  if (r) {
    const recovered = abi.checksumAddress(sig.recoverResponseSigner({ container: svc.container, id: r.id, method: def.name, params, ok: true, body: r.result, ts: r.ts }, r.sig))
    blocks.push(el('p', { class: 'verdict ok' }, `✓ ${t('verified')}`))
    const kv = [
      [t('o.latency'), `${ms} ms`],
      [t('o.signer'), code(recovered)],
      [t('o.id'), code(r.id)],
      [t('o.ts'), `${new Date(r.ts * 1000).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en')} (${r.ts})`],
      [t('o.block'), r.block == null ? '—' : code(String(r.block))],
    ]
    if (r.result && typeof r.result === 'object' && r.result.blockPinned) kv.push([t('o.pinned'), code(JSON.stringify(r.result.blockPinned))])
    blocks.push(el('dl', { class: 'kv' }, kv.map(([k, v]) => [el('dt', null, k), el('dd', null, v)])))
    blocks.push(el('p', { class: 'lbl' }, t('o.result')), pre(json(r.result)))
  } else {
    blocks.push(el('p', { class: 'verdict bad' }, `✕ ${err instanceof TapeAPIError && err.signed ? t('errSigned') : t('errLocal')}`))
    blocks.push(errorBox(err))
    blocks.push(el('dl', { class: 'kv' }, el('dt', null, t('o.latency')), el('dd', null, `${ms} ms`)))
    if (err?.data) blocks.push(el('p', { class: 'lbl' }, t('o.data')), pre(json(err.data)))
  }
  if (wire) {
    let body = wire.response ?? ''
    try { body = json(JSON.parse(body)) } catch { /* not JSON: show as received / 不是 JSON：原样显示 */ }
    blocks.push(el('p', { class: 'lbl' }, `${t('o.wire')} · HTTP ${wire.status}`), pre(body))
    blocks.push(el('p', { class: 'lbl' }, `${t('o.request')} · POST ${wire.url}`), pre(wire.request ?? ''))
  }
  out.replaceChildren(el('div', { class: 'outcome' }, blocks))
  out.hidden = false
}

function saveUrl() {
  try {
    const q = new URLSearchParams()
    q.set('q', $('target').value.trim())
    if (selected) q.set('method', selected)
    history.replaceState(null, '', `${location.pathname}?${q}`)
  } catch { /* file: or sandboxed / 忽略 */ }
}

// ── language and theme / 语言与主题 ─────────────────────────────────────────────────────────────────────────────
function applyLang() {
  root.setAttribute('data-lang', lang)
  root.setAttribute('lang', lang === 'zh' ? 'zh-CN' : 'en')
  for (const n of document.querySelectorAll('[data-i18n]')) n.innerHTML = t(n.getAttribute('data-i18n'))   // our own strings only / 只有本文件的字符串
  $('lang-btn').textContent = t('other')
  $('lang-btn').setAttribute('lang', lang === 'zh' ? 'en' : 'zh-CN')
  $('docs-link').href = `../docs/${lang}/consume`
  document.title = lang === 'zh' ? 'TapeAPI 调试台' : 'TapeAPI Playground'
  themeLabel()
  if (status) setStatus(status[0], ...status[1])
  if (svc) { renderChecks(); renderMethods(); if (selected) { const keep = paramsSnapshot(); select(selected, { keepOutcome: true }); restore(keep) } }
}
function paramsSnapshot() { return { values: Object.keys(specs).map((k) => [k, $(`f-${k}`).value]), json: $('params-json').value, edited: jsonEdited } }
function restore(s) {
  for (const [k, v] of s.values) if ($(`f-${k}`)) $(`f-${k}`).value = v
  syncJson()
  if (s.edited) { $('params-json').value = s.json; jsonEdited = true; $('json-note').textContent = t('jsonEdited'); renderSnippets() }
}
function themeLabel() {
  const cur = root.getAttribute('data-theme')
  $('theme-btn').textContent = cur === 'dark' ? t('light') : cur === 'light' ? t('dark') : t('theme')
}

$('lang-btn').addEventListener('click', () => { lang = lang === 'zh' ? 'en' : 'zh'; store('tapeapi.lang', lang); applyLang() })
$('theme-btn').addEventListener('click', () => {
  const cur = root.getAttribute('data-theme')
  const dark = cur ? cur === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches
  const next = dark ? 'light' : 'dark'
  root.setAttribute('data-theme', next); store('tapeapi.theme', next); themeLabel()
})
$('resolve-form').addEventListener('submit', doResolve)
$('call-form').addEventListener('submit', doCall)
$('params-json').addEventListener('input', () => {
  jsonEdited = true
  $('json-note').textContent = t('jsonEdited')
  let ok = true
  try { const v = JSON.parse($('params-json').value || '{}'); ok = !!v && typeof v === 'object' && !Array.isArray(v) } catch { ok = false }
  $('params-json').setAttribute('aria-invalid', String(!ok))
  if (ok) renderSnippets()
})
for (const b of document.querySelectorAll('[data-copy]')) {
  b.addEventListener('click', () => {
    const text = $(b.getAttribute('data-copy')).textContent
    navigator.clipboard?.writeText(text).then(() => { b.textContent = t('copied'); setTimeout(() => { b.textContent = t('copy') }, 1500) }, () => {})
  })
}

applyLang()
const q = new URLSearchParams(location.search).get('q')
if (q) { $('target').value = q.slice(0, 200); doResolve() }
