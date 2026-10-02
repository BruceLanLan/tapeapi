#!/usr/bin/env node
// Regenerate sdk/src/processors-snapshot.js: the processor table (processor number -> processor contract) of every TapeOut
// chain, read-only, through the SDK's default nodes (rpc-defaults.js) with the operator quorum. Sends no transactions and
// costs nothing. Not part of `npm test` (it needs the network); run it before a release so the table is recent.
// 重新生成 sdk/src/processors-snapshot.js：各 TapeOut 链的处理器表（处理器号 -> 处理器合约），只读，经 SDK 默认节点与按运营方的
// 法定数读取。不发送任何交易，不花钱。不在 npm test 里（要联网）；发版前运行，使表格较新。
//
//   node scripts/gen-processors-snapshot.mjs              read all three chains and rewrite the file
//   node scripts/gen-processors-snapshot.mjs --check      read and compare with the file; exit 1 when it is not a prefix
//
// Why (TAP-10 §4.3): a container address or a processor contract#ID carries no processor number, and the factory has no
// reverse table, so a client scans factory.cpuAt(i). Cold, that is over a thousand eth_calls per node on BNB Smart Chain
// (1,174 processors on 2026-10-02), which public nodes rate-limit. The SDK ships this table, checks a hit with ONE cpuAt
// at the pinned block before using it, and scans only the numbers created after the snapshot (index.js,
// processorNumberOf). Numbers are append-only and never reused (TAP-10 §1), so an old table stays right, only shorter.
// 为什么（TAP-10 §4.3）：容器地址与处理器合约#ID 不带处理器号，工厂又没有反查表，客户端只能逐个扫 factory.cpuAt(i)。冷启动在 BNB
// 上每个节点要上千次 eth_call（2026-10-02 有 1,174 个处理器），公共节点会限流。SDK 随版本带这张表，命中后先在钉块上读一次 cpuAt
// 核实再用，只扫快照之后新建的编号。编号只增不减、永不复用，所以旧表仍然正确，只是短一些。
//
// Every chain's count is read at one TAP-10 pinned block (rpc.tap10Block, by its hash), the entries at later pinned
// blocks (see readTable); each value is agreed by nodes of two operators, and a chain that cannot be read in full is not
// written (no partial table). Pages of PAGE reads, PAUSE_MS apart, a rate-limited page read again after a pause: the rpc
// client batches the reads of a page per node.
// 每条链的 count 在一个 TAP-10 钉块（按哈希）上读取，各项在之后的钉块上读取（见 readTable）；每个值都须两家运营方的节点一致，
// 读不全的链不写（绝不写半张表）。每页 PAGE 个读取，页间隔 PAUSE_MS，被限流的页停顿后重读：rpc 客户端把一页的读取按节点合并为批量请求。
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRpc, CHAINS, CHAIN_IDS, rpcUrlsFor } from '../sdk/src/index.js'
import { encodeCall, decodeReturn } from '../sdk/src/abi.js'

const OUT = fileURLToPath(new URL('../sdk/src/processors-snapshot.js', import.meta.url))
const PAGE = 16
const PAUSE_MS = 600
const RETRIES = 6
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Read one chain's processor table at one pinned block. / 在一个钉块上读一条链的处理器表。 */
export async function readTable(chainId, { urls = rpcUrlsFor(chainId), log = () => {} } = {}) {
  const c = CHAINS[chainId]
  const rpc = createRpc({ urls, quorum: 2, timeoutMs: 20000, quiet: true })
  const got = Number(BigInt(await rpc.call('eth_chainId', [], { answers: 'tap10' })))
  if (got !== chainId) throw new Error(`chain ${chainId}: the nodes answer eth_chainId ${got}`)
  const b = await rpc.tap10Block({ maxLag: c.tap10MaxPinLag })
  const view = async (at, name, args) => decodeReturn(name, await rpc.ethCall(c.factory, encodeCall(name, args), { blockHash: at.hash, requireCanonical: true }, { answers: 'tap10' }))
  const count = Number(await view(b, 'cpuCount', []))
  // cpuAt(i) for i < count never changes (append-only), so the pages may be read at later pinned blocks: BNB Smart Chain
  // nodes keep the state of the last ~128 blocks only (about a minute; "missing trie node" after that), and a paced scan
  // of 1,174 entries takes longer. The table is recorded at `b`, where `count` was read.
  // i < count 时 cpuAt(i) 永不改变（只增不减），所以各页可以在更晚的钉块上读取：BNB 节点只保留最近约 128 个块的状态（约一分钟，
  // 之后答 "missing trie node"），而限速扫描 1,174 项要更久。表按读取 count 的块 b 记录。
  let pin = b
  const list = new Array(count)
  for (let from = 0, n = 0; from < count; from += PAGE, n++) {
    const idx = Array.from({ length: Math.min(PAGE, count - from) }, (_, k) => from + k)
    // A rate-limited page is read again after a growing pause, at a fresh pinned block (public nodes answer HTTP 429 in
    // bursts, measured 2026-10-02: blastapi and 48club after about 300 reads) / 被限流的页在逐渐加长的停顿后、在新钉块上重读
    let page
    for (let attempt = 0; ; attempt++) {
      try {
        if (n % 8 === 0 || attempt > 0) pin = await rpc.tap10Block({ maxLag: c.tap10MaxPinLag })
        page = await Promise.all(idx.map((i) => view(pin, 'cpuAt', [BigInt(i)])))
        break
      } catch (e) {
        if (attempt >= RETRIES || !['RPC_UNAVAILABLE', 'RPC_STALE'].includes(e?.code)) throw e
        log(`  ${chainId}: page ${from} not read (${e.message.slice(0, 80)}), again in ${(attempt + 1) * 5} s`)
        await sleep((attempt + 1) * 5000)
      }
    }
    idx.forEach((i, k) => { list[i] = String(page[k]).toLowerCase() })
    log(`  ${chainId}: ${Math.min(from + PAGE, count)} / ${count}`)
    if (from + PAGE < count) await sleep(PAUSE_MS)
  }
  if (new Set(list).size !== count || list.some((a) => !/^0x[0-9a-f]{40}$/.test(a))) throw new Error(`chain ${chainId}: the table has duplicates or bad entries`)
  return { chainId, factory: c.factory.toLowerCase(), block: b.number, blockHash: b.hash, count, operators: rpc.operators, list }
}

/** The module text. / 生成的模块文本。 */
export function render(tables, generatedAt) {
  const lines = []
  lines.push('// GENERATED by scripts/gen-processors-snapshot.mjs: do not edit by hand. / 由脚本生成，请勿手改。')
  lines.push('// The processor table of each TapeOut chain (TAP-10 §4.3: processor number -> processor contract), read-only: `count` at')
  lines.push('// the TAP-10 pinned block `block` / `blockHash`, the entries at later pinned blocks (cpuAt(i) never changes once i < count),')
  lines.push('// every value agreed by nodes of two different operators among `operators` (the default nodes, rpc-defaults.js). Used by')
  lines.push('// the conformance mode and siteStatus to find the processor number of a container address or a processor contract#ID: a')
  lines.push('// hit is checked with one factory.cpuAt at the pinned block before it is used, and only numbers past `count` are scanned.')
  lines.push('// Numbers are append-only (TAP-10 §1): an old table is still right, only shorter. Leaf module: no imports.')
  lines.push('// 各 TapeOut 链的处理器表（处理器号 -> 处理器合约），只读：count 在 TAP-10 钉块 block 上读取，各项在之后的钉块上读取（i < count 时')
  lines.push('// cpuAt(i) 不再改变），每个值都经 operators 中两家不同运营方的节点一致。一致模式与 siteStatus 用它找容器地址或处理器合约#ID 的')
  lines.push('// 处理器号：命中后先在钉块上读一次 cpuAt 核实，只扫 count 之后的编号。叶子模块。')
  lines.push(`// Generated ${generatedAt} (UTC).`)
  lines.push('')
  lines.push('const deepFreeze = (o) => { for (const v of Object.values(o)) if (v && typeof v === \'object\') deepFreeze(v); return Object.freeze(o) }')
  lines.push('')
  lines.push('/** chainId -> { chainId, factory, block, blockHash, count, generatedAt (UTC), operators, list }; list[i] is cpuAt(i), lowercase. */')
  lines.push('export const PROCESSORS_SNAPSHOT = deepFreeze({')
  for (const t of tables) {
    lines.push(`  ${t.chainId}: {`)
    lines.push(`    chainId: ${t.chainId}, factory: '${t.factory}', block: ${t.block}, blockHash: '${t.blockHash}', count: ${t.count}, generatedAt: '${generatedAt}',`)
    lines.push(`    operators: [${t.operators.map((o) => `'${o}'`).join(', ')}],`)
    lines.push('    list: [')
    for (let i = 0; i < t.list.length; i += 4) lines.push('      ' + t.list.slice(i, i + 4).map((a) => `'${a}'`).join(', ') + ',')
    lines.push('    ],')
    lines.push('  },')
  }
  lines.push('})')
  return lines.join('\n') + '\n'
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const check = process.argv.includes('--check')
  const tables = []
  for (const id of CHAIN_IDS) {
    try {
      const t = await readTable(id, { log: (s) => process.stderr.write(s + '\n') })
      console.log(`${CHAINS[id].name} (chain ${id}): ${t.count} processors at block ${t.block} (${t.blockHash}), operators ${t.operators.join(', ')}`)
      tables.push(t)
    } catch (e) { console.log(`chain ${id}: cannot read (${e.code ?? ''} ${e.message}); nothing written`); process.exit(1) }
  }
  if (check) {
    const { PROCESSORS_SNAPSHOT: old } = await import('../sdk/src/processors-snapshot.js')
    let bad = 0
    for (const t of tables) {
      const o = old[t.chainId]
      const prefix = o && o.factory === t.factory && o.count <= t.count && o.list.every((a, i) => a === t.list[i])
      console.log(`chain ${t.chainId}: snapshot ${o ? `${o.count} at block ${o.block}` : 'missing'}; chain ${t.count}; ${prefix ? 'a prefix (OK)' : 'NOT A PREFIX'}`)
      if (!prefix) bad++
    }
    process.exit(bad ? 1 : 0)
  }
  writeFileSync(OUT, render(tables, new Date().toISOString().replace(/\.\d+Z$/, 'Z')))
  console.log(`wrote ${OUT}`)
}
