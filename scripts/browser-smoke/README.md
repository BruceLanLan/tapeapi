# Browser smoke test / 浏览器冒烟测试

Loads the **unbundled** SDK source into a real browser and runs the TAP-21 canonical-JSON and envelope vectors,
the TAP-26 channel vectors, and a live TAP-26 handshake keyed from the browser's own CSPRNG. Then it loads the site's
pages that run scripts ("My services", the playground, the receipt checker, the holder console, the status page) in
iframes and fails if one throws while loading: `probe.mjs` re-imports a page's module script inside the page, which
rejects with the page's own error.
在真实浏览器里加载**未打包**的 SDK 源码，运行 TAP-21 规范 JSON 与信封向量、TAP-26 通道向量，以及一次用浏览器
自身安全随机数完成的真实 TAP-26 握手。随后在 iframe 里加载站点上运行脚本的页面（我的服务、调试台、回执核验页、持有人
操作台、状态页），任何一个在加载时抛错就失败：`probe.mjs` 在页面内重新导入它的模块脚本，以页面自己的错误拒绝。

```
node scripts/browser-smoke/make-importmap.mjs      # regenerate importmap.json (and then index.html) after dependency changes
python3 -m http.server 8799 --directory .           # from the repo root
open http://localhost:8799/scripts/browser-smoke/  # the tab title reads PASS <n> or FAIL <k>/<n>; window.__smoke holds details
```

`make-importmap.mjs` resolves bare specifiers with browser export conditions (browser > import > default), never
Node's, and fails if any module on the path imports a `node:` builtin. Last run (2026-09-29, Chromium): 52 checks
pass, including the five pages; with `timeoutMs` put back into "My services" (the RC-1 bug) it reads FAIL 1/52. After
editing a page, reload with the browser cache bypassed: the pages' `?v=` stamps change only with `npm run build:assets`.
`make-importmap.mjs` 按浏览器的导出条件解析裸说明符，从不使用 Node 的条件；路径上任何模块导入 `node:` 内建模块都会失败。
