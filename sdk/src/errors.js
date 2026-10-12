// TapeAPI 统一错误类型 / Unified error type carrying a machine-readable code.
//
// Top-level fields are fixed (review G1 M2): `name`, `code`, `message`, `data`, `signed`, `httpStatus`, `cause`, and on a
// signed provider error the TAPI-21 envelope fields `ts`, `block`, `id`, `sig`, `error`. Any other detail a thrower
// attaches goes into `data` and is read as `e.data.*`. 1.x also exposed each such key at the top level (`e.tooLarge`,
// `e.rpcCode`, `e.agreed`, ...) as a deprecated read-only alias; 2.0 removed the aliases (docs/guides/upgrade-2.0.md).
// 顶层字段固定；其它附加信息一律放进 `data`，读 `e.data.*`。1.x 还在顶层给这些键留了已弃用的只读别名（`e.tooLarge`、`e.rpcCode`、
// `e.agreed` 等）；2.0 删除了这些别名。
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
    if (!Object.keys(rest).length) { if (ex.data !== undefined) this.data = ex.data; return }
    const base = ex.data && typeof ex.data === 'object' && !Array.isArray(ex.data) ? ex.data : (ex.data === undefined ? {} : { value: ex.data })
    this.data = { ...base, ...rest }
  }
}
