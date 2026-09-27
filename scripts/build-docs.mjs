#!/usr/bin/env node
// Build the documentation site (tapeapi.fun/docs/) from the markdown guides, so GitHub and the site say the same thing.
// 由 markdown 指南生成文档站（tapeapi.fun/docs/），保证 GitHub 与网站内容一致。
//
//   node scripts/build-docs.mjs          writes site/docs/ (commit the result: Pages runs no build)
//                                        写出 site/docs/（请提交生成结果：Pages 不执行构建）
//
// The source of truth is docs/guides/*.md, docs/guides/zh-CN/*.md and CHANGELOG.md. The output is deterministic (no
// timestamps), and scripts/build-docs.test.mjs fails when the committed site/docs/ differs from a fresh build.
// No dependencies and no external resources: the renderer covers the markdown the guides use, and nothing more.
// 唯一来源是 docs/guides/*.md、docs/guides/zh-CN/*.md 与 CHANGELOG.md。输出是确定性的（无时间戳）；已提交的
// site/docs/ 与重新构建不一致时，scripts/build-docs.test.mjs 失败。无依赖、无外部资源：渲染器只覆盖指南用到的 markdown。
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, statSync, existsSync } from 'node:fs'
import { join, dirname, relative, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const OUT = 'site/docs'
const REPO = 'https://github.com/BruceLanLan/tapeapi'

// Sidebar: groups of pages, in order. `src` is per language; the changelog is English only.
// 侧边栏：按顺序分组。`src` 按语言给出；更新日志只有英文。
export const LANGS = {
  en: { html: 'en', label: 'English', docs: 'Docs', onThisPage: 'On this page', search: 'Search the docs', noResults: 'No results', prev: 'Previous', next: 'Next', edit: 'Edit this page on GitHub', menu: 'Menu', home: 'Home', theme: 'Theme', light: 'Light', dark: 'Dark', copy: 'Copy', copied: 'Copied', other: 'zh', otherLabel: '中文' },
  zh: { html: 'zh-CN', label: '中文', docs: '手册', onThisPage: '本页内容', search: '搜索手册', noResults: '没有结果', prev: '上一篇', next: '下一篇', edit: '在 GitHub 上编辑此页', menu: '目录', home: '首页', theme: '主题', light: '浅色', dark: '深色', copy: '复制', copied: '已复制', other: 'en', otherLabel: 'English' },
}
export const GROUPS = [
  { en: 'Getting started', zh: '开始', pages: ['index', 'public-api', 'consume', 'provide'] },
  { en: 'Features', zh: '功能', pages: ['channels', 'agents'] },
  { en: 'Help', zh: '帮助', pages: ['faq', 'changelog'] },
]
const SOURCES = {
  index: { en: 'docs/guides/introduction.md', zh: 'docs/guides/zh-CN/introduction.md' },
  'public-api': { en: 'docs/guides/public-api.md', zh: 'docs/guides/zh-CN/public-api.md' },
  consume: { en: 'docs/guides/consume.md', zh: 'docs/guides/zh-CN/consume.md' },
  provide: { en: 'docs/guides/provide.md', zh: 'docs/guides/zh-CN/provide.md' },
  channels: { en: 'docs/guides/channels.md', zh: 'docs/guides/zh-CN/channels.md' },
  agents: { en: 'docs/guides/agents.md', zh: 'docs/guides/zh-CN/agents.md' },
  faq: { en: 'docs/guides/faq.md', zh: 'docs/guides/zh-CN/faq.md' },
  changelog: { en: 'CHANGELOG.md', zh: 'CHANGELOG.md' },
}
const ORDER = GROUPS.flatMap((g) => g.pages)

// ── markdown ────────────────────────────────────────────────────────────────────────────────────────────────────
export const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
const plain = (html) => unesc(html.replace(/<[^>]+>/g, ''))
const CJK = /[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/
// Hard-wrapped lines join with a space, except between two CJK characters. / 硬换行以空格连接，两个中文字符之间除外。
const joinLines = (lines) => lines.map((l) => l.trim()).reduce((a, l) => (!a ? l : CJK.test(a.at(-1)) && CJK.test(l[0]) ? a + l : `${a} ${l}`), '')

export function slug(text, used) {
  const base = text.toLowerCase().replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-') || 'section'
  let s = base, n = 2
  while (used.has(s)) s = `${base}-${n++}`
  used.add(s)
  return s
}

// Inline: code spans first (their content is literal), then links, bold, emphasis. / 行内：先代码（内容按字面），再链接、粗体、斜体。
export function inline(text, ctx) {
  const held = []
  const hold = (html) => `\u0000${held.push(html) - 1}\u0000`
  let s = text.replace(/`([^`]+)`/g, (_, c) => hold(`<code>${esc(c)}</code>`))
  s = esc(s)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
    const h = ctx.href(href.replace(/&amp;/g, '&'))
    const ext = /^https?:/.test(h)
    return hold(`<a href="${esc(h)}"${ext ? ' rel="noopener"' : ''}>${label}</a>`)
  })
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?![*\w])/g, '$1<em>$2</em>')
  // A held piece may hold another (a code span inside a link label), so restore until none is left. / 占位可嵌套，反复还原。
  while (/\u0000\d+\u0000/.test(s)) s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => held[i])
  return s
}

const FENCE = /^(\s*)```(\w*)\s*$/
const LIST = /^(\s*)([-*]|\d+\.)\s+(.*)$/
const HEAD = /^(#{1,4})\s+(.*)$/
const isTableSep = (l) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(l)
const cells = (l) => {
  const out = []; let cur = '', code = false
  const t = l.trim().replace(/^\|/, '').replace(/\|$/, '')
  for (const ch of t) { if (ch === '`') code = !code; if (ch === '|' && !code) { out.push(cur.trim()); cur = '' } else cur += ch }
  out.push(cur.trim())
  return out
}
const indentOf = (l) => l.match(/^\s*/)[0].length

// Blocks. `ctx` carries the link resolver and the heading list. / 块级。ctx 携带链接解析器与标题列表。
export function blocks(lines, ctx) {
  const out = []
  let i = 0
  const blank = (l) => l === undefined || l.trim() === ''
  while (i < lines.length) {
    const l = lines[i]
    if (blank(l)) { i++; continue }
    let m
    if ((m = l.match(FENCE))) {
      const ind = m[1].length, lang = m[2], body = []
      i++
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { body.push(lines[i].slice(Math.min(ind, indentOf(lines[i])))); i++ }
      i++
      out.push(`<div class="code"><pre${lang ? ` data-lang="${esc(lang)}"` : ''}><code>${esc(body.join('\n'))}</code></pre></div>`)
      continue
    }
    if ((m = l.match(HEAD))) {
      const level = m[1].length, html = inline(m[2], ctx)
      const id = slug(html, ctx.ids)
      ctx.headings.push({ level, id, html, text: plain(html) })
      out.push(level === 1 ? `<h1 id="${id}">${html}</h1>` : `<h${level} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true">#</a>${html}</h${level}>`)
      i++; continue
    }
    if (l.trim().startsWith('|') && isTableSep(lines[i + 1] || '')) {
      const head = cells(l); i += 2
      const rows = []
      while (i < lines.length && lines[i].trim().startsWith('|')) { rows.push(cells(lines[i])); i++ }
      const th = head.map((c) => `<th>${inline(c, ctx)}</th>`).join('')
      const tb = rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c, ctx)}</td>`).join('')}</tr>`).join('')
      out.push(`<div class="table"><table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div>`)
      continue
    }
    if (/^\s*>/.test(l)) {
      const q = []
      while (i < lines.length && /^\s*>/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, '')); i++ }
      out.push(`<blockquote>${blocks(q, ctx)}</blockquote>`)
      continue
    }
    if ((m = l.match(LIST))) {
      const base = m[1].length, ordered = /\d/.test(m[2])
      const items = []
      while (i < lines.length) {
        const lm = lines[i].match(LIST)
        if (!lm || lm[1].length !== base || /\d/.test(lm[2]) !== ordered) break
        const contentIndent = base + lm[2].length + 1
        const body = [lm[3]]
        i++
        while (i < lines.length) {
          const x = lines[i]
          if (blank(x)) {
            // A blank line continues the item only if indented content follows. / 空行后若有缩进内容，仍属本项。
            let j = i; while (j < lines.length && blank(lines[j])) j++
            if (j < lines.length && indentOf(lines[j]) >= contentIndent) { for (; i < j; i++) body.push(''); continue }
            break
          }
          const xm = x.match(LIST)
          if (xm && xm[1].length <= base) break
          if (indentOf(x) < contentIndent && (HEAD.test(x) || FENCE.test(x) || /^\s*[>|]/.test(x))) break
          body.push(indentOf(x) >= contentIndent ? x.slice(contentIndent) : x.trim())
          i++
        }
        const inner = blocks(body, ctx)
        // A tight item (one paragraph, maybe a nested list) renders without <p>. / 紧凑项不包 <p>。
        items.push(`<li>${inner.replace(/^<p>([^]*?)<\/p>(?=$|\n<[uo]l>)/, '$1')}</li>`)
      }
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`)
      continue
    }
    const para = []
    while (i < lines.length && !blank(lines[i]) && !FENCE.test(lines[i]) && !HEAD.test(lines[i]) && !/^\s*>/.test(lines[i]) &&
      !LIST.test(lines[i]) && !(lines[i].trim().startsWith('|') && isTableSep(lines[i + 1] || ''))) { para.push(lines[i]); i++ }
    out.push(`<p>${inline(joinLines(para), ctx)}</p>`)
  }
  return out.join('\n')
}

// ── links ───────────────────────────────────────────────────────────────────────────────────────────────────────
const PAGE_OF = new Map(Object.entries(SOURCES).flatMap(([page, s]) => Object.entries(s).map(([lang, p]) => [`${lang}:${p}`, page])))
const pageFile = (page) => (page === 'index' ? 'index.html' : `${page}.html`)

function resolver(src, lang) {
  return (href) => {
    if (/^(https?:|mailto:|#)/.test(href)) return href
    const [path, hash] = href.split('#')
    const target = posix.normalize(posix.join(posix.dirname(src), path))
    for (const l of [lang, ...Object.keys(LANGS).filter((x) => x !== lang)]) {
      const page = PAGE_OF.get(`${l}:${target}`)
      if (page) return `${l === lang ? '' : `../${l}/`}${pageFile(page)}${hash ? `#${hash}` : ''}`
    }
    if (target.startsWith('..')) throw new Error(`${src}: link ${href} leaves the repository`)
    const abs = join(ROOT, target)
    if (!existsSync(abs)) throw new Error(`${src}: link ${href} points to a missing file ${target}`)
    return `${REPO}/${statSync(abs).isDirectory() ? 'tree' : 'blob'}/main/${target.replace(/\/$/, '')}${hash ? `#${hash}` : ''}`
  }
}

// ── pages ───────────────────────────────────────────────────────────────────────────────────────────────────────
const SWITCH_LINE = /^\[(English|中文)\]\([^)]*\)\s*\|\s*(English|中文)\s*$/

export function renderPage(page, lang, read = (p) => readFileSync(join(ROOT, p), 'utf8')) {
  const src = SOURCES[page][lang]
  const lines = read(src).replace(/\r\n/g, '\n').split('\n').filter((l, n) => !(n < 3 && SWITCH_LINE.test(l.trim())))
  const ctx = { href: resolver(src, lang), headings: [], ids: new Set() }
  const body = blocks(lines, ctx)
  const h1 = ctx.headings.find((h) => h.level === 1)
  if (!h1) throw new Error(`${src}: no title`)
  // The changelog is English only; its Chinese sidebar entry still says what it is. / 更新日志只有英文，中文侧栏仍用中文名。
  const title = page === 'changelog' && lang === 'zh' ? '更新日志' : h1.text
  return { page, lang, src, title, body, headings: ctx.headings }
}

function sections(r) {
  // Plain-text sections for search: one per h2/h3, with the page title for h1 text. / 搜索用纯文本分段。
  const parts = r.body.split(/(?=<h[1-3] id=")/)
  return parts.map((html) => {
    const m = html.match(/^<h([1-3]) id="([^"]+)">/)
    const heading = m ? r.headings.find((h) => h.id === m[2]) : null
    const text = unesc(html.replace(/<a class="anchor"[^>]*>#<\/a>/g, '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
    return { p: pageFile(r.page), t: r.title, h: heading && heading.level > 1 ? heading.text : '', id: heading && heading.level > 1 ? heading.id : '', x: heading ? text.slice(heading.text.length).trim() : text }
  }).filter((s) => s.x || s.h)
}

const THEME_BOOT = `<script src="../docs.js"></script>`

function template(r, all) {
  const L = LANGS[r.lang]
  const idx = ORDER.indexOf(r.page)
  const prev = idx > 0 ? all.get(`${r.lang}:${ORDER[idx - 1]}`) : null
  const next = idx < ORDER.length - 1 ? all.get(`${r.lang}:${ORDER[idx + 1]}`) : null
  const nav = GROUPS.map((g) => `<div class="group"><p class="gtitle">${esc(g[r.lang])}</p><ul>${g.pages.map((p) => {
    const t = all.get(`${r.lang}:${p}`).title
    return `<li><a href="${pageFile(p)}"${p === r.page ? ' aria-current="page"' : ''}>${esc(t)}</a></li>`
  }).join('')}</ul></div>`).join('')
  const toc = r.headings.filter((h) => h.level === 2 || h.level === 3)
    .map((h) => `<li class="l${h.level}"><a href="#${h.id}">${h.html.replace(/<a [^>]*>|<\/a>/g, '')}</a></li>`).join('')
  const pn = `<nav class="pn">${prev ? `<a class="prev" href="${pageFile(prev.page)}"><span>${L.prev}</span>${esc(prev.title)}</a>` : '<span></span>'}${next ? `<a class="next" href="${pageFile(next.page)}"><span>${L.next}</span>${esc(next.title)}</a>` : '<span></span>'}</nav>`
  const other = LANGS[r.lang].other
  return `<!doctype html>
<html lang="${L.html}" data-lang="${r.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(r.title)} · TapeAPI ${L.docs}</title>
<meta name="description" content="${esc(sections(r)[0]?.x.slice(0, 160) || r.title)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="../docs.css">
<link rel="alternate" hreflang="${LANGS[other].html}" href="../${other}/${pageFile(r.page)}">
${THEME_BOOT}
</head>
<body data-page="${r.page}" data-other="../${other}/${pageFile(r.page)}" data-l-copy="${L.copy}" data-l-copied="${L.copied}" data-l-none="${L.noResults}" data-l-light="${L.light}" data-l-dark="${L.dark}" data-l-theme="${L.theme}">
<header class="top">
  <button class="ctl menu" id="menu-btn" type="button" aria-controls="side" aria-expanded="false">${L.menu}</button>
  <a class="brand" href="/">TAPEAPI</a><a class="section" href="index.html">${L.docs}</a>
  <div class="search"><input id="q" type="search" placeholder="${L.search}" aria-label="${L.search}" autocomplete="off"><div class="results" id="results" hidden></div></div>
  <span class="sp"></span>
  <a class="ctl" href="${REPO}" rel="noopener">GitHub</a>
  <button class="ctl" id="lang-btn" type="button" lang="${LANGS[other].html}">${LANGS[r.lang].otherLabel}</button>
  <button class="ctl" id="theme-btn" type="button">${L.theme}</button>
</header>
<div class="layout">
<nav class="side" id="side" aria-label="${L.docs}">${nav}</nav>
<main class="doc">
<article>
${r.body}
</article>
${pn}
<p class="edit"><a href="${REPO}/blob/main/${r.src}" rel="noopener">${L.edit}</a></p>
</main>
<aside class="toc">${toc ? `<p class="gtitle">${L.onThisPage}</p><ul>${toc}</ul>` : ''}</aside>
</div>
</body>
</html>
`
}

const LANDING = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>TapeAPI Docs</title>
<script>
// Pick the reader's language: the site's remembered choice, else the browser's. / 选语言：站点记住的选择，否则浏览器语言。
(function () {
  var l = null
  try { l = localStorage.getItem('tapeapi.lang') } catch (e) {}
  if (l !== 'zh' && l !== 'en') l = /^zh/i.test((navigator.languages && navigator.languages[0]) || navigator.language || '') ? 'zh' : 'en'
  location.replace(l + '/')
})()
</script>
</head>
<body>
<p><a href="en/">TapeAPI Docs (English)</a> · <a href="zh/">TapeAPI 手册（中文）</a></p>
</body>
</html>
`

// Every generated file under site/docs/, as a map of relative path -> content. docs.css and docs.js are written by hand
// in site/docs/ and are not generated. / site/docs/ 下全部生成文件；docs.css 与 docs.js 是手写的，不由此生成。
export const HAND_WRITTEN = new Set(['docs.css', 'docs.js'])
export function build(read) {
  const all = new Map()
  for (const lang of Object.keys(LANGS)) for (const page of ORDER) all.set(`${lang}:${page}`, renderPage(page, lang, read))
  const files = new Map()
  files.set('index.html', LANDING)
  for (const lang of Object.keys(LANGS)) {
    const idx = []
    for (const page of ORDER) {
      const r = all.get(`${lang}:${page}`)
      files.set(`${lang}/${pageFile(page)}`, template(r, all))
      idx.push(...sections(r))
    }
    files.set(`${lang}/search.json`, JSON.stringify(idx) + '\n')
  }
  return files
}

export function listFiles(dir, base = dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? listFiles(join(dir, e.name), base) : [relative(base, join(dir, e.name))])
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const files = build()
  const out = join(ROOT, OUT)
  for (const stale of listFiles(out)) { const p = stale.split('\\').join('/'); if (!files.has(p) && !HAND_WRITTEN.has(p)) rmSync(join(out, stale)) }
  for (const [p, c] of files) { mkdirSync(dirname(join(out, p)), { recursive: true }); writeFileSync(join(out, p), c) }
  console.log(`wrote ${files.size} files to ${OUT}/`)
}
