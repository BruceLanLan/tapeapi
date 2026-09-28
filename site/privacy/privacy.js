// The privacy page: theme and language before the first paint (a file, not an inline script: the page's policy allows
// scripts from this site only), then the two header buttons. Storage may throw in a private window.
// 隐私页：首次绘制前应用主题与语言（页面策略只允许本站脚本文件），再接上页头的两个按钮。隐私窗口里存储可能抛错。
(function () {
  var root = document.documentElement
  function get(k) { try { return localStorage.getItem(k) } catch (e) { return null } }
  function set(k, v) { try { localStorage.setItem(k, v) } catch (e) {} }
  var lang = get('tapeapi.lang')
  if (lang !== 'zh' && lang !== 'en') lang = /^zh/i.test((navigator.languages && navigator.languages[0]) || navigator.language || '') ? 'zh' : 'en'
  root.setAttribute('data-lang', lang)
  var theme = get('tapeapi.theme')
  if (theme === 'dark' || theme === 'light') root.setAttribute('data-theme', theme)
  function label() {
    var zh = root.getAttribute('data-lang') === 'zh'
    root.lang = zh ? 'zh-CN' : 'en'
    var l = document.getElementById('lang-btn'); if (l) l.textContent = zh ? 'English' : '中文'
    var t = document.getElementById('theme-btn')
    if (t) { var x = root.getAttribute('data-theme'); t.textContent = x === 'dark' ? (zh ? '浅色' : 'Light') : x === 'light' ? (zh ? '深色' : 'Dark') : (zh ? '主题' : 'Theme') }
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
  })
})()
