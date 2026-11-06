// A seeded random source and a property runner for the prop-*.test.mjs files: no dependency, deterministic, replayable.
// The seed is hashed first (bus-fuzz, review R9-H1: consecutive raw seeds fed straight into xorshift32 draw the same
// early choices). A failing iteration rethrows with its seed in front, and the one-line command that replays exactly
// that iteration: PROP_SEED=<n> PROP_RUNS=1 node --test <file>.
// 供 prop-*.test.mjs 使用的带种子随机源与性质运行器：无依赖、确定、可重放。种子先哈希（bus-fuzz，R9-H1：连续的原始种子直接喂给
// xorshift32 会抽到相同的前几个选择）。失败的迭代把种子放在错误信息最前面，并给出只重放这一轮的命令。
import assert from 'node:assert/strict'

const mix = (x) => { x = (x + 0x9e3779b9) >>> 0; x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0; x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0; return (x ^ (x >>> 16)) >>> 0 }

/** xorshift32 over a hashed seed. / 哈希过的种子上的 xorshift32。 */
export function rng(seed) {
  let s = mix(seed >>> 0) || 1
  const next = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296 }
  const r = {
    f: next,
    /** 0..n-1 / 整数 0..n-1 */
    int: (n) => Math.floor(next() * n),
    /** lo..hi inclusive / 闭区间 */
    range: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (xs) => xs[Math.floor(next() * xs.length)],
    p: (x) => next() < x,
    bool: () => next() < 0.5,
    bytes: (n) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = Math.floor(next() * 256); return b },
    hex: (n) => '0x' + Array.from(r.bytes(n), (b) => b.toString(16).padStart(2, '0')).join(''),
    /** a BigInt below 2^bits / 小于 2^bits 的 BigInt */
    big: (bits) => { let v = 0n; for (let i = 0; i < bits; i += 16) v = (v << 16n) | BigInt(Math.floor(next() * 65536)); return v & ((1n << BigInt(bits)) - 1n) },
    /** a shuffled copy (Fisher-Yates) / 乱序副本 */
    shuffle: (xs) => { const a = xs.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [a[i], a[j]] = [a[j], a[i]] } return a },
    /** 1..max code points of a mixed alphabet (ASCII, CJK, emoji, quotes, backslash) / 混合字母表的字符串 */
    text: (max = 12) => { const n = 1 + Math.floor(next() * max); let o = ''; for (let i = 0; i < n; i++) o += r.pick(ALPHABET); return o },
  }
  return r
}
const ALPHABET = [...'abcxyzAZ019 _-.:/,;!?', '"', '\\', '\n', '\t', '中', '文', 'é', 'ß', '😀', ' ', '{', '}', '[', ']']

/** The seed of a run: PROP_SEED, else the file's default. / 一次运行的种子。 */
export const seedOf = (dflt) => (process.env.PROP_SEED !== undefined ? Number(process.env.PROP_SEED) >>> 0 : dflt >>> 0)
/** The iterations of a run: PROP_RUNS, else `dflt` (at least 200 in every prop file). / 迭代次数。 */
export const runsOf = (dflt = 200) => (process.env.PROP_RUNS !== undefined ? Math.max(1, Number(process.env.PROP_RUNS) | 0) : dflt)

/**
 * Run `body(r, i)` for `runs` iterations; iteration i draws from rng(seed + i). An assertion that fails is rethrown with
 * "seed=<seed+i> (iteration i of <runs>)" and the replay command in front of its message; the cause is kept.
 * `file` is import.meta.url of the test, for the command. Async bodies are awaited.
 * 运行 runs 轮，第 i 轮用 rng(seed + i)。失败时在信息最前面加上种子与重放命令，原错误作为 cause 保留。
 */
export async function forAll(file, body, { runs = runsOf(), seed = seedOf(1) } = {}) {
  const path = file.startsWith('file://') ? new URL(file).pathname : file
  for (let i = 0; i < runs; i++) {
    const s = (seed + i) >>> 0
    try { await body(rng(s), i) } catch (e) {
      const head = `[property] seed=${s} (iteration ${i} of ${runs}); replay: PROP_SEED=${s} PROP_RUNS=1 node --test ${path}`
      if (e instanceof assert.AssertionError || e instanceof Error) { e.message = `${head}\n${e.message}`; throw e }
      throw new Error(`${head}\n${String(e)}`, { cause: e })
    }
  }
}
