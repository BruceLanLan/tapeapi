// Read a body with a byte cap, whatever content-length says (a chunked body has none): count the bytes as they arrive
// and stop reading at the first chunk past the limit. Shared by the remote /mcp endpoint (mcp.js) and the signing
// proxies (mcp-proxy.js and openai-proxy.js: request bodies and upstream answers). Internal: not a package export.
// 按字节上限读取正文，不看 content-length（分块正文没有它）：边到边计数，超过上限的第一块就停止读取。远程 /mcp（mcp.js）
// 与两个签名代理（mcp-proxy.js、openai-proxy.js：请求正文和上游应答）共用。内部模块，不是包导出。
//
// No node: imports: runs in Workers and Node alike. / 不引用 node:，Workers 与 Node 都能运行。

/** The body is larger than the cap. / 正文超过上限。 */
export class TooLarge extends Error {
  constructor(limit) { super(`larger than ${limit} bytes`); this.name = 'TooLarge'; this.limit = limit }
}

/**
 * @param {ReadableStream<Uint8Array>|null|undefined} body
 * @param {number} limit  bytes
 * @returns {Promise<string>}  the body as UTF-8 text; throws TooLarge past `limit` / 超过上限抛出 TooLarge
 */
export async function readCapped(body, limit) {
  return new TextDecoder().decode(await readCappedBytes(body, limit))
}

/**
 * The same, as the exact bytes (what a hash must cover). With `signal`, an abort stops the read at once, whether or not
 * the body itself honours it. / 同上，返回确切字节（哈希必须覆盖的就是它们）。给了 signal 时，中止会立即停止读取，
 * 无论正文本身是否响应中止。
 * @param {ReadableStream<Uint8Array>|null|undefined} body
 * @param {number} limit  bytes
 * @param {{ signal?: AbortSignal }} [o]
 * @returns {Promise<Uint8Array>}
 */
export async function readCappedBytes(body, limit, { signal } = {}) {
  if (!body) return new Uint8Array(0)
  const reader = body.getReader()
  let onAbort = null
  const aborted = signal && new Promise((_, reject) => {
    // Reject first: cancelling settles the pending read as "done", which must not win the race.
    // 先拒绝：取消会把挂起的读取了结为"完成"，它不能赢得 race。
    onAbort = () => { reject(signal.reason ?? new Error('aborted')); reader.cancel().catch(() => { /* ignore */ }) }
    if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true })
  })
  aborted?.catch(() => { /* surfaced through the race below / 经由下面的 race 抛出 */ })
  const chunks = []; let n = 0
  try {
    for (;;) {
      const { done, value } = await (aborted ? Promise.race([reader.read(), aborted]) : reader.read())
      if (done) break
      n += value.byteLength
      if (n > limit) { try { await reader.cancel() } catch { /* ignore */ } throw new TooLarge(limit) }
      chunks.push(value)
    }
  } finally { if (onAbort) signal.removeEventListener('abort', onAbort) }
  const out = new Uint8Array(n); let o = 0
  for (const c of chunks) { out.set(c, o); o += c.byteLength }
  return out
}
