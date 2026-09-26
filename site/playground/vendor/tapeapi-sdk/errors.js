// TapeAPI 统一错误类型 / Unified error type carrying a machine-readable code.
export class TapeAPIError extends Error {
  constructor(code, message, extra) {
    super(message || code)
    this.name = 'TapeAPIError'
    this.code = code
    if (extra && typeof extra === 'object') Object.assign(this, extra)
  }
}
