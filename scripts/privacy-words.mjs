// The words ruled out of public copy (2026-09-28: "anonymous", "untraceable",
// "private payments", "zero-knowledge", "quantum-safe", "proves which model", "no logs", "evade bans"), in Chinese and
// English. The English patterns skip the negations the copy uses on purpose ("does not prove which model").
// Shared by scripts/privacy-copy.test.mjs and scripts/privacy-logs.test.mjs.
// 隐私计划禁止出现在对外文案里的词（中英两种说法）。英文模式跳过文案里有意使用的否定说法。两份测试共用。
export const FORBIDDEN = Object.freeze([
  /匿名/, /不可追踪/, /隐私支付/, /零知识/, /量子安全/, /证明是哪个模型/, /不记日志/, /规避封禁/,
  /\banonym/i, /\buntraceabl/i, /\bprivate payments?\b/i, /\bzero[- ]knowledge\b/i, /\bquantum[- ](safe|secure|proof|resistant)\b/i,
  /\bno[- ]logs?\b/i, /\bnot log(ged|ging)? anything\b/i, /(?<!not |n't )\bproves? which (model|program)\b/i, /\bevad\w* [\w' ]{0,40}\bbans?\b/i,
])
/** The patterns a text matches ([] when clean). / 文本命中的模式（干净时为空）。 */
export function forbiddenIn(text) { return FORBIDDEN.filter((re) => re.test(text)).map(String) }
