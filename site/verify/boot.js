// Theme and language before the first paint (a file, not an inline script: the page's policy allows scripts from this
// site only). Storage may throw in a private window. / 首次绘制前应用主题与语言（页面策略只允许本站脚本文件）。
;(function (r) {
  var get = function (k) { try { return localStorage.getItem(k) } catch (e) { return null } }
  var t = get('tapeapi.theme'); if (t === 'dark' || t === 'light') r.setAttribute('data-theme', t)
  var l = get('tapeapi.lang'); if (l !== 'zh' && l !== 'en') l = /^zh\b/i.test(navigator.language || '') ? 'zh' : 'en'
  r.setAttribute('data-lang', l); r.setAttribute('lang', l === 'zh' ? 'zh-CN' : 'en')
})(document.documentElement)
