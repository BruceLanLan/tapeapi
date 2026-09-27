// Read a body with a byte cap, whatever content-length says (a chunked body has none): count the bytes as they arrive
// and stop reading at the first chunk past the limit. Shared by the remote /mcp endpoint (mcp.js) and the signing
// proxy (mcp-proxy.js, request bodies and upstream answers). Internal: not a package export.
// 按字节上限读取正文，不看 content-length（分块正文没有它）：边到边计数，超过上限的第一块就停止读取。远程 /mcp（mcp.js）
// 与签名代理（mcp-proxy.js，请求正文和上游应答）共用。内部模块，不是包导出。
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
  if (!body) return ''
  const reader = body.getReader()
  const chunks = []; let n = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    n += value.byteLength
    if (n > limit) { try { await reader.cancel() } catch { /* ignore */ } throw new TooLarge(limit) }
    chunks.push(value)
  }
  const out = new Uint8Array(n); let o = 0
  for (const c of chunks) { out.set(c, o); o += c.byteLength }
  return new TextDecoder().decode(out)
}
