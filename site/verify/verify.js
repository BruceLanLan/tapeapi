// Receipt checker (tapeapi.fun/verify/): read a receipt from the link's #r= fragment or from what the user pastes,
// recover the signer, resolve the service on chain with the real SDK, and say plainly what holds.
// Hand-written. The SDK is the playground's vendored copy; the pure logic is in lib.js (tested offline).
// Everything in a receipt is untrusted text: it reaches the page through textContent only, never as HTML.
// 回执核验页：从链接的 #r= 片段或用户粘贴的内容读出回执，恢复签名者，用真实 SDK 在链上解析服务，并用平实的话说明结论。
// 手写；SDK 用调试台 vendor/ 里的同一份，纯逻辑在 lib.js（离线测试）。回执里的一切都是不可信文本，只经 textContent 进入页面。
import { createTapeAPI, sig, abi, rpcUrlsFor, operatorOf, CHAINS, parseTapeName } from '../playground/vendor/50e6c9f635/tapeapi-sdk/index.js'
import { readAny, verifyReceipt, verifyUsage, signedBlock, utc, ReceiptError, chainOfReceipt } from './lib.js?v=786e11708f'
import { modelEntryOf, validateAIField, formatOfMethod, MANIFEST_FIELD } from '../playground/vendor/50e6c9f635/tapeapi-sdk/ai.js'
import { T } from './strings.js?v=43aae090ed'

// The SDK's default nodes: three distinct operators (NodeReal, Alchemy, 48 Club); the SDK counts agreement by operator.
// A receipt of a service on X Layer or Base (its name carries area code 2 or 3; an AI receipt's container answers token()
// there) is read on that chain through the SDK's defaults for it, with the same operator quorum.
// SDK 的默认节点：三家不同运营方；SDK 按运营方计票。X Layer 或 Base 上服务的回执（名字带区号 2 或 3；AI 回执的容器在那条链上
// 回答 token()）在那条链上读取，用 SDK 对该链的默认节点，法定数相同。
const RPC_URLS = rpcUrlsFor(56)
const QUORUM = 2
const operatorsOn = (chainId) => new Set(rpcUrlsFor(chainId).map(operatorOf)).size
const chainName = (chainId) => CHAINS[chainId]?.name ?? `chain ${chainId}`

// ── language / 语言 ──────────────────────────────────────────────────────────────────────────────────────────────
const root = document.documentElement
let lang = root.getAttribute('data-lang') === 'en' ? 'en' : 'zh'
const t = (k, ...a) => { const v = T[lang][k] ?? T.en[k] ?? k; return typeof v === 'function' ? v(...a) : v }
const store = (k, v) => { try { localStorage.setItem(k, v) } catch { /* private window / 隐私窗口 */ } }

// ── DOM helpers: text only / 只用文本 ──────────────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id)
function el(tag, attrs, ...kids) {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue
    if (k === 'class') e.className = v
    else e.setAttribute(k, v === true ? '' : v)
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) e.append(c instanceof Node ? c : String(c))
  return e
}
const code = (s) => el('code', null, String(s))
const json = (v) => { try { return JSON.stringify(v, null, 2) ?? 'undefined' } catch { return String(v) } }
const checksum = (a) => { try { return abi.checksumAddress(a) } catch { return a } }

// ── state and the check / 状态与核对 ─────────────────────────────────────────────────────────────────────────────
// Kept as data so a language switch re-renders it. / 以数据保存，切换语言时重绘。
let state = null   // { error } | { raw, kind: 'receipt' | 'usage', receipt, outcome, ms }
let runSeq = 0

async function run(text, fromLink) {
  const seq = ++runSeq
  $('from-link').hidden = !fromLink
  let raw, receipt, kind
  try { ({ raw, receipt, kind } = readAny(text)) } catch (e) {
    state = { error: e }
    render()
    return
  }
  state = { raw, kind, receipt, outcome: null, ms: 0 }
  render()
  $('check-btn').disabled = true
  const t0 = performance.now()
  // A fresh SDK instance per check: nothing cached from an earlier receipt. 4 s per node, as in the playground.
  // 每次核对新建 SDK 实例：不沿用上一份回执的缓存。每个节点 4 秒，与调试台相同。
  const api = createTapeAPI({ rpcUrls: RPC_URLS, quorum: QUORUM, rpcTimeoutMs: 4000 })
  let outcome
  try {
    // An AI usage receipt names only its container: the service is resolved from it. Its hashes are checked against
    // the request and response bytes only when they were pasted. / AI 用量回执只给出容器，按容器解析；哈希只在粘贴了字节时核对。
    // An AI receipt's container: the chain on which it answers ERC-6551 token() (BNB Smart Chain first); an outage there is
    // "could not check", never a verdict. / AI 回执的容器：在哪条链上回答 token()（先看 BNB）；读不到只是"没能核对"。
    const resolveContainer = async (c) => { const id = await api.chainOfContainer(c); return api.resolve(id && id !== 56 ? { chainId: id, container: c } : c) }
    outcome = kind === 'usage'
      ? await verifyUsage(receipt, { recover: sig.recoverResponseSigner, resolve: resolveContainer, request: $('request-input').value, response: $('response-input').value })
      : await verifyReceipt(receipt, { recover: sig.recoverResponseSigner, recoverHashed: sig.recoverResponseSignerFromHashes, resolve: api.resolve, cpuAt: (p, id) => api.forChain(id ?? 56).chain.cpuAt(p) })
  } finally { if (seq === runSeq) $('check-btn').disabled = false }
  if (seq !== runSeq) return   // a newer receipt was submitted meanwhile / 期间提交了新的回执
  state.outcome = outcome
  state.ms = Math.round(performance.now() - t0)
  render()
}

// ── rendering / 渲染 ───────────────────────────────────────────────────────────────────────────────────────────
function render() {
  const err = $('input-error')
  if (!state) { err.hidden = true; $('s-result').hidden = true; $('status').textContent = ''; return }
  if (state.error) {
    const e = state.error
    err.textContent = e instanceof ReceiptError ? t(`err.${e.code}`, e.field) : String(e?.message || e)
    err.hidden = false
    $('s-result').hidden = true
    $('status').textContent = ''
    return
  }
  err.hidden = true
  const { receipt: r, outcome: o } = state
  $('status').textContent = o ? t('done', state.ms) : t('checking')
  const usage = state.kind === 'usage'
  // A hash-only receipt (v 2) shows the two hashes where a v 1 receipt shows the params and the result.
  // 只带哈希的回执（v 2）在 v 1 显示参数与结果的位置显示两个哈希。
  const hashed = !usage && r.v === 2
  renderVerdict(r, o)
  renderChecks(r, o)
  if (usage) renderUsageDetails(r, o); else renderDetails(r, o)
  $('ai-note').hidden = !usage
  $('hashed-note').hidden = !hashed
  // A v 1 receipt carries the call in clear, and so does its link: say so where the content is shown.
  // v 1 回执带明文调用内容，它的链接也一样：在显示内容的地方说明。
  $('content-note').hidden = usage || hashed
  $('params-label').textContent = hashed ? t('params.hashed') : t('params.label')
  $('params-json').textContent = hashed ? r.requestHash : json(r.params)
  $('body-label').textContent = usage ? t('body.usage') : hashed ? t('body.hashed') : r.ok ? t('body.result') : t('body.error')
  $('body-json').textContent = hashed ? r.bodyHash : json(r.ok ? r.result : r.error)
  $('receipt-json').textContent = json(state.raw)
  $('s-result').hidden = false
}

const MARK = { pass: '✓', fail: '✕', unknown: '?', skip: '–' }

function renderVerdict(r, o) {
  const box = $('verdict')
  $('retry-btn').hidden = !(o && o.verdict === 'unchecked')
  if (!o) {
    box.className = 'vd unchecked'
    box.replaceChildren(el('p', { class: 'vd-title' }, t('v.checking')))
    return
  }
  // Only names the chain vouched for: the manifest's (its bytes are hashed on chain) and the receipt's once checked.
  // 只用链上担保过的名字：清单里的（字节哈希在链上）与核对通过的回执名字。
  const usage = state.kind === 'usage'
  const id = usage ? checksum(r.container) : o.name?.state === 'pass' ? r.service.name : `#${r.service.tokenId} · ${checksum(r.service.circuits)}`
  const who = o.svc?.manifest?.name ? `“${o.svc.manifest.name}” (${id})` : id
  const text = []
  const hashed = !usage && r.v === 2
  if (o.verdict === 'valid') text.push(t(usage ? 'x.valid.usage' : hashed ? (r.ok ? 'x.valid.hashed' : 'x.valid.hashed.refusal') : r.ok ? 'x.valid' : 'x.valid.refusal', who))
  else if (o.verdict === 'other-key') {
    text.push(t('x.other-key'))
    text.push(t('x.other-key.why'))
  } else if (o.verdict === 'invalid') {
    let msg = t(`x.invalid.${o.failed}`)
    if (o.failed === 'resolve' && o.resolveError) msg += `${o.resolveError.code ? `${o.resolveError.code}: ` : ''}${o.resolveError.message || ''}`
    text.push(msg)
    if (o.failed === 'amount') text.push(...o.amountProblems)
  } else {
    text.push(t('x.unchecked'))
    const e = o.resolveError || o.name?.error
    if (e) text.push(`${e.code ? `${e.code}: ` : ''}${e.message || e}`)
  }
  if (o.recovered && o.verdict !== 'valid') text.push(t('x.signerIs', o.recovered))
  box.className = `vd ${o.verdict}`
  box.replaceChildren(
    el('p', { class: 'vd-title' }, el('span', { class: 'vd-mark', 'aria-hidden': 'true' }, { valid: '✓', 'other-key': '?', invalid: '✕', unchecked: '…' }[o.verdict]), t(`v.${o.verdict}`)),
    ...text.map((x) => el('p', { class: 'vd-text' }, x)),
  )
}

function checkRow(state, label, value, how) {
  return el('li', { class: state === 'fail' ? 'is-fail' : null },
    el('span', { class: `mk ${state === 'pass' ? '' : state}`.trim(), 'aria-hidden': 'true' }, MARK[state]),
    el('span', { class: 'k' }, label, el('span', { class: 'sr' }, ` (${t(`s.${state}`)})`)),
    el('span', { class: 'v' }, value, how ? el('span', { class: 'how' }, how) : null))
}

function renderChecks(r, o) {
  const box = $('checks')
  if (!o) { box.replaceChildren(); box.hidden = true; return }
  const m = o.svc?.manifest
  const errText = (e) => (e ? `${e.code ? `${e.code}: ` : ''}${e.message || e}` : '')
  const rows = []
  for (const { id, state } of o.checks) {
    if (id === 'name' && state === 'skip') continue   // the receipt names no name / 回执没有名字
    let value = null, how = null
    if ((id === 'request' || id === 'response') && state === 'skip') value = t('c.notPasted')
    else if (state === 'skip') value = t('c.notRun')
    else if (id === 'sig') {
      if (state === 'pass') { value = code(o.recovered); how = t('c.sig.how') } else value = errText(o.recoverError)
    } else if (id === 'resolve') {
      if (state === 'pass') { value = el('span', null, m.name ? `${m.name} · ` : '', code(checksum(m.circuits)), ` #${m.tokenId}`); how = `${chainName(o.svc.chainId ?? 56)} · ${t('c.resolve.how', QUORUM, operatorsOn(o.svc.chainId ?? 56))}` } else {
        value = errText(o.resolveError); if (state === 'unknown') how = t('c.network')
      }
    } else if (id === 'container') {
      value = code(o.svc.container)
      how = state === 'pass' ? t('c.container.how') : t('c.container.bad', o.svc.container, r.service?.container ?? r.container)
    } else if (id === 'delegation') {
      value = o.svc.verified?.holder ? code(o.svc.verified.holder) : '—'
      if (m?.delegation?.expires) how = t('c.delegation.how', utc(m.delegation.expires))
    } else if (id === 'name') {
      value = code(r.service.name)
      if (state === 'pass') how = t('c.name.how', parseTapeName(r.service.name).processor, checksum(r.service.circuits))
      else if (state === 'fail') how = o.name?.error ? errText(o.name.error) : t('c.name.bad')
      else how = `${t('c.network')} · ${errText(o.name?.error)}`
    } else if (id === 'signer') {
      value = code(checksum(m.signer))
      how = state === 'pass' ? t('c.signer.how') : t('c.signer.bad', o.recovered, checksum(m.signer))
    } else if (id === 'method') {
      value = code(`${r.method} · ${r.params.path}`)
      how = t(`c.method.${state}`)
    } else if (id === 'amount') {
      const ps = r.result.prices
      value = ps ? ps.map((p) => `${p.amount} ${p.currency}`).join(' / ') : t('d.noPrice')
      how = state === 'pass' ? t('c.amount.how') : o.amountProblems.join('; ')
    } else if (id === 'request' || id === 'response') {
      value = code(id === 'request' ? r.params.requestSha256 : r.result.responseSha256)
      how = t(state === 'pass' ? 'c.hash.how' : 'c.hash.bad')
    }
    rows.push(checkRow(state, t(`c.${id}`), value, how))
  }
  box.replaceChildren(...rows)
  box.hidden = false
}

function renderDetails(r, o) {
  const aside = (k) => el('span', { class: 'aside' }, t(k))
  const kv = []
  const service = o?.svc?.manifest?.name ?? (o && !o.svc ? t('d.notResolved') : t('d.none'))
  kv.push([t('d.service'), service])
  if (r.service.name !== undefined) kv.push([t('d.name'), [code(r.service.name), aside('d.name.aside')]])
  kv.push([t('d.chain'), chainName(o?.svc?.chainId ?? chainOfReceipt(r))])
  kv.push([t('d.container'), code(checksum(r.service.container))])
  kv.push([t('d.circuit'), [code(checksum(r.service.circuits)), ` #${r.service.tokenId}`]])
  // In a hash-only receipt the method is bound only through requestHash, together with the params: shown as stated.
  // 只带哈希的回执里，方法只经 requestHash 与参数一起绑定：按回执所写展示。
  kv.push([t('d.method'), r.v === 2 ? [code(r.method), aside('d.method.hashed')] : code(r.method)])
  kv.push([t('d.form'), r.v === 2 ? t('d.form.hashed') : t('d.form.content')])
  kv.push([t('d.id'), code(r.id)])
  kv.push([t('d.outcome'), r.ok ? t('d.ok') : t('d.refusal')])
  kv.push([t('d.ts'), `${utc(r.ts)} (${r.ts})`])
  const sb = signedBlock(r)
  if (sb !== null) kv.push([t('d.signedBlock'), [code(String(sb)), aside('d.signedBlock.aside')]])
  if (r.block !== undefined) kv.push([t('d.block'), [code(String(r.block)), aside('d.block.aside')]])
  kv.push([t('d.signer'), o?.recovered ? code(o.recovered) : t('d.none')])
  $('details').replaceChildren(...kv.flatMap(([k, v]) => [el('dt', null, k), el('dd', null, v)]))
}

// What an AI usage receipt says: the call, the model, the tokens, the price and the amount. Every value here is signed.
// AI 用量回执的内容：调用、模型、token、价格与金额。这里的每个值都在签名范围内。
function renderUsageDetails(r, o) {
  const aside = (k) => el('span', { class: 'aside' }, t(k))
  const u = r.result.usage, ps = r.result.prices, m = o?.svc?.manifest
  // The unit prices are the manifest's, not the receipt's: the entry the receipt's model matches. / 单价来自清单条目。
  let entry = null
  try { entry = m ? modelEntryOf(validateAIField(m[MANIFEST_FIELD], { allowHttp: true }).models, r.result.model, formatOfMethod(r.method)?.name) : null } catch { entry = null }
  const kv = []
  kv.push([t('d.service'), m?.name ?? (o && !o.svc ? t('d.notResolved') : t('d.none'))])
  if (o?.svc) kv.push([t('d.chain'), chainName(o.svc.chainId ?? 56)])
  kv.push([t('d.container'), code(checksum(r.container))])
  if (m) kv.push([t('d.circuit'), [code(checksum(m.circuits)), ` #${m.tokenId}`]])
  kv.push([t('d.method'), code(r.method)])
  kv.push([t('d.path'), code(r.params.path)])
  kv.push([t('d.id'), code(r.id)])
  const modelNote = r.result.modelMatchedBy === 'request' ? aside('d.model.request') : entry && entry.id !== r.result.model ? el('span', { class: 'aside' }, t('d.model.alias', entry.id)) : null
  kv.push([t('d.model'), r.result.model === null ? t('d.none') : [code(r.result.model), modelNote]])
  kv.push([t('d.tokens'), u ? t('d.tokens.v', u) : t('d.noUsage')])
  if (r.result.usageInjected) kv.push([t('d.injected'), t('d.injected.v')])
  kv.push([t('d.price'), entry ? entry.prices.map((p) => t('d.price.v', p)).join('; ') : m ? t('d.noPrice') : t('d.price.unresolved')])
  kv.push([t('d.amount'), ps ? [code(ps.map((p) => `${p.amount} ${p.currency}`).join(' / ')), r.result.unpriced ? el('span', { class: 'aside' }, t('d.unpriced', r.result.unpriced.join(', '))) : null] : t('d.noPrice')])
  kv.push([t('d.complete'), r.result.complete ? t('d.complete.yes') : t('d.complete.no')])
  kv.push([t('d.status'), code(String(r.result.status))])
  kv.push([t('d.stream'), r.result.stream ? t('d.stream.yes') : t('d.stream.no')])
  kv.push([t('d.ts'), `${utc(r.ts)} (${r.ts})`])
  kv.push([t('d.requestSha256'), [code(r.params.requestSha256), aside('d.hash.aside')]])
  kv.push([t('d.responseSha256'), [code(r.result.responseSha256), aside('d.hash.aside')]])
  kv.push([t('d.signer'), o?.recovered ? code(o.recovered) : t('d.none')])
  $('details').replaceChildren(...kv.flatMap(([k, v]) => [el('dt', null, k), el('dd', null, v)]))
}

// ── language and theme / 语言与主题 ─────────────────────────────────────────────────────────────────────────────
function applyLang() {
  root.setAttribute('data-lang', lang)
  root.setAttribute('lang', lang === 'zh' ? 'zh-CN' : 'en')
  $('lang-btn').textContent = t('other')
  $('lang-btn').setAttribute('lang', lang === 'zh' ? 'en' : 'zh-CN')
  $('receipt-input').setAttribute('placeholder', t('placeholder'))
  document.title = t('title')
  themeLabel()
  render()
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
$('input-form').addEventListener('submit', (ev) => {
  ev.preventDefault()
  // The address bar must not keep showing a different receipt's link. / 地址栏不应继续显示另一份回执的链接。
  if (location.hash) { try { history.replaceState(null, '', location.pathname) } catch { /* sandboxed / 忽略 */ } }
  run($('receipt-input').value, false)
})
$('retry-btn').addEventListener('click', () => { if (state?.receipt) run(JSON.stringify(state.raw), $('from-link').hidden === false) })

// The receipt in the link: read from the fragment only, which the browser never sends anywhere.
// 链接里的回执：只从片段读取，浏览器不会把片段发往任何地方。
const fromHash = () => { if (/^#r=/.test(location.hash)) run(location.hash, true) }
window.addEventListener('hashchange', fromHash)

applyLang()
fromHash()
