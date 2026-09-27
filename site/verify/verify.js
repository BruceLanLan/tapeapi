// Receipt checker (tapeapi.fun/verify/): read a receipt from the link's #r= fragment or from what the user pastes,
// recover the signer, resolve the service on chain with the real SDK, and say plainly what holds.
// Hand-written. The SDK is the playground's vendored copy; the pure logic is in lib.js (tested offline).
// Everything in a receipt is untrusted text: it reaches the page through textContent only, never as HTML.
// 回执核验页：从链接的 #r= 片段或用户粘贴的内容读出回执，恢复签名者，用真实 SDK 在链上解析服务，并用平实的话说明结论。
// 手写；SDK 用调试台 vendor/ 里的同一份，纯逻辑在 lib.js（离线测试）。回执里的一切都是不可信文本，只经 textContent 进入页面。
import { createTapeAPI, sig, abi } from '../playground/vendor/tapeapi-sdk/index.js'
import { extractReceipt, parseReceipt, verifyReceipt, signedBlock, utc, ReceiptError } from './lib.js'
import { T } from './strings.js'

const RPC_URLS = ['https://bsc-dataseed.bnbchain.org', 'https://bsc-dataseed1.defibit.io', 'https://bsc-dataseed1.ninicoin.io']
const QUORUM = 2

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
let state = null   // { error } | { raw, receipt, outcome, ms }
let runSeq = 0

async function run(text, fromLink) {
  const seq = ++runSeq
  $('from-link').hidden = !fromLink
  let raw, receipt
  try { raw = extractReceipt(text); receipt = parseReceipt(raw) } catch (e) {
    state = { error: e }
    render()
    return
  }
  state = { raw, receipt, outcome: null, ms: 0 }
  render()
  $('check-btn').disabled = true
  const t0 = performance.now()
  // A fresh SDK instance per check: nothing cached from an earlier receipt. 4 s per node, as in the playground.
  // 每次核对新建 SDK 实例：不沿用上一份回执的缓存。每个节点 4 秒，与调试台相同。
  const api = createTapeAPI({ rpcUrls: RPC_URLS, quorum: QUORUM, timeoutMs: 4000 })
  let outcome
  try {
    outcome = await verifyReceipt(receipt, { recover: sig.recoverResponseSigner, resolve: api.resolve, cpuAt: api.chain.cpuAt })
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
  renderVerdict(r, o)
  renderChecks(r, o)
  renderDetails(r, o)
  $('params-json').textContent = json(r.params)
  $('body-label').textContent = r.ok ? t('body.result') : t('body.error')
  $('body-json').textContent = json(r.ok ? r.result : r.error)
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
  const id = o.name?.state === 'pass' ? r.service.name : `#${r.service.tokenId} · ${checksum(r.service.circuits)}`
  const who = o.svc?.manifest?.name ? `“${o.svc.manifest.name}” (${id})` : id
  const text = []
  if (o.verdict === 'valid') text.push(t(r.ok ? 'x.valid' : 'x.valid.refusal', who))
  else if (o.verdict === 'other-key') {
    text.push(t('x.other-key'))
    text.push(t('x.other-key.why'))
  } else if (o.verdict === 'invalid') {
    let msg = t(`x.invalid.${o.failed}`)
    if (o.failed === 'resolve' && o.resolveError) msg += `${o.resolveError.code ? `${o.resolveError.code}: ` : ''}${o.resolveError.message || ''}`
    text.push(msg)
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
    if (state === 'skip') value = t('c.notRun')
    else if (id === 'sig') {
      if (state === 'pass') { value = code(o.recovered); how = t('c.sig.how') } else value = errText(o.recoverError)
    } else if (id === 'resolve') {
      if (state === 'pass') { value = el('span', null, m.name ? `${m.name} · ` : '', code(checksum(m.circuits)), ` #${m.tokenId}`); how = t('c.resolve.how', QUORUM, RPC_URLS.length) } else {
        value = errText(o.resolveError); if (state === 'unknown') how = t('c.network')
      }
    } else if (id === 'container') {
      value = code(o.svc.container)
      how = state === 'pass' ? t('c.container.how') : t('c.container.bad', o.svc.container, r.service.container)
    } else if (id === 'delegation') {
      value = o.svc.verified?.holder ? code(o.svc.verified.holder) : '—'
      if (m?.delegation?.expires) how = t('c.delegation.how', utc(m.delegation.expires))
    } else if (id === 'name') {
      value = code(r.service.name)
      if (state === 'pass') how = t('c.name.how', r.service.name.split('.')[1], checksum(r.service.circuits))
      else if (state === 'fail') how = o.name?.error ? errText(o.name.error) : t('c.name.bad')
      else how = `${t('c.network')} · ${errText(o.name?.error)}`
    } else if (id === 'signer') {
      value = code(checksum(m.signer))
      how = state === 'pass' ? t('c.signer.how') : t('c.signer.bad', o.recovered, checksum(m.signer))
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
  kv.push([t('d.container'), code(checksum(r.service.container))])
  kv.push([t('d.circuit'), [code(checksum(r.service.circuits)), ` #${r.service.tokenId}`]])
  kv.push([t('d.method'), code(r.method)])
  kv.push([t('d.id'), code(r.id)])
  kv.push([t('d.outcome'), r.ok ? t('d.ok') : t('d.refusal')])
  kv.push([t('d.ts'), `${utc(r.ts)} (${r.ts})`])
  const sb = signedBlock(r)
  if (sb !== null) kv.push([t('d.signedBlock'), [code(String(sb)), aside('d.signedBlock.aside')]])
  if (r.block !== undefined) kv.push([t('d.block'), [code(String(r.block)), aside('d.block.aside')]])
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
