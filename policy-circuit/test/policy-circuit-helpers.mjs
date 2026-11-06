// Helpers shared by the policy-circuit tests (not a test file itself). / 策略电路测试共用的辅助函数（本身不是测试文件）。
import { checkPolicyBindingWithSigners } from '../src/policy-binding.js'
// F3: two `ts` values are 2^64 - 1 and 2^64, JSON numbers. JSON.parse rounds them (2^64 - 1 would read as 2^64 and be
// refused). So integer literals of 16 digits or more are quoted before parsing: the API takes decimal strings for every
// integer member. (Written when the floor was Node 20, which has no source-text reviver; kept, it runs anywhere.)
// F3：两个 ts 是 JSON 数字 2^64 - 1 与 2^64。JSON.parse 会舍入。所以解析前给 16 位以上的整数字面量加引号：API 的每个整数成员
// 都接受十进制字符串。（写于下限还是 Node 20 时，它没有带源文本的 reviver；保留，因为在哪里都能跑。）
export function parseLossless(src) {
  let out = '', i = 0, key = null
  while (i < src.length) {
    const c = src[i]
    if (c === '"') {
      let j = i + 1
      while (src[j] !== '"') { if (src[j] === '\\') j++; j++ }
      key = src[j + 1] === ':' ? src.slice(i + 1, j) : null
      out += src.slice(i, j + 1); i = j + 1; continue
    }
    if (c === '-' || (c >= '0' && c <= '9')) {
      let j = i
      while (j < src.length && /[-+0-9.eE]/.test(src[j])) j++
      const tok = src.slice(i, j)
      // a table `unit` is never quoted: the vectors' "unit as integer" tables must stay a JSON number (tables-malformed)
      // 表里的 unit 不加引号：向量里"unit as integer"的表必须保持 JSON 数字（即 tables-malformed）
      out += key !== 'unit' && /^-?\d{16,}$/.test(tok) ? `"${tok}"` : tok
      i = j; continue
    }
    out += c; i++
  }
  return JSON.parse(out)
}

// F2, test-only: the draft's binding vectors were made by a reference that takes each revocation's `signer` AS GIVEN.
// Replaying them needs that rule, which the package does not offer (its checks recover the signer from the signature);
// so the tests reach the internal core directly, by path, which the package's `exports` map does not expose.
// F2，仅测试用：草稿的绑定向量由"信任给定撤销签名者"的参考实现生成。本包不提供这种模式（公开检查从签名恢复签名者），
// 测试按路径直接调用内部函数（包的 exports 映射不暴露它）。
export function checkPolicyBindingTrustingGivenSigners(chainId, binding, sig, tables, opts = {}) {
  return checkPolicyBindingWithSigners(chainId, binding, sig, tables, opts, (x) => String(x.signer ?? '').toLowerCase())
}
