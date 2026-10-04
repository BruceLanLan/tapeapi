// TapeAPI provider directory: reads providers.json (the list, edited by pull requests) and status.json (written by the
// daily recheck) from this site and shows every entry in the file's own order (chain, processor, #ID): this page never
// sorts or ranks. Loaded in <head> so theme and language apply before the first paint. Storage may throw
// (private window), so every access is guarded. The pure part (TapeDirectory.model) is tested in directory/page.test.mjs.
// 服务方目录：从本站读取 providers.json（列表，由拉取请求修改）与 status.json（每日复核生成），按文件本身的顺序（链、处理器、#ID）
// 显示每一条：本页从不排序或排名。放在 <head> 里，主题与语言在首次绘制前生效。存储可能抛错（隐私窗口），每次访问都有保护。
(function (global) {
  // The doctor from the SDK's release package, as in the guide for AI providers. / 与 AI 服务方指南相同的发布包里的诊断。
  var DOCTOR = 'npx -y --package=https://github.com/BruceLanLan/tapeapi/releases/download/v1.7.1/tapeapi-sdk-1.7.1.tgz tapeapi-doctor'
  var CHAINS = { bnb: ['BNB Smart Chain', 'BNB Smart Chain'], 2: ['X Layer', 'X Layer'], 3: ['Base', 'Base'] }
  var FLAG = {
    ok: { state: 'up', label: ['通过', 'Passing'] },
    failing: { state: 'down', label: ['未通过', 'Failing'] },
    stale: { state: 'down', label: ['长期未通过', 'Stale'] },
    undecided: { state: 'warn', label: ['无法判定', 'Undecided'] },
    none: { state: 'checking', label: ['尚未复核', 'Not yet rechecked'] },
  }

  // <#ID>.<processor>.tape is BNB Smart Chain; <#ID>.<area>.<processor>.tape another chain (area 2 X Layer, 3 Base).
  // 不带区号是 BNB Smart Chain；带区号的是其它链（2 为 X Layer，3 为 Base）。
  function chainOf(name) {
    var p = String(name).split('.')
    if (p.length === 3) return CHAINS.bnb
    if (p.length === 4 && CHAINS[p[1]]) return CHAINS[p[1]]
    return ['区号 ' + p[1], 'area ' + p[1]]
  }
  function utc(iso) {
    if (typeof iso !== 'string') return null
    var d = new Date(iso)
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
  }
  var list = function (a) { return Array.isArray(a) ? a.filter(function (x) { return typeof x === 'string' }) : [] }
  var safeUrl = function (u) { return typeof u === 'string' && /^https:\/\/[^\s]+$/.test(u) && u.length <= 200 ? u : null }

  /**
   * What the page shows, from the two files; no DOM. Entries keep providers.json's order.
   * 页面显示的内容，由两个文件得出，不涉及 DOM。条目保持 providers.json 的顺序。
   */
  function model(providers, status) {
    var entries = (providers && Array.isArray(providers.providers) ? providers.providers : []).filter(function (e) { return e && typeof e.name === 'string' })
    var st = status && status.providers && typeof status.providers === 'object' ? status.providers : {}
    return {
      empty: entries.length === 0,
      checkedAt: status ? utc(status.checkedAt) : null,
      entries: entries.map(function (e) {
        var s = Object.prototype.hasOwnProperty.call(st, e.name) ? st[e.name] : null
        var flag = s && FLAG[s.flag] && s.flag !== 'none' ? s.flag : 'none'
        return {
          name: e.name, chain: chainOf(e.name), flag: flag, state: FLAG[flag].state, label: FLAG[flag].label,
          checkedAt: s ? utc(s.checkedAt) : null, since: s ? utc(s.since) : null,
          failed: s ? list(s.failed) : [], undecidedChecks: s ? list(s.undecided) : [],
          consecutiveFailures: s && Number.isInteger(s.consecutiveFailures) ? s.consecutiveFailures : 0,
          verdict: s && flag === 'undecided' && FLAG[s.verdict] ? FLAG[s.verdict].label : null,
          verdictAt: s && flag === 'undecided' ? utc(s.verdictAt) : null,
          added: typeof e.added === 'string' ? e.added : null, contact: safeUrl(e.contact),
          command: DOCTOR + ' ' + e.name,
        }
      }),
    }
  }

  // ---- DOM ------------------------------------------------------------------------------------------------------------
  // Both languages go into the page; CSS shows one. Text is always set as text, never as HTML.
  // 两种语言都写进页面，由 CSS 显示其一。文字一律作为文本写入，从不作为 HTML。
  function bi(doc, zh, en) {
    var f = doc.createDocumentFragment()
    var a = doc.createElement('span'); a.setAttribute('lang', 'zh'); a.textContent = zh; f.appendChild(a)
    var b = doc.createElement('span'); b.setAttribute('lang', 'en'); b.textContent = en; f.appendChild(b)
    return f
  }
  function el(doc, tag, attrs, kids) {
    var n = doc.createElement(tag)
    for (var k in attrs || {}) n.setAttribute(k, attrs[k])
    ;(kids || []).forEach(function (c) { if (c != null) n.appendChild(typeof c === 'string' ? doc.createTextNode(c) : c) })
    return n
  }

  function card(doc, e) {
    var rows = el(doc, 'dl')
    function row(dt, dd, cls) { rows.appendChild(el(doc, 'dt', null, [dt])); rows.appendChild(el(doc, 'dd', cls ? { class: cls } : null, [dd])) }
    row(bi(doc, '链', 'Chain'), bi(doc, e.chain[0], e.chain[1]))
    row(bi(doc, '最后复核', 'Last recheck'), e.checkedAt || bi(doc, '尚未复核', 'not yet'), 'mono')
    if (e.flag !== 'none' && e.since) row(bi(doc, '此状态始于', 'In this state since'), e.since, 'mono')
    if (e.failed.length) {
      var n = e.consecutiveFailures
      row(bi(doc, '未通过的检查', 'Failed checks'), el(doc, 'span', null, [e.failed.join(', '),
        n ? el(doc, 'span', { class: 'sub' }, [bi(doc, '（连续 ' + n + ' 次复核）', ' (' + n + ' rechecks in a row)')]) : null]), 'mono bad')
    }
    if (e.flag === 'undecided') {
      row(bi(doc, '前一次结论', 'Last verdict'), e.verdict
        ? el(doc, 'span', null, [bi(doc, e.verdict[0], e.verdict[1]), e.verdictAt ? ' · ' + e.verdictAt : ''])
        : bi(doc, '还没有', 'none yet'))
    }
    if (e.added) row(bi(doc, '登记于', 'Listed on'), e.added, 'mono')
    if (e.contact) row(bi(doc, '联系', 'Contact'), el(doc, 'a', { href: e.contact, rel: 'nofollow noopener noreferrer' }, [e.contact]))
    var kids = [
      el(doc, 'div', { class: 'card-head' }, [
        el(doc, 'div', null, [el(doc, 'h2', { class: 'name' }, [e.name]), el(doc, 'span', { class: 'label' }, [bi(doc, e.chain[0], e.chain[1])])]),
        el(doc, 'span', { class: 'badge', 'data-state': e.state }, [bi(doc, e.label[0], e.label[1])]),
      ]),
      rows,
    ]
    if (e.flag === 'undecided') kids.push(el(doc, 'p', { class: 'err' }, [bi(doc, '今天读不到链或网络，无法判定；保留前一次的结论，不会因此标为未通过。', 'The chain or the network could not be read today; the last verdict stands, and this alone never marks an entry as failing.')]))
    kids.push(el(doc, 'p', { class: 'cmd-cap' }, [bi(doc, '用 tapeapi-doctor 自己复核：', 'Recheck it yourself with tapeapi-doctor:')]))
    kids.push(el(doc, 'pre', { class: 'cmd' }, [el(doc, 'code', null, [e.command])]))
    return el(doc, 'article', { class: 'card', 'data-state': e.state, 'data-name': e.name }, kids)
  }

  function emptyCard(doc) {
    return el(doc, 'article', { class: 'card empty', id: 'empty' }, [
      el(doc, 'h2', null, [bi(doc, '还没有服务方上架', 'No provider is listed yet')]),
      el(doc, 'ol', { class: 'steps' }, [
        el(doc, 'li', null, [bi(doc, '让你的服务通过 tapeapi-doctor，全部检查通过（退出码 0）。', 'Make your service pass tapeapi-doctor: every check passes (exit status 0).')]),
        el(doc, 'li', null, [bi(doc, '按服务登记表的条件提一个拉取请求，在 providers.json 里加上你的一条。', 'Open a pull request that adds your entry to providers.json, with the conditions of the service listing form.')]),
      ]),
      el(doc, 'p', null, [el(doc, 'a', { href: '#how' }, [bi(doc, '详细步骤 ↓', 'The steps in full ↓')])]),
    ])
  }

  /** Draw the list into `box` (and the page's last-recheck time). / 把列表画进 box。 */
  function render(doc, box, m, failed) {
    box.textContent = ''
    if (failed) {
      box.appendChild(el(doc, 'p', { class: 'card err' }, [bi(doc, '读不到 providers.json，请稍后刷新。', 'Could not read providers.json; reload in a moment.'), ' ', el(doc, 'a', { href: 'providers.json' }, ['providers.json'])]))
      return
    }
    if (m.empty) { box.appendChild(emptyCard(doc)); return }
    m.entries.forEach(function (e) { box.appendChild(card(doc, e)) })
  }

  global.TapeDirectory = { model: model, render: render, chainOf: chainOf, DOCTOR: DOCTOR }
  if (typeof document === 'undefined' || typeof global.addEventListener !== 'function') return

  var root = document.documentElement
  function get(k) { try { return localStorage.getItem(k) } catch (e) { return null } }
  function set(k, v) { try { localStorage.setItem(k, v) } catch (e) {} }
  var lang = get('tapeapi.lang')
  if (lang !== 'zh' && lang !== 'en') {
    lang = /^zh/i.test((navigator.languages && navigator.languages[0]) || navigator.language || '') ? 'zh' : 'en'
  }
  root.setAttribute('data-lang', lang)
  var theme = get('tapeapi.theme')
  if (theme === 'dark' || theme === 'light') root.setAttribute('data-theme', theme)

  function label() {
    var zh = root.getAttribute('data-lang') === 'zh'
    var l = document.getElementById('lang-btn')
    if (l) l.textContent = zh ? 'English' : '中文'
    var t = document.getElementById('theme-btn')
    if (t) {
      var x = root.getAttribute('data-theme')
      t.textContent = x === 'dark' ? (zh ? '浅色' : 'Light') : x === 'light' ? (zh ? '深色' : 'Dark') : (zh ? '主题' : 'Theme')
    }
    root.lang = zh ? 'zh-CN' : 'en'
    document.title = zh ? 'TapeAPI 服务方目录' : 'TapeAPI Provider Directory'
  }

  function load(file) {
    return fetch(file, { cache: 'no-store', headers: { accept: 'application/json' } }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status)
      return r.json()
    })
  }

  document.addEventListener('DOMContentLoaded', function () {
    document.getElementById('lang-btn').addEventListener('click', function () {
      var next = root.getAttribute('data-lang') === 'zh' ? 'en' : 'zh'
      root.setAttribute('data-lang', next); set('tapeapi.lang', next); label()
    })
    document.getElementById('theme-btn').addEventListener('click', function () {
      var cur = root.getAttribute('data-theme')
      var dark = cur ? cur === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches
      var next = dark ? 'light' : 'dark'
      root.setAttribute('data-theme', next); set('tapeapi.theme', next); label()
    })
    label()
    var box = document.getElementById('list')
    // status.json may be missing before the first recheck: every entry then shows "not yet rechecked".
    // 第一次复核之前可能没有 status.json：每一条都显示“尚未复核”。
    Promise.all([load('providers.json'), load('status.json').catch(function () { return null })]).then(function (r) {
      var m = model(r[0], r[1])
      render(document, box, m, false)
      var t = document.getElementById('checked')
      if (m.checkedAt && !m.empty) { t.textContent = m.checkedAt; t.setAttribute('datetime', r[1].checkedAt) }
    }, function () { render(document, box, null, true) })
  })
})(this)
