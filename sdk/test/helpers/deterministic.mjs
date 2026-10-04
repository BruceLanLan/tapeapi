// A fixed clock and a seeded random source, for tests that record bytes: Date.now returns one instant and
// crypto.getRandomValues draws from a seeded generator (mulberry32), so salts, generated ids and receipt timestamps
// repeat run after run. Signatures are already deterministic (RFC 6979). `new Date()` without arguments is NOT affected.
// Imported with `node --import <this file>` and TAPEAPI_TEST_DETERMINISTIC=1 (and optionally TAPEAPI_TEST_SEED), it
// installs itself for the whole process (a child such as tapeapi-verify).
// 固定时钟与带种子的随机源，供录制字节的测试使用：Date.now 返回同一时刻，crypto.getRandomValues 取自带种子的生成器，盐、生成的 id
// 与回执时间戳每次运行都相同。签名本身已是确定的（RFC 6979）。不带参数的 new Date() 不受影响。以 --import 加载且设置
// TAPEAPI_TEST_DETERMINISTIC=1 时对整个进程生效（例如子进程 tapeapi-verify）。

/** The fixed instant, in ms (2026-09-21T14:13:20Z). / 固定时刻（毫秒）。 */
export const FIXED_MS = 1_790_000_000_000

/**
 * Install the fixed clock and the seeded random source; returns a function that restores both.
 * 安装固定时钟与带种子的随机源；返回恢复二者的函数。
 */
export function deterministic({ ms = FIXED_MS, seed = 1 } = {}) {
  const realNow = Date.now
  let s = seed >>> 0
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return (t ^ (t >>> 14)) >>> 0
  }
  Date.now = () => ms
  Object.defineProperty(globalThis.crypto, 'getRandomValues', {
    value: (a) => { const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength); for (let i = 0; i < b.length; i++) b[i] = next() & 0xff; return a },
    configurable: true, writable: true,
  })
  return () => { Date.now = realNow; delete globalThis.crypto.getRandomValues }
}

if (typeof process !== 'undefined' && process.env.TAPEAPI_TEST_DETERMINISTIC === '1') deterministic({ seed: Number(process.env.TAPEAPI_TEST_SEED ?? 1) })
