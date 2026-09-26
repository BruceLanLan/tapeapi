// A meter that survives a restart: the newest voucher per (consumer, provider), kept in one JSON file.
// The in-memory default loses every unsettled voucher when the process stops, which is money.
// 重启不丢的计量存储：每个 (消费者, 提供者) 的最新凭证，放在一个 JSON 文件里。
// 默认的内存存储在进程停止时会丢掉所有未结算凭证，那是钱。
//
// ONE process only. `advance` is atomic here because Node runs one turn at a time, and the file is replaced by
// rename; two processes sharing the file would both meter the same voucher. Several instances need a store with
// an atomic compare-and-set (examples/cloudflare-worker/d1-store.js does this with one UPDATE).
// 仅限单进程。`advance` 在这里是原子的（Node 单线程 + 重命名替换文件）；两个进程共用同一文件会各自计量同一张凭证。
// 多实例需要带原子比较并设置的存储（Worker 的 D1 存储用一条 UPDATE 实现）。
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const key = (consumer, provider) => `${String(consumer).toLowerCase()}|${String(provider).toLowerCase()}`

export function fileStore(path) {
  let rows = new Map()
  try {
    for (const r of JSON.parse(readFileSync(path, 'utf8'))) rows.set(key(r.consumer, r.provider), r)
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
    mkdirSync(dirname(path), { recursive: true })
  }
  let writing = null
  const flush = () => {
    // Written to a sibling file and renamed: a crash mid-write leaves the previous meter, never half a file.
    // A failed write is reported and retried; it must neither crash the process nor stop later writes (review L-2).
    // 先写同目录临时文件再重命名。写失败要报告并重试，既不能让进程崩溃，也不能让之后的写入停止。
    writing = null
    const tmp = `${path}.${process.pid}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify([...rows.values()], null, 1) + '\n')
      renameSync(tmp, path)
      return true
    } catch (e) {
      console.error(`[meter] cannot write ${path}: ${e.message}; retrying in 1 s`)
      writing = setTimeout(flush, 1000); writing.unref?.()
      return false
    }
  }
  const save = () => { if (!writing) writing = setTimeout(flush, 50).unref?.() ?? setTimeout(flush, 50) }
  return {
    path,
    async get(consumer, provider) { return rows.get(key(consumer, provider)) || null },
    async set(consumer, provider, record) { rows.set(key(consumer, provider), record); save() },
    /** monotonic compare-and-set: a late, lower cumulative never overwrites a higher one / 单调写入 */
    async advance(consumer, provider, record) {
      const k = key(consumer, provider)
      const cur = rows.get(k)
      if (cur && BigInt(cur.cumulative) >= BigInt(record.cumulative)) return false
      rows.set(k, record); save()
      return true
    },
    async all() { return [...rows.values()] },
    /** write pending changes now (before exit) / 立刻落盘（退出前调用） */
    flush() { if (writing) clearTimeout(writing); return flush() },
  }
}
