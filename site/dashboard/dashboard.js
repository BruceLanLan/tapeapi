// "My services" dashboard: a read-only view of the TapeAPI services someone runs. Each entry is resolved with the
// real SDK (the playground's vendored copy), then its health endpoint is asked directly from the browser.
// Read-only by construction: the only wallet request on this page is eth_requestAccounts, to learn an address.
// Everything a manifest, a node or a provider says is untrusted text: it reaches the page through textContent only.
// “我的服务”面板：只读查看自己运行的 TapeAPI 服务。每一项用真实 SDK（调试台 vendor/ 里的同一份）解析，再从浏览器
// 直接请求它的健康检查。本页只向钱包发 eth_requestAccounts 取地址。清单、节点、提供者给出的一切只经 textContent 进入页面。
import { createTapeAPI, TapeAPIError, abi, rpcUrlsFor, CHAINS } from '../playground/vendor/e82062b118/tapeapi-sdk/index.js'
import { parseInput, classifyExpiry, healthUrl, sameAddress, loadList, saveList, addTo, removeFrom, PUBLIC_EXAMPLES, STORAGE_KEY, HEALTH_PATH } from './lib.js?v=498d93e631'

// The SDK's default nodes: three distinct operators (NodeReal, Alchemy, 48 Club); the SDK counts agreement by operator.
// SDK 的默认节点：三家不同运营方；SDK 按运营方计票。
const RPC_URLS = rpcUrlsFor(56)
const QUORUM = 2
const HEALTH_TIMEOUT_MS = 8000
const PARALLEL = 2   // resolves at once: quorum reads on three public nodes rate-limit quickly / 同时解析数：公共节点容易限流

// ── language / 语言 ──────────────────────────────────────────────────────────────────────────────────────────────
const T = {
  zh: {
    section: '我的服务', docs: '手册', theme: '主题', light: '浅色', dark: '深色', other: 'English',
    title: '我的服务',
    lede: '把你运行的 TapeAPI 服务放在一处查看：谁持有它、端点是否在线、委托还有几天到期。每一项都由 @tapeapi/sdk 在本页读链核对；本页只读，不会请钱包签名或发送任何东西。',
    'h.wallet': '钱包（可选）', connect: '连接钱包', reconnect: '重新连接',
    'wallet.hint': '只调用 <code>eth_requestAccounts</code> 取得你的地址，用来标出“你持有这个服务”。不签名、不发交易、不切换网络。不连接钱包也可以直接添加服务。',
    noWallet: '没有检测到钱包。不连接也能用：直接在下面添加服务。',
    connecting: '正在请钱包给出地址……',
    connected: (a) => `已连接：${a}（只读）`,
    walletRefused: (m) => `钱包没有给出地址：${m}`,
    'h.services': '服务', refresh: '刷新全部',
    'add.label': 'TapeOut 名称或容器地址', add: '添加',
    'add.hint': '填 TapeOut 名称 <code>11.1013.tape</code>（#ID.处理器编号.tape；X Layer 与 Base 上的名字带区号，如 <code>1.2.344.tape</code>）或 BNB Chain 上的容器地址 <code>0x…</code>。列表只存在这台设备的浏览器里。',
    empty: '还没有服务。先添加两个公共示例看看效果：公共 API（11.1013.tape）与公共中继（12.1013.tape）。',
    examples: '添加公共示例',
    'add.bad': '看不懂这个输入：请填 11.1013.tape 这样的名称，或 0x 开头的 40 位十六进制容器地址。',
    'add.dup': (k) => `${k} 已经在列表里。`,
    'add.full': '列表已满（最多 50 项）。',
    'add.ok': (k) => `已添加 ${k}。`,
    'add.nostore': '浏览器不允许保存（可能是隐私窗口）：列表只在本次打开期间有效。',
    'h.discover': '找到你持有的名称',
    'discover.why': '本页还不能自动列出你持有的电路：链上没有“某地址持有哪些电路”的公共索引，逐个处理器、逐个编号去问节点既慢又会被限流。所以请粘贴一个你持有的 TapeOut 名称，本页核对它的持有人，再决定是否加入列表。',
    'discover.label': '你持有的 TapeOut 名称', check: '核对',
    'discover.bad': '请填 TapeOut 名称，例如 11.1013.tape。',
    'discover.checking': '正在读链：处理器合约、持有人、容器……',
    'discover.yours': '✓ 你连接的钱包持有这个名称',
    'discover.notyours': '✕ 持有人不是你连接的钱包',
    'discover.nowallet': '• 连接钱包后才能和你的地址比较（见第 1 步）',
    'discover.add': '加入我的服务', 'discover.added': '已在列表里',
    'discover.nocircuit': (id, p) => `处理器 ${p} 上没有电路 #${id}（ownerOf 回滚）。`,
    'discover.note': '加入后，卡片会告诉你这个容器有没有发布 TapeAPI 清单；没有清单的名称会显示 MANIFEST_INVALID。',
    foot: '只读：本页不请钱包签名或发送任何东西，也不需要任何密钥。链上读取经 3 家不同运营方的公共 BSC 节点、至少 2 家一致（quorum 2）；健康检查直接从你的浏览器请求服务端点。',
    'k.name': '名称', 'k.chain': '链', 'k.container': '容器', 'k.holder': '当前持有人', 'k.endpoint': '端点', 'k.methods': '方法数',
    'k.signer': '服务签名密钥', 'k.expires': '委托到期', 'k.health': '在线检查', 'k.circuits': '处理器合约',
    you: '你持有这个', resolving: '正在读链：定位容器、读取清单、核对委托……', retrying: '节点没有及时回应，正在重试……',
    days: (d) => d >= 0 ? `（还有 ${d} 天）` : '（已过期）',
    'b.checking': '检查中', 'b.ok': '正常', 'b.warn': '注意', 'b.bad': '有问题',
    'h.ok': (ms) => `✓ 在线 · ${ms} ms`, 'h.down': (why) => `✕ ${why}`, 'h.checking': '检查中……', 'h.none': '清单里没有可检查的 https 端点',
    'h.timeout': (s) => `${s} 秒内没有回应`, 'h.unreach': '连不上（离线、被拦截或网络问题）', 'h.notok': (ms) => `服务报告 ok 不为 true · ${ms} ms（委托可能已过期）`,
    'h.notjson': '回应不是 JSON',
    'h.signer': '健康检查报告的签名密钥与清单不一致：客户端会拒绝它的回答。',
    'h.expired': '健康检查报告委托已过期：客户端会拒绝它的每一个回答，直到持有人重新签署。',
    warnSoon: (d) => `委托还有 ${d} 天到期：到期后客户端会拒绝这个服务的每一个回答。请在操作台重新签署。`,
    playground: '在调试台打开', renew: '到操作台续期', retry: '重试', remove: '移除',
    hints: {
      RPC_UNAVAILABLE: '公共 BSC 节点没有及时回应（网络或节点限流）。稍后点“重试”。',
      RPC_DISAGREE: '节点之间答案不一致，SDK 拒绝采用。稍后点“重试”。',
      MANIFEST_INVALID: '这个容器没有有效的 TapeAPI 清单，或清单与链上记录不符。',
      DELEGATION_INVALID: '清单的委托不是当前持有人签的，或已过期。持有人可以在操作台重新签署。',
      NOT_FOUND: '没有找到这个服务（处理器编号不存在，或没有发布清单）。',
    },
  },
  en: {
    section: 'My services', docs: 'Docs', theme: 'Theme', light: 'Light', dark: 'Dark', other: '中文',
    title: 'My services',
    lede: 'The TapeAPI services you run, in one place: who holds each one, whether its endpoint is up, and how many days its delegation has left. Every check is made on this page by @tapeapi/sdk; the page is read-only and never asks a wallet to sign or send anything.',
    'h.wallet': 'Wallet (optional)', connect: 'Connect wallet', reconnect: 'Connect again',
    'wallet.hint': 'Only <code>eth_requestAccounts</code> is called, to learn your address and mark the services you hold. Nothing is signed, nothing is sent, the network is not switched. You can add services without a wallet.',
    noWallet: 'No wallet found. The page works without one: add services below.',
    connecting: 'Asking the wallet for its address…',
    connected: (a) => `Connected: ${a} (read-only)`,
    walletRefused: (m) => `The wallet gave no address: ${m}`,
    'h.services': 'Services', refresh: 'Refresh all',
    'add.label': 'TapeOut name or container address', add: 'Add',
    'add.hint': 'A TapeOut name such as <code>11.1013.tape</code> (#ID.processor.tape; names on X Layer and Base carry their area code, e.g. <code>1.2.344.tape</code>) or a container address on BNB Chain <code>0x…</code>. The list is kept in this browser on this device only.',
    empty: 'No services yet. Start with the two public examples: the public API (11.1013.tape) and the public relay (12.1013.tape).',
    examples: 'Add the public examples',
    'add.bad': 'Cannot read this: enter a name such as 11.1013.tape, or a container address (0x and 40 hex digits).',
    'add.dup': (k) => `${k} is already in the list.`,
    'add.full': 'The list is full (50 entries at most).',
    'add.ok': (k) => `Added ${k}.`,
    'add.nostore': 'This browser will not save (a private window?): the list lasts only while the page is open.',
    'h.discover': 'Find a name you hold',
    'discover.why': 'This page cannot list your circuits by itself yet: there is no public index of which circuits an address holds, and asking the nodes processor by processor, number by number, is slow and gets rate-limited. So paste a TapeOut name you hold; the page checks its holder, and you decide whether to add it.',
    'discover.label': 'A TapeOut name you hold', check: 'Check',
    'discover.bad': 'Enter a TapeOut name, for example 11.1013.tape.',
    'discover.checking': 'Reading the chain: processor contract, holder, container…',
    'discover.yours': '✓ Your connected wallet holds this name',
    'discover.notyours': '✕ The holder is not your connected wallet',
    'discover.nowallet': '• Connect a wallet (step 1) to compare with your address',
    'discover.add': 'Add to my services', 'discover.added': 'Already in the list',
    'discover.nocircuit': (id, p) => `Processor ${p} has no circuit #${id} (ownerOf reverted).`,
    'discover.note': 'Once added, the card says whether this container publishes a TapeAPI manifest; a name without one shows MANIFEST_INVALID.',
    foot: 'Read-only: this page never asks a wallet to sign or send anything, and needs no key. Chain reads go to public BSC nodes of 3 different operators, at least 2 of which must agree (quorum 2); health checks go from your browser straight to each endpoint.',
    'k.name': 'Name', 'k.chain': 'Chain', 'k.container': 'Container', 'k.holder': 'Current holder', 'k.endpoint': 'Endpoint', 'k.methods': 'Methods',
    'k.signer': 'Service signing key', 'k.expires': 'Delegation expires', 'k.health': 'Health', 'k.circuits': 'Processor contract',
    you: 'you hold this', resolving: 'Reading the chain: locating the container, reading the manifest, checking the delegation…', retrying: 'The nodes did not answer in time; trying again…',
    days: (d) => d >= 0 ? ` (in ${d} days)` : ' (expired)',
    'b.checking': 'Checking', 'b.ok': 'OK', 'b.warn': 'Attention', 'b.bad': 'Problem',
    'h.ok': (ms) => `✓ up · ${ms} ms`, 'h.down': (why) => `✕ ${why}`, 'h.checking': 'checking…', 'h.none': 'the manifest has no https endpoint to check',
    'h.timeout': (s) => `no answer within ${s} s`, 'h.unreach': 'unreachable (offline, blocked, or a network problem)', 'h.notok': (ms) => `the service does not report ok: true · ${ms} ms (the delegation may have lapsed)`,
    'h.notjson': 'the answer is not JSON',
    'h.signer': 'The health check reports a signing key that differs from the manifest: clients will refuse its answers.',
    'h.expired': 'The health check reports the delegation has expired: clients reject every answer until the holder re-signs it.',
    warnSoon: (d) => `The delegation expires in ${d} days; after that, clients reject every answer from this service. Re-sign it in the console.`,
    playground: 'Open in playground', renew: 'Renew in console', retry: 'Retry', remove: 'Remove',
    hints: {
      RPC_UNAVAILABLE: 'The public BSC nodes did not answer in time (network or rate limits). Press Retry shortly.',
      RPC_DISAGREE: 'The nodes gave different answers, so the SDK used none. Press Retry shortly.',
      MANIFEST_INVALID: 'This container has no valid TapeAPI manifest, or it does not match the chain.',
      DELEGATION_INVALID: 'The manifest\'s delegation was not signed by the current holder, or it expired. The holder can re-sign it in the console.',
      NOT_FOUND: 'No such service (the processor number does not exist, or nothing is published).',
    },
  },
}
const root = document.documentElement
let lang = root.getAttribute('data-lang') === 'en' ? 'en' : 'zh'
const t = (k, ...a) => { const v = T[lang][k] ?? T.en[k] ?? k; return typeof v === 'function' ? v(...a) : v }
const put = (k, v) => { try { localStorage.setItem(k, v) } catch { /* private window / 隐私窗口 */ } }
const locale = () => (lang === 'zh' ? 'zh-CN' : 'en')

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
const cs = (a) => { try { return abi.checksumAddress(a) } catch { return String(a) } }
function errorBox(e) {
  if (!(e instanceof TapeAPIError)) return el('div', { class: 'errbox' }, e?.message || String(e))
  const hint = T[lang].hints[e.code]
  return el('div', { class: 'errbox' }, code(e.code), ' ', e.message, hint ? el('div', { class: 'muted' }, hint) : null)
}
const kv = (rows) => el('dl', { class: 'kv' }, rows.filter(Boolean).map(([k, v, cls]) => [el('dt', null, k), el('dd', cls ? { class: cls } : null, v)]))

// ── state / 状态 ───────────────────────────────────────────────────────────────────────────────────────────────
// Storage is looked up on each access: reading window.localStorage itself throws when site data is blocked.
// 每次访问才取 localStorage：站点数据被阻止时，连读取 window.localStorage 本身都会抛错。
const storage = { getItem: (k) => localStorage.getItem(k), setItem: (k, v) => localStorage.setItem(k, v) }
let list = loadList(storage)
const results = new Map()   // key -> { gen, phase: 'loading'|'retrying'|'done', info?, error?, health? }
let account = null
let walletMsg = null        // [key, args, cls] so a language switch re-renders it / 存为键与参数，切换语言时重绘
let addMsg = null
let discover = null         // { phase, key, info?, error? }

function persist(next) {
  list = next
  const saved = saveList(storage, list)
  if (!saved) setAddMsg('add.nostore', [], 'warn')
}

// 4 s per node, as in the playground: a node that drops the connection must not hold every read. / 每节点 4 秒。
// A name with an area code (1.2.344.tape on X Layer, 1.3.5.tape on Base) is resolved on its chain, through the SDK's
// default nodes for that chain with the same operator quorum. / 带区号的名字在它的链上解析，用 SDK 对该链的默认节点，法定数相同。
const api = createTapeAPI({ rpcUrls: RPC_URLS, quorum: QUORUM, rpcTimeoutMs: 4000 })
const chainName = (id) => CHAINS[id]?.name ?? `chain ${id}`

// ── resolving, a few at a time / 解析，限制并发 ──────────────────────────────────────────────────────────────────
let gen = 0
const queue = []
let running = 0
function schedule(key) {
  const g = ++gen
  results.set(key, { gen: g, phase: 'loading' })
  queue.push([key, g])
  renderCard(key)
  pump()
}
function pump() {
  while (running < PARALLEL && queue.length) {
    const [key, g] = queue.shift()
    if (results.get(key)?.gen !== g) continue   // removed or re-scheduled meanwhile / 期间被移除或重排
    running++
    check(key, g).finally(() => { running--; pump() })
  }
}
const current = (key, g) => results.get(key)?.gen === g
const transient = (e) => e instanceof TapeAPIError && (e.code === 'RPC_UNAVAILABLE' || e.code === 'RPC_DISAGREE')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function check(key, g) {
  let svc = null, error = null
  for (let attempt = 0; attempt < 2; attempt++) {
    try { svc = await api.resolve(key); error = null; break } catch (e) {
      error = e
      if (!transient(e) || attempt === 1 || !current(key, g)) break
      results.set(key, { gen: g, phase: 'retrying' }); renderCard(key)
      await sleep(1500)
    }
  }
  if (!current(key, g)) return
  if (!svc) { results.set(key, { gen: g, phase: 'done', error }); renderCard(key); return }
  const m = svc.manifest
  const info = {
    chainId: svc.chainId ?? 56,
    container: svc.container,
    holder: svc.verified.holder,
    circuits: cs(m.circuits), tokenId: String(m.tokenId),
    endpoint: m.endpoints.live[0] ?? null,
    methods: m.methods.length,
    signer: cs(m.signer),
    expires: m.delegation?.expires ?? null,
  }
  const url = healthUrl(info.endpoint)
  results.set(key, { gen: g, phase: 'done', info, health: url ? { phase: 'checking', url } : { phase: 'none' } })
  renderCard(key)
  if (!url) return
  const health = await checkHealth(url)
  if (!current(key, g)) return
  results.get(key).health = { ...health, url }
  renderCard(key)
}

// GET {origin}/tapeapi/v1/health. Providers send access-control-allow-origin: *, as on the status page.
// 请求健康检查；提供者返回 access-control-allow-origin: *，与状态页相同。
async function checkHealth(url) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), HEALTH_TIMEOUT_MS)
  const t0 = performance.now()
  try {
    const res = await fetch(url, { cache: 'no-store', signal: ctl.signal, headers: { accept: 'application/json' }, credentials: 'omit', referrerPolicy: 'no-referrer' })
    const ms = Math.round(performance.now() - t0)
    if (!res.ok) return { phase: 'done', up: false, ms, why: `HTTP ${res.status} · ${ms} ms` }
    let j
    try { j = await res.json() } catch { return { phase: 'done', up: false, ms, whyKey: 'h.notjson' } }
    return {
      phase: 'done', up: j?.ok === true, ms, whyKey: j?.ok === true ? null : 'h.notok',
      signer: typeof j?.signer === 'string' && /^0x[0-9a-fA-F]{40}$/.test(j.signer) ? j.signer : null,
      expires: Number.isFinite(j?.delegationExpires) ? j.delegationExpires : null,
    }
  } catch (e) {
    return { phase: 'done', up: false, whyKey: e?.name === 'AbortError' ? 'h.timeout' : 'h.unreach' }
  } finally { clearTimeout(timer) }
}

// ── rendering / 渲染 ───────────────────────────────────────────────────────────────────────────────────────────
function stateOf(r) {
  if (!r || r.phase !== 'done') return 'checking'
  if (r.error) return 'bad'
  const h = r.health
  const exp = classifyExpiry(h?.expires ?? r.info.expires)
  if (exp.state === 'expired') return 'bad'
  if (h?.phase === 'done' && !h.up) return 'bad'
  if (h?.phase === 'done' && h.signer && !sameAddress(h.signer, r.info.signer)) return 'bad'
  if (exp.state === 'warn' || exp.state === 'unknown' || h?.phase === 'none') return 'warn'
  if (h?.phase === 'checking') return 'checking'
  return 'ok'
}

// The console link for renewing this service: it prefills step 2 (processor and circuit numbers) and the service URL
// of step 4; the console checks every value again and never reads or signs by itself. A container entry has no
// processor number, so only what is known is passed. / 续期用的操作台链接：预填第 2 步（处理器与电路编号）和第 4 步的
// 服务网址；操作台会重新检查每个值，也从不自行读取或签名。按容器添加的条目不知道处理器编号，只传已知的部分。
function consoleLink(key, info) {
  const q = new URLSearchParams()
  const p = parseInput(key)
  if (p?.kind === 'name') { q.set('processor', p.processor); q.set('circuit', p.id); if (p.chainId) q.set('chain', String(p.chainId)) }
  else if (info?.tokenId && /^\d+$/.test(info.tokenId)) q.set('circuit', info.tokenId)
  const health = healthUrl(info?.endpoint)
  if (health) q.set('url', health.slice(0, -HEALTH_PATH.length))
  const qs = q.toString()
  return qs ? `../console/?${qs}` : '../console/'
}

function cardFor(key) {
  const r = results.get(key)
  const st = stateOf(r)
  const info = r?.info
  const holds = !!(info && account && sameAddress(info.holder, account))
  const head = el('div', { class: 'card-head' },
    el('h3', null, key.startsWith('0x') ? cs(key) : key),
    holds ? el('span', { class: 'you' }, `● ${t('you')}`) : null,
    el('span', { class: 'sp' }),
    el('span', { class: 'badge', 'data-state': st }, t(`b.${st}`)))
  const kids = [head]
  if (!r || r.phase !== 'done') {
    kids.push(el('p', { class: 'loading' }, t(r?.phase === 'retrying' ? 'retrying' : 'resolving')))
  } else if (r.error) {
    kids.push(errorBox(r.error))
  } else {
    const h = r.health
    const exp = classifyExpiry(info.expires)
    const expRow = info.expires == null ? '—'
      : `${new Date(info.expires * 1000).toISOString().slice(0, 10)}${t('days', exp.days)}`
    let healthRow, healthCls = null
    if (h.phase === 'none') { healthRow = t('h.none'); healthCls = 'warn' }
    else if (h.phase === 'checking') healthRow = t('h.checking')
    else if (h.up) { healthRow = t('h.ok', h.ms); healthCls = 'ok' }
    else { healthRow = t('h.down', h.why ?? t(h.whyKey, h.whyKey === 'h.timeout' ? HEALTH_TIMEOUT_MS / 1000 : h.ms)); healthCls = 'bad' }
    kids.push(kv([
      ...(info.chainId !== 56 ? [[t('k.chain'), chainName(info.chainId)]] : []),
      [t('k.container'), code(info.container)],
      [t('k.holder'), [code(info.holder), holds ? el('span', { class: 'you' }, ` · ${t('you')}`) : null]],
      [t('k.endpoint'), info.endpoint ? (h.url ? el('a', { href: h.url, target: '_blank', rel: 'noopener noreferrer' }, code(info.endpoint)) : code(info.endpoint)) : '—'],
      [t('k.methods'), String(info.methods)],
      [t('k.signer'), code(info.signer)],
      [t('k.expires'), expRow, exp.state === 'expired' ? 'bad' : exp.state === 'warn' ? 'warn' : null],
      [t('k.health'), healthRow, healthCls],
    ]))
    const hExp = classifyExpiry(h.expires)
    if (h.phase === 'done' && hExp.state === 'expired') kids.push(el('div', { class: 'errbox' }, t('h.expired')))
    else if (exp.state === 'warn') kids.push(el('div', { class: 'errbox warnbox' }, t('warnSoon', exp.days)))
    if (h.phase === 'done' && h.signer && !sameAddress(h.signer, info.signer)) kids.push(el('div', { class: 'errbox' }, t('h.signer'), ' ', code(cs(h.signer))))
  }
  kids.push(el('div', { class: 'card-actions' },
    el('a', { class: 'ctl', href: `../playground/?q=${encodeURIComponent(key)}` }, t('playground')),
    el('a', { class: 'ctl', href: consoleLink(key, info) }, t('renew')),
    el('button', { class: 'ctl', type: 'button', disabled: !r || r.phase !== 'done', onclick: () => schedule(key) }, t('retry')),
    el('button', { class: 'ctl danger', type: 'button', onclick: () => doRemove(key) }, t('remove'))))
  return el('article', { class: 'card', 'data-state': st, 'data-key': key }, kids)
}

function renderCard(key) {
  const box = $('cards')
  const old = [...box.children].find((c) => c.getAttribute('data-key') === key)
  if (!list.includes(key)) { old?.remove(); return }
  const card = cardFor(key)
  if (old) old.replaceWith(card); else box.append(card)
}
function renderAll() {
  $('cards').replaceChildren(...list.map(cardFor))
  $('empty').hidden = list.length > 0
  $('refresh-btn').hidden = list.length === 0
}

function setAddMsg(key, args = [], cls = '') { addMsg = key ? [key, args, cls] : null; renderMsg($('add-status'), addMsg) }
function setWalletMsg(key, args = [], cls = '') { walletMsg = key ? [key, args, cls] : null; renderMsg($('wallet-status'), walletMsg) }
function renderMsg(node, msg) { node.className = `status ${msg?.[2] || ''}`; node.textContent = msg ? t(msg[0], ...msg[1]) : '' }

// ── actions / 操作 ─────────────────────────────────────────────────────────────────────────────────────────────
function doAdd(input, { quiet = false } = {}) {
  const r = addTo(list, input)
  if (!r.added) { if (!quiet) setAddMsg(r.reason === 'bad' ? 'add.bad' : r.reason === 'dup' ? 'add.dup' : 'add.full', [parseInput(input)?.key], r.reason === 'dup' ? '' : 'bad'); return false }
  persist(r.list)
  const key = r.list.at(-1)
  if (!quiet) setAddMsg('add.ok', [key], 'ok')
  $('empty').hidden = true; $('refresh-btn').hidden = false
  schedule(key)
  renderDiscover()
  return true
}
function doRemove(key) {
  persist(removeFrom(list, key))
  results.delete(key)
  renderCard(key)
  $('empty').hidden = list.length > 0
  $('refresh-btn').hidden = list.length === 0
  setAddMsg(null)
  renderDiscover()
}

// Wallet: eth_requestAccounts only. No eth_sign*, no eth_sendTransaction, no chain switch, on purpose.
// 钱包：只有 eth_requestAccounts。刻意不签名、不发交易、不切换链。
const eth = window.ethereum
async function connect() {
  if (!eth?.request) { setWalletMsg('noWallet', [], 'warn'); return }
  setWalletMsg('connecting')
  try {
    const accs = await eth.request({ method: 'eth_requestAccounts' })
    const a = Array.isArray(accs) ? accs.find((x) => /^0x[0-9a-fA-F]{40}$/.test(String(x))) : null
    setAccount(a || null)
  } catch (e) {
    setWalletMsg('walletRefused', [String(e?.message || e).slice(0, 200)], 'bad')
  }
}
function setAccount(a) {
  account = a ? cs(a) : null
  if (account) setWalletMsg('connected', [account], 'ok'); else setWalletMsg(null)
  $('connect-btn').setAttribute('data-i18n', account ? 'reconnect' : 'connect')
  $('connect-btn').textContent = t(account ? 'reconnect' : 'connect')
  renderAll()
  renderDiscover()
}
eth?.on?.('accountsChanged', (accs) => { if (account) setAccount(Array.isArray(accs) ? accs[0] : null) })

// Discover: check one pasted name's holder. There is no index of "circuits held by an address", so no listing.
// 发现：核对粘贴的一个名称的持有人。链上没有“某地址持有哪些电路”的索引，所以不做列举。
let discoverGen = 0
async function doDiscover(ev) {
  ev?.preventDefault()
  const p = parseInput($('discover-input').value)
  if (!p || p.kind !== 'name') { discover = { phase: 'bad' }; renderDiscover(); return }
  const g = ++discoverGen
  discover = { phase: 'checking', key: p.key }
  renderDiscover()
  $('discover-btn').disabled = true
  try {
    // on the name's own chain / 在名字所在的链上读
    const on = api.forChain(p.chainId ?? 56).chain
    const circuits = cs(await on.cpuAt(p.processor))
    let holder
    try { holder = cs(await on.ownerOf(circuits, p.id)) } catch (e) {
      if (e instanceof TapeAPIError && e.code === 'RPC_ERROR' && /revert/i.test(e.message)) throw new TapeAPIError('NOT_FOUND', t('discover.nocircuit', p.id, p.processor))
      throw e
    }
    const container = cs(await on.accountOf(circuits, p.id))
    if (g === discoverGen) discover = { phase: 'done', key: p.key, info: { circuits, holder, container, chainId: p.chainId ?? 56 } }
  } catch (e) {
    if (g === discoverGen) discover = { phase: 'done', key: p.key, error: e }
  } finally {
    if (g === discoverGen) { $('discover-btn').disabled = false; renderDiscover() }
  }
}
function renderDiscover() {
  const out = $('discover-out')
  if (!discover) { out.replaceChildren(); return }
  if (discover.phase === 'bad') { out.replaceChildren(el('p', { class: 'status bad' }, t('discover.bad'))); return }
  if (discover.phase === 'checking') { out.replaceChildren(el('p', { class: 'status' }, t('discover.checking'))); return }
  if (discover.error) { out.replaceChildren(errorBox(discover.error)); return }
  const { circuits, holder, container, chainId } = discover.info
  const mine = account && sameAddress(holder, account)
  const verdict = !account ? el('p', { class: 'verdict' }, t('discover.nowallet'))
    : mine ? el('p', { class: 'verdict ok' }, t('discover.yours'))
      : el('p', { class: 'verdict bad' }, t('discover.notyours'))
  const inList = list.includes(discover.key)
  out.replaceChildren(
    kv([[t('k.name'), code(discover.key)], [t('k.chain'), chainName(chainId)], [t('k.circuits'), code(circuits)], [t('k.container'), code(container)], [t('k.holder'), code(holder)]]),
    verdict,
    el('div', { class: 'row' },
      el('button', { class: 'btn', type: 'button', disabled: inList, onclick: () => doAdd(discover.key) }, t(inList ? 'discover.added' : 'discover.add')),
      el('p', { class: 'muted' }, t('discover.note'))))
}

// ── language and theme / 语言与主题 ─────────────────────────────────────────────────────────────────────────────
function applyLang() {
  root.setAttribute('data-lang', lang)
  root.setAttribute('lang', lang === 'zh' ? 'zh-CN' : 'en')
  for (const n of document.querySelectorAll('[data-i18n]')) n.innerHTML = t(n.getAttribute('data-i18n'))   // our own strings only / 只有本文件的字符串
  $('lang-btn').textContent = t('other')
  $('lang-btn').setAttribute('lang', lang === 'zh' ? 'en' : 'zh-CN')
  $('docs-link').href = `../docs/${lang}/provide`
  document.title = lang === 'zh' ? 'TapeAPI 我的服务' : 'TapeAPI · My services'
  themeLabel()
  renderMsg($('wallet-status'), walletMsg)
  renderMsg($('add-status'), addMsg)
  renderAll()
  renderDiscover()
}
function themeLabel() {
  const cur = root.getAttribute('data-theme')
  $('theme-btn').textContent = cur === 'dark' ? t('light') : cur === 'light' ? t('dark') : t('theme')
}

$('lang-btn').addEventListener('click', () => { lang = lang === 'zh' ? 'en' : 'zh'; put('tapeapi.lang', lang); applyLang() })
$('theme-btn').addEventListener('click', () => {
  const cur = root.getAttribute('data-theme')
  const dark = cur ? cur === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches
  const next = dark ? 'light' : 'dark'
  root.setAttribute('data-theme', next); put('tapeapi.theme', next); themeLabel()
})
$('connect-btn').addEventListener('click', connect)
$('add-form').addEventListener('submit', (ev) => { ev.preventDefault(); if (doAdd($('add-input').value)) $('add-input').value = '' })
$('examples-btn').addEventListener('click', () => { for (const n of PUBLIC_EXAMPLES) doAdd(n, { quiet: true }) })
$('refresh-btn').addEventListener('click', () => { for (const k of list) schedule(k) })
$('discover-form').addEventListener('submit', doDiscover)
// Another tab changed the list: follow it. / 另一个标签页改了列表：跟上。
window.addEventListener('storage', (e) => {
  if (e.key !== null && e.key !== STORAGE_KEY) return
  const next = loadList(storage)
  const added = next.filter((k) => !list.includes(k))
  list = next
  for (const k of [...results.keys()]) if (!list.includes(k)) results.delete(k)
  renderAll()
  for (const k of added) schedule(k)
})

if (!eth?.request) { $('connect-btn').disabled = true; setWalletMsg('noWallet', [], 'warn') }
applyLang()
for (const k of list) schedule(k)
