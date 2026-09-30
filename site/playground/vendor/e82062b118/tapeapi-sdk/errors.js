// TapeAPI 统一错误类型 / Unified error type carrying a machine-readable code.
//
// Top-level fields are fixed for 1.x (review G1 M2): `name`, `code`, `message`, `data`, `signed`, `httpStatus`, `cause`,
// and on a signed provider error the TAPI-21 envelope fields `ts`, `block`, `id`, `sig`, `error`. Any other detail a
// thrower attaches goes into `data`. For code written against 0.x, each such key is also readable at the top level
// (`e.tooLarge`, `e.rpcCode`, `e.agreed`, ...) through a read-only, non-enumerable alias of `e.data[key]`; the aliases
// are deprecated and go in 2.0. Only a key given at the top level of `extra` gets an alias: one given inside `extra.data`
// has none (new code puts details in `data` and reads `e.data.*`), and an alias does not survive structuredClone or JSON.
// 顶层字段在 1.x 内固定；其它附加信息一律放进 `data`。为兼容 0.x 代码，这些键在顶层仍可读（只读、不可枚举的别名，指向
// `e.data[key]`）；别名已弃用，2.0 删除。只有写在 `extra` 顶层的键才有别名：写在 `extra.data` 里的没有（新代码把细节放进 `data`、
// 读 `e.data.*`）；别名经 structuredClone 或 JSON 之后不复存在。
const TOP_LEVEL_FIELDS = Object.freeze(['data', 'signed', 'httpStatus', 'cause', 'ts', 'block', 'id', 'sig', 'error'])
const TOP = new Set(TOP_LEVEL_FIELDS)
const RESERVED = new Set(['name', 'code', 'message', 'stack'])

export class TapeAPIError extends Error {
  constructor(code, message, extra) {
    const ex = extra && typeof extra === 'object' ? extra : null
    super(message || code, ex && ex.cause !== undefined ? { cause: ex.cause } : undefined)
    this.name = 'TapeAPIError'
    this.code = code
    if (!ex) return
    const rest = {}
    for (const [k, v] of Object.entries(ex)) {
      if (k === 'cause' || k === 'data' || RESERVED.has(k)) continue
      if (TOP.has(k)) this[k] = v
      else rest[k] = v
    }
    const moved = Object.keys(rest)
    if (!moved.length) { if (ex.data !== undefined) this.data = ex.data; return }
    const base = ex.data && typeof ex.data === 'object' && !Array.isArray(ex.data) ? ex.data : (ex.data === undefined ? {} : { value: ex.data })
    this.data = { ...base, ...rest }
    for (const k of moved) {
      Object.defineProperty(this, k, { get() { return this.data?.[k] }, enumerable: false, configurable: true })
    }
  }
}
