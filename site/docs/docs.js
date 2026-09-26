// TapeAPI Docs: theme, language, search, copy buttons, mobile menu, and the "on this page" highlight.
// Hand-written; loaded in <head> so the theme applies before the first paint. Storage may throw (private window), so
// every access is guarded; the pages read correctly without this script.
// 文档站脚本：主题、语言、搜索、复制按钮、手机目录、本页目录高亮。放在 <head> 里，主题在首次绘制前生效。
// 存储可能抛错（隐私窗口），每次访问都有保护；没有本脚本，页面照样可读。
(function () {
  var root = document.documentElement
  function get(k) { try { return localStorage.getItem(k) } catch (e) { return null } }
  function set(k, v) { try { localStorage.setItem(k, v) } catch (e) {} }
  var theme = get('tapeapi.theme')
  if (theme === 'dark' || theme === 'light') root.setAttribute('data-theme', theme)

  document.addEventListener('DOMContentLoaded', function () {
    var body = document.body
    var L = function (k) { return body.getAttribute('data-l-' + k) || k }

    // Theme / 主题
    var themeBtn = document.getElementById('theme-btn')
    function themeLabel() {
      var t = root.getAttribute('data-theme')
      if (themeBtn) themeBtn.textContent = t === 'dark' ? L('light') : t === 'light' ? L('dark') : L('theme')
    }
    if (themeBtn) themeBtn.addEventListener('click', function () {
      var cur = root.getAttribute('data-theme')
      var dark = cur ? cur === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches
      var next = dark ? 'light' : 'dark'
      root.setAttribute('data-theme', next); set('tapeapi.theme', next); themeLabel()
    })
    themeLabel()

    // Language: the same page in the other language, remembered for the homepage too. / 语言：跳到另一语言的同一页，并记住。
    var langBtn = document.getElementById('lang-btn')
    if (langBtn) langBtn.addEventListener('click', function () {
      set('tapeapi.lang', root.getAttribute('data-lang') === 'zh' ? 'en' : 'zh')
      location.href = body.getAttribute('data-other') + location.hash
    })

    // Mobile menu / 手机目录
    var menuBtn = document.getElementById('menu-btn')
    function closeMenu() { body.classList.remove('nav-open'); if (menuBtn) menuBtn.setAttribute('aria-expanded', 'false') }
    if (menuBtn) menuBtn.addEventListener('click', function () {
      var open = body.classList.toggle('nav-open')
      menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false')
    })
    document.querySelectorAll('.side a').forEach(function (a) { a.addEventListener('click', closeMenu) })

    // Copy buttons on code blocks / 代码块复制按钮
    document.querySelectorAll('.code').forEach(function (box) {
      var pre = box.querySelector('pre')
      if (!pre || !navigator.clipboard) return
      var b = document.createElement('button')
      b.type = 'button'; b.className = 'ctl copy'; b.textContent = L('copy')
      b.addEventListener('click', function () {
        navigator.clipboard.writeText(pre.innerText).then(function () {
          b.textContent = L('copied'); setTimeout(function () { b.textContent = L('copy') }, 1500)
        }, function () {})
      })
      box.appendChild(b)
    })

    // "On this page": mark the section being read. / 本页目录：标出正在读的小节。
    var tocLinks = Array.prototype.slice.call(document.querySelectorAll('.toc a'))
    if (tocLinks.length && 'IntersectionObserver' in window) {
      var byId = {}
      tocLinks.forEach(function (a) { byId[decodeURIComponent(a.getAttribute('href').slice(1))] = a })
      var visible = {}
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) { visible[e.target.id] = e.isIntersecting })
        var heads = document.querySelectorAll('article h2[id], article h3[id]')
        var current = null
        for (var i = 0; i < heads.length; i++) {
          if (heads[i].getBoundingClientRect().top < 140) current = heads[i].id
        }
        if (!current && heads.length) current = heads[0].id
        tocLinks.forEach(function (a) { a.classList.remove('on') })
        if (current && byId[current]) byId[current].classList.add('on')
      }, { rootMargin: '-60px 0px -60% 0px' })
      document.querySelectorAll('article h2[id], article h3[id]').forEach(function (h) { io.observe(h) })
    }

    // Search: one small index per language, fetched on first use. / 搜索：每种语言一个小索引，首次使用时加载。
    var q = document.getElementById('q'), box = document.getElementById('results')
    if (!q || !box) return
    var index = null, loading = null, sel = -1
    function load() {
      if (index || loading) return loading
      loading = fetch('search.json').then(function (r) { return r.json() }).then(function (j) { index = j }, function () { index = [] })
      return loading
    }
    function escHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }
    function snippet(text, terms) {
      var lower = text.toLowerCase(), at = -1
      for (var i = 0; i < terms.length && at < 0; i++) at = lower.indexOf(terms[i])
      var start = Math.max(0, at - 50), s = (start ? '…' : '') + text.slice(start, start + 160) + (text.length > start + 160 ? '…' : '')
      s = escHtml(s)
      terms.forEach(function (t) {
        if (!t) return
        var re = new RegExp(escHtml(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
        s = s.replace(re, function (m) { return '<mark>' + m + '</mark>' })
      })
      return s
    }
    function render() {
      var raw = q.value.trim().toLowerCase()
      sel = -1
      if (!raw) { box.hidden = true; box.innerHTML = ''; return }
      var terms = raw.split(/\s+/)
      var hits = (index || []).map(function (s) {
        var hay = (s.t + ' ' + s.h + ' ' + s.x).toLowerCase(), score = 0
        for (var i = 0; i < terms.length; i++) {
          if (hay.indexOf(terms[i]) < 0) return null
          if ((s.h + ' ' + s.t).toLowerCase().indexOf(terms[i]) >= 0) score += 3
          score += 1
        }
        return { s: s, score: score }
      }).filter(Boolean).sort(function (a, b) { return b.score - a.score }).slice(0, 12)
      if (!hits.length) { box.innerHTML = '<div class="none">' + escHtml(L('none')) + '</div>'; box.hidden = false; return }
      box.innerHTML = hits.map(function (h) {
        var s = h.s
        return '<a href="' + s.p + (s.id ? '#' + encodeURIComponent(s.id) : '') + '"><div class="rt">' + escHtml(s.h || s.t) +
          (s.h ? ' <span>· ' + escHtml(s.t) + '</span>' : '') + '</div><div class="rx">' + snippet(s.x, terms) + '</div></a>'
      }).join('')
      box.hidden = false
    }
    q.addEventListener('focus', load)
    q.addEventListener('input', function () { (load() || Promise.resolve()).then(render) })
    q.addEventListener('keydown', function (e) {
      var items = box.querySelectorAll('a')
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!items.length) return
        e.preventDefault()
        sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
        items.forEach(function (a, i) { a.setAttribute('aria-selected', i === sel ? 'true' : 'false') })
        items[sel].scrollIntoView({ block: 'nearest' })
      } else if (e.key === 'Enter' && items.length) {
        e.preventDefault(); location.href = items[Math.max(sel, 0)].getAttribute('href'); box.hidden = true
      } else if (e.key === 'Escape') { q.value = ''; render(); q.blur() }
    })
    document.addEventListener('click', function (e) { if (!e.target.closest('.search')) box.hidden = true })
    document.addEventListener('keydown', function (e) {
      if (e.key === '/' && document.activeElement !== q && !/input|textarea/i.test(document.activeElement.tagName)) { e.preventDefault(); q.focus() }
    })
  })
})()
