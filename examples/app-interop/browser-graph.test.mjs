// examples/app-interop: app A (and B's handlers) can run as plain browser / Worker modules. Their own files import only
// the SDK's main entry, the package @tapeapi/interop (whose own graph interop/test/interop.test.mjs walks) and each other, and use nothing Node-only; the SDK's main entry graph is walked with the same
// check the playground build uses (scripts/build-playground.mjs graph(): it throws on node:, require() or a dynamic import).
// This is a static check: nothing here was loaded in a browser.
// A（以及 B 的处理器）能作为普通浏览器 / Worker 模块运行：自己的文件只导入 SDK 主入口与彼此，不用任何仅限 Node 的东西；
// SDK 主入口的导入图用调试台构建的同一个检查遍历。这是静态检查，没有真的在浏览器里加载。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { graph, importsOf } from '../../scripts/build-playground.mjs'

const OWN = ['app-a.mjs', 'app-b.mjs']
const SDK = ['@tapeapi/sdk', '@tapeapi/interop']
const read = (f) => readFileSync(new URL(f, import.meta.url), 'utf8')
const code = (f) => read(f).replace(/\/\*[^]*?\*\/|\/\/[^\n]*/g, '')   // comments removed / 去掉注释

test('app A and B\'s handlers import only @tapeapi/sdk (and @tapeapi/interop) and each other, and use nothing Node-only', () => {
  for (const f of OWN) {
    const specs = importsOf(read(f))
    for (const s of specs) assert.ok(SDK.includes(s) || OWN.includes(s.replace(/^\.\//, '')), `${f} imports ${s}`)
    assert.doesNotMatch(code(f), /from\s*['"]node:|\brequire\s*\(|\bimport\s*\(|\bBuffer\b|\bprocess\./, f)
  }
})

test('the SDK main entry (what app A imports) has a browser-plain import graph', () => {
  const g = graph()
  assert.ok(g.files.has('sdk/src/index.js'))
  assert.ok(g.files.size > 10)
})
