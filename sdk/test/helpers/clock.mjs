// Test clocks (FIXED P101-1). Date.now is the only clock sdk/src reads (no performance.now, hrtime or new Date()), so a
// test that replaces it controls every deadline, budget and back-off the code under test computes.
// 测试用时钟（FIXED P101-1）。Date.now 是 sdk/src 读取的唯一时钟，替换它，测试就掌握了被测代码算出的每个截止时间、预算与退避。
//
// virtualClock(): time stands still unless the test moves it (`advance`) or a simulated wait ends (`sleep`). Waits are
// events on one timeline: concurrent sleeps overlap (three parallel 3 ms waits take 3 ms, not 9), and the earliest ends
// first. What the code under test computes takes no time at all, so a result no longer depends on how busy the machine
// is: this is the idle machine the timing-dependent tests were written for.
// virtualClock()：除非测试推进（`advance`）或模拟的等待结束（`sleep`），时间静止。等待是同一时间轴上的事件：并发的等待互相重叠
// （三个并行的 3 ms 等待共 3 ms 而不是 9 ms），最早的先结束。被测代码的计算不耗时间，结果因此不再取决于机器多忙：
// 这正是那些依赖时间的测试所假设的空闲机器。
//
// loadedMachine(factor): the real clock running `factor` times fast, as a heavily loaded machine looks to code that
// measures elapsed time. A test run inside it fails if it still depends on the real clock.
// loadedMachine(factor)：真实时钟快 `factor` 倍，即高负载机器在测量耗时的代码眼中的样子。仍依赖真实时钟的测试在它里面会失败。
//
// Both save the Date.now they replace and put it back on restore(), so they nest (a virtual clock inside a loaded machine).
// 两者都保存被替换的 Date.now 并在 restore() 时放回，因此可以嵌套（高负载机器里的虚拟时钟）。

export function virtualClock({ start } = {}) {
  const prev = Date.now
  let t = start ?? prev()
  let seq = 0, queued = false
  const sleepers = []          // { at, seq, resolve }
  const tick = () => {
    queued = false
    if (!sleepers.length) return
    sleepers.sort((a, b) => a.at - b.at || a.seq - b.seq)
    const at = sleepers[0].at
    if (at > t) t = at
    // every wait ending at this instant, in the order they began / 此刻结束的所有等待，按开始顺序
    while (sleepers.length && sleepers[0].at <= t) sleepers.shift().resolve()
    if (sleepers.length) queue()
  }
  // setImmediate: after the promise jobs of whatever just woke, so waits it starts join the timeline first
  // setImmediate：在刚醒来者的 promise 任务之后，使它新开始的等待先加入时间轴
  const queue = () => { if (!queued) { queued = true; setImmediate(tick) } }
  Date.now = () => t
  return {
    now: () => t,
    advance(ms) { t += ms },
    sleep(ms) { return new Promise((resolve) => { sleepers.push({ at: t + Math.max(0, ms), seq: seq++, resolve }); queue() }) },
    restore() { Date.now = prev },
  }
}

export function loadedMachine(factor = 50) {
  const prev = Date.now
  const t0 = prev()
  Date.now = () => t0 + (prev() - t0) * factor
  return { restore() { Date.now = prev } }
}

// Runs fn with the clock installed and always restores it. / 装上时钟运行 fn，总是恢复。
export async function withClock(clock, fn) {
  try { return await fn(clock) } finally { clock.restore() }
}
