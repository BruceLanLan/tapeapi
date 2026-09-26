// Language for the holder console, the same mechanism as the homepage (site/app.js): the choice is kept under
// 'tapeapi.lang', the default follows the browser, and <span lang="zh">/<span lang="en"> pairs are shown by CSS.
// Loaded as a plain script in <head> so the right language shows on first paint. Attributes that cannot hold a <span>
// (placeholder, aria-label, the title) are swapped from data-zh-*/data-en-* attributes.
// 操作台的语言，与首页（site/app.js）机制相同：选择存在 'tapeapi.lang'，默认跟随浏览器，CSS 显示对应的 <span lang>。
// 作为普通脚本在 <head> 里加载，首屏就是正确的语言。不能放 <span> 的属性（placeholder、aria-label、标题）从 data-* 属性切换。
(function () {
  var root = document.documentElement
  function get(k) { try { return localStorage.getItem(k) } catch (e) { return null } }
  function set(k, v) { try { localStorage.setItem(k, v) } catch (e) { /* private window / 隐私窗口 */ } }

  var lang = get('tapeapi.lang')
  if (lang !== 'zh' && lang !== 'en') {
    var nav = (navigator.languages && navigator.languages[0]) || navigator.language || 'en'
    lang = /^zh/i.test(nav) ? 'zh' : 'en'
  }

  function apply() {
    var l = root.getAttribute('data-lang')
    root.setAttribute('lang', l === 'zh' ? 'zh-CN' : 'en')
    var nodes = document.querySelectorAll('[data-zh-placeholder],[data-zh-aria-label],[data-zh-title]')
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i]
      var attrs = ['placeholder', 'aria-label']
      for (var j = 0; j < attrs.length; j++) {
        var v = el.getAttribute('data-' + l + '-' + attrs[j])
        if (v !== null) el.setAttribute(attrs[j], v)
      }
      if (el.tagName === 'TITLE') el.textContent = el.getAttribute('data-' + l + '-title')
    }
    var b = document.getElementById('lang-btn')
    if (b) b.textContent = l === 'zh' ? 'English' : '中文'
  }

  root.setAttribute('data-lang', lang)
  document.addEventListener('click', function (e) {
    var el = e.target.closest ? e.target.closest('button') : null
    if (!el || el.id !== 'lang-btn') return
    var next = root.getAttribute('data-lang') === 'zh' ? 'en' : 'zh'
    root.setAttribute('data-lang', next); set('tapeapi.lang', next); apply()
  })
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply)
  else apply()
})()
