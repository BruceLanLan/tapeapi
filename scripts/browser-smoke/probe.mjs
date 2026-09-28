// Injected into a site page loaded in an iframe by smoke.mjs. It imports the page's own module script by the exact URL
// the page used: the module map already holds it, so the import settles as the page's evaluation did, and rejects with
// the same error if that threw (a removed option, a bad import path: the whole page dead, as in RC-1).
// 由 smoke.mjs 注入到 iframe 里的站点页面。按页面自己用的同一个 URL 导入它的模块脚本：模块表里已有它，导入的结果与页面求值的结果
// 相同；页面求值时抛错（被删的选项、错的导入路径：整页失效，如 RC-1），导入就以同一个错误拒绝。
const tag = document.querySelector('script[type="module"][src]')
const post = (r) => parent.postMessage({ smokeProbe: location.pathname, ...r }, location.origin)
if (!tag) post({ ok: false, error: 'no module script on this page' })
else import(tag.src).then(() => post({ ok: true, script: tag.src }), (e) => post({ ok: false, script: tag.src, error: String(e && e.stack || e).slice(0, 300) }))
