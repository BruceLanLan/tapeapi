// A clock far from any UTC day boundary, for tests whose windows are UTC days or months (the 3.0 budget, policy
// windows): Date.now runs at real speed but starts at 12:00:00 UTC, so a run shorter than 12 hours never crosses a
// midnight, and a test that checks "N calls in one day" cannot see two days. Unlike deterministic.mjs it does not stop
// time (deadlines, back-offs and timeouts still elapse), and it is shared with child processes: noonClock() puts the
// offset in TAPEAPI_TEST_CLOCK_SHIFT_MS, and a child started with `--import <this file>` and that variable installs the
// same offset, so parent and child read one timeline.
// 远离 UTC 日界的时钟，供以 UTC 日或月为窗口的测试使用（3.0 预算、策略窗口）：Date.now 按真实速度走，但从 UTC 12:00:00 开始，
// 12 小时以内的运行绝不跨午夜，"一天 N 次"的测试不会看到两天。与 deterministic.mjs 不同，它不让时间停止（截止、退避、超时照常），
// 并与子进程共用：偏移写在 TAPEAPI_TEST_CLOCK_SHIFT_MS，子进程以 --import 加载本文件即装上同一偏移，父子读同一条时间线。

const VAR = 'TAPEAPI_TEST_CLOCK_SHIFT_MS'
const realNow = Date.now

function install(shift) {
  Date.now = () => realNow() + shift
  return () => { Date.now = realNow }
}

/**
 * Install the noon clock in this process (noon UTC of the real day, or `day` as YYYY-MM-DD) and return
 * { shift, env, importArgs, restore }: `env` and `importArgs` start a child on the same clock.
 * 在本进程装上正午时钟，返回启动同一时钟子进程所需的 env 与 importArgs。
 */
export function noonClock({ day } = {}) {
  const base = day ? Date.parse(`${day}T12:00:00Z`) : (() => { const d = new Date(realNow()); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12) })()
  const shift = base - realNow()
  process.env[VAR] = String(shift)
  const restore = install(shift)
  return { shift, env: { [VAR]: String(shift) }, importArgs: ['--import', new URL(import.meta.url).href], restore }
}

if (typeof process !== 'undefined' && process.env[VAR] !== undefined && Date.now === realNow) install(Number(process.env[VAR]))
