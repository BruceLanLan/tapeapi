// Language and theme, remembered per viewer. Storage may throw (private window), so every
// access is guarded and the page renders correctly without it.
// 语言与主题按访问者记忆。存储可能抛错（隐私窗口），因此每次访问都有保护，且无存储时页面照常显示。
(function () {
  var root = document.documentElement;
  function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  var lang = get('tapeapi.lang');
  if (lang !== 'zh' && lang !== 'en') {
    var nav = (navigator.languages && navigator.languages[0]) || navigator.language || 'en';
    lang = /^zh/i.test(nav) ? 'zh' : 'en';
  }
  // <html lang> and the tab title follow the language too (screen readers, bookmarks).
  // <html lang> 与标签页标题也随语言切换（读屏软件、书签）。
  var TITLE = { en: document.title, zh: 'TapeAPI — 每次 AI 调用，都附一张签名回执' };
  function setLang(l) {
    root.setAttribute('data-lang', l);
    root.lang = l === 'zh' ? 'zh-CN' : 'en';
    document.title = TITLE[l];
  }
  setLang(lang);

  var theme = get('tapeapi.theme');
  if (theme === 'dark' || theme === 'light') root.setAttribute('data-theme', theme);

  function label() {
    var l = document.getElementById('lang-btn');
    if (l) l.textContent = root.getAttribute('data-lang') === 'zh' ? 'English' : '中文';
    var t = document.getElementById('theme-btn');
    if (t) {
      var explicit = root.getAttribute('data-theme');
      t.textContent = explicit === 'dark' ? 'Light' : explicit === 'light' ? 'Dark' : 'Theme';
    }
  }
  document.addEventListener('click', function (e) {
    var el = e.target.closest ? e.target.closest('button') : null;
    if (!el) return;
    if (el.id === 'lang-btn') {
      var next = root.getAttribute('data-lang') === 'zh' ? 'en' : 'zh';
      setLang(next); set('tapeapi.lang', next); label();
    }
    if (el.id === 'theme-btn') {
      var cur = root.getAttribute('data-theme');
      var dark = cur ? cur === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
      var nt = dark ? 'light' : 'dark';
      root.setAttribute('data-theme', nt); set('tapeapi.theme', nt); label();
    }
  });
  label();
})();
