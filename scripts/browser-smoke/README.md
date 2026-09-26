# Browser smoke test / 浏览器冒烟测试

Loads the **unbundled** SDK source into a real browser and runs the TAP-21 canonical-JSON and envelope vectors,
the TAP-26 channel vectors, and a live TAP-26 handshake keyed from the browser's own CSPRNG.
在真实浏览器里加载**未打包**的 SDK 源码，运行 TAP-21 规范 JSON 与信封向量、TAP-26 通道向量，以及一次用浏览器
自身安全随机数完成的真实 TAP-26 握手。

```
node scripts/browser-smoke/make-importmap.mjs      # regenerate importmap.json (and then index.html) after dependency changes
python3 -m http.server 8799 --directory .           # from the repo root
open http://localhost:8799/scripts/browser-smoke/  # the tab title reads PASS <n> or FAIL <k>/<n>; window.__smoke holds details
```

`make-importmap.mjs` resolves bare specifiers with browser export conditions (browser > import > default), never
Node's, and fails if any module on the path imports a `node:` builtin. Last run (2026-09-22, Chromium): 43 checks
pass; 31 modules, ~400 KiB of source; ~22,000 1 KiB frames sealed and opened per second.
`make-importmap.mjs` 按浏览器的导出条件解析裸说明符，从不使用 Node 的条件；路径上任何模块导入 `node:` 内建模块都会失败。
