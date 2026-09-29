// TapeAPI Status: asks each service's health endpoint from the browser (they send access-control-allow-origin: *)
// and shows up/down, latency, signer and days until the delegation expires. Loaded in <head> so theme and language
// apply before the first paint. Storage may throw (private window), so every access is guarded.
// 状态页：在浏览器里直接请求各服务的健康检查（服务返回 access-control-allow-origin: *），显示在线与否、延迟、signer
// 和委托剩余天数。放在 <head> 里，主题与语言在首次绘制前生效。存储可能抛错（隐私窗口），每次访问都有保护。
(function () {
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

  // Keep in step with SERVICES in scripts/monitor.mjs. / 与 scripts/monitor.mjs 的 SERVICES 保持一致。
  var SERVICES = [
    { name: ['公共 API', 'Public API'], label: '11.1013.tape', base: 'https://api.tapeapi.fun' },
    { name: ['公共中继', 'Public relay'], label: '12.1013.tape', base: 'https://relay.tapeapi.fun' },
  ]
  var HEALTH_PATH = '/tapeapi/v1/health'
  var WARN_DAYS = 14
  var TIMEOUT_MS = 10000
  var REFRESH_MS = 60000

  // Both languages go into the page; CSS shows one. / 两种语言都写进页面，由 CSS 显示其一。
  function bi(zh, en) {
    var f = document.createDocumentFragment()
    var a = document.createElement('span'); a.lang = 'zh'; a.textContent = zh; f.appendChild(a)
    var b = document.createElement('span'); b.lang = 'en'; b.textContent = en; f.appendChild(b)
    return f
  }
  function el(tag, attrs, kids) {
    var n = document.createElement(tag)
    for (var k in attrs || {}) n.setAttribute(k, attrs[k])
    ;(kids || []).forEach(function (c) { if (c != null) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c) })
    return n
  }
  var isAddr = function (a) { return typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a) }

  function check(svc) {
    var ctl = typeof AbortController === 'function' ? new AbortController() : null
    var timer = setTimeout(function () { if (ctl) ctl.abort() }, TIMEOUT_MS)
    var t0 = performance.now()
    return fetch(svc.base + HEALTH_PATH, { cache: 'no-store', signal: ctl ? ctl.signal : undefined, headers: { accept: 'application/json' } })
      .then(function (res) {
        var ms = Math.round(performance.now() - t0)
        if (!res.ok) return { up: false, latencyMs: ms, error: 'HTTP ' + res.status }
        return res.json().then(function (j) {
          return {
            up: j && j.ok === true, latencyMs: ms, signer: isAddr(j.signer) ? j.signer : null,
            expires: Number.isFinite(j.delegationExpires) ? j.delegationExpires : null,
            version: typeof j.version === 'string' ? j.version.slice(0, 32) : null,
            error: j && j.ok === true ? null : 'ok=' + JSON.stringify(j && j.ok),
          }
        }, function () { return { up: false, latencyMs: ms, error: 'not JSON' } })
      }, function (e) {
        return { up: false, error: e && e.name === 'AbortError' ? 'timeout after ' + TIMEOUT_MS / 1000 + ' s' : 'unreachable (' + ((e && e.message) || e) + ')' }
      })
      .then(function (r) { clearTimeout(timer); return r })
  }

  // up | warn (delegation < 14 days) | down (unreachable, not ok, or delegation expired) / 三种状态
  function stateOf(r, nowS) {
    if (!r) return 'checking'
    if (!r.up) return 'down'
    if (r.expires == null) return 'warn'
    if (r.expires <= nowS) return 'down'
    return (r.expires - nowS) / 86400 < WARN_DAYS ? 'warn' : 'up'
  }
  var BADGE = { checking: ['检查中', 'Checking'], up: ['在线', 'Up'], warn: ['注意', 'Attention'], down: ['不可用', 'Down'] }

  function card(svc, r, nowS) {
    var st = stateOf(r, nowS)
    var rows = el('dl')
    function row(dt, dd, cls) { rows.appendChild(el('dt', null, [dt])); rows.appendChild(el('dd', cls ? { class: cls } : null, [dd])) }
    row(bi('端点', 'Endpoint'), el('a', { href: svc.base + HEALTH_PATH }, [svc.base.replace(/^https:\/\//, '')]), 'mono')
    row(bi('延迟', 'Latency'), r && r.latencyMs != null ? r.latencyMs + ' ms' : '—', 'mono')
    row(bi('签名地址', 'Signer'), r && r.signer ? r.signer : '—', 'mono')
    var exp = '—'; var expCls = 'mono'
    if (r && r.expires != null) {
      var days = Math.floor((r.expires - nowS) / 86400)
      var date = new Date(r.expires * 1000).toISOString().slice(0, 10)
      exp = el('span', null, [date + ' ', el('span', { class: 'sub' }, [
        days < 0 ? bi('（已过期）', '(expired)') : bi('（剩 ' + days + ' 天）', '(in ' + days + ' days)'),
      ])])
      if (r.expires <= nowS) expCls = 'mono bad'; else if (days < WARN_DAYS) expCls = 'mono warn'
    } else if (r && r.up) { exp = bi('未报告', 'not reported'); expCls = 'warn' }
    row(bi('委托到期', 'Delegation expires'), exp, expCls)
    if (r && r.version) row(bi('版本', 'Version'), r.version, 'mono')
    var kids = [
      el('div', { class: 'card-head' }, [
        el('div', null, [el('h2', null, [bi(svc.name[0], svc.name[1])]), el('span', { class: 'label' }, [svc.label])]),
        el('span', { class: 'badge', 'data-state': st }, [bi(BADGE[st][0], BADGE[st][1])]),
      ]),
      rows,
    ]
    if (r && r.error) kids.push(el('p', { class: 'err' }, [bi('错误：', 'Error: '), r.error]))
    if (r && r.up && r.expires != null && r.expires <= nowS) kids.push(el('p', { class: 'err' }, [bi('委托已过期：客户端会拒绝它的每一个回答，直到持有人重新签署。', 'The delegation has expired: clients reject every answer until the holder re-signs it.')]))
    return el('article', { class: 'card', 'data-state': st }, kids)
  }

  var busy = false
  function render(results) {
    var nowS = Math.floor(Date.now() / 1000)
    var cards = document.getElementById('cards')
    cards.textContent = ''
    SERVICES.forEach(function (s, i) { cards.appendChild(card(s, results && results[i], nowS)) })
    var h1 = document.getElementById('summary')
    if (!results) return
    var states = results.map(function (r) { return stateOf(r, nowS) })
    var all = states.indexOf('down') >= 0 ? 'down' : states.indexOf('warn') >= 0 ? 'warn' : 'up'
    h1.setAttribute('data-state', all)
    h1.textContent = ''
    h1.appendChild(all === 'up' ? bi('全部服务正常', 'All services operational')
      : all === 'warn' ? bi('服务在线，但需要注意', 'Up, but needs attention')
      : bi('部分服务不可用', 'Some services are down'))
    var t = document.getElementById('checked')
    var d = new Date()
    t.setAttribute('datetime', d.toISOString())
    t.textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  }
  function refresh() {
    if (busy) return
    busy = true
    var btn = document.getElementById('refresh'); if (btn) btn.disabled = true
    Promise.all(SERVICES.map(check)).then(render, function () { render(SERVICES.map(function () { return { up: false, error: 'check failed' } })) })
      .then(function () { busy = false; if (btn) btn.disabled = false })
  }

  function label() {
    var l = document.getElementById('lang-btn')
    if (l) l.textContent = root.getAttribute('data-lang') === 'zh' ? 'English' : '中文'
    var t = document.getElementById('theme-btn')
    if (t) {
      var x = root.getAttribute('data-theme'); var zh = root.getAttribute('data-lang') === 'zh'
      t.textContent = x === 'dark' ? (zh ? '浅色' : 'Light') : x === 'light' ? (zh ? '深色' : 'Dark') : (zh ? '主题' : 'Theme')
    }
    var zhPage = root.getAttribute('data-lang') === 'zh'
    root.lang = zhPage ? 'zh-CN' : 'en'
    document.title = zhPage ? 'TapeAPI 状态' : 'TapeAPI Status'
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
    document.getElementById('refresh').addEventListener('click', refresh)
    label()
    render(null)
    refresh()
    setInterval(function () { if (!document.hidden) refresh() }, REFRESH_MS)
  })
})()
