// The passport lines shared by `tapeapi passport`, `tapeapi-doctor --passport`, `tapeapi connect --passport` and
// `tapeapi init --passport` (@experimental, 3.0). Pure, no import (so doctor.js and connect.js can use it without a
// cycle); the result it renders comes from the separate package @tapeapi/passport (TAPs #83 draft at cae25e6, not merged).
// tapeapi passport、doctor、connect、init 共用的护照文字（实验性，3.0）。纯函数、无导入；结果来自独立包 @tapeapi/passport。
const T = (en, zh) => ({ en, zh })

/**
 * What to say when @tapeapi/passport is not installed: it is a tgz on the same GitHub release as the SDK, installed after
 * the SDK's. The address is pinned (the tag is the SDK's version, the file name the package's own) and moved on release day
 * with every other release address. / 未安装 @tapeapi/passport 时的说明：它是同一 GitHub
 * 发布上的 tgz，在 SDK 之后安装。地址钉住（标签是 SDK 的版本，文件名是该包自己的版本），发布日与其它发布地址一并改。
 */
export const PASSPORT_MISSING = T('the passport resolver is a separate, experimental package, @tapeapi/passport, outside the compatibility promise; install it from the GitHub release the SDK came from, after the SDK: npm install https://github.com/BruceLanLan/tapeapi/releases/download/v3.0.0/tapeapi-passport-0.1.0.tgz',
  '护照解析器是独立的实验性包 @tapeapi/passport，不在兼容承诺之内；从 SDK 所在的同一个 GitHub 发布安装，先装 SDK：npm install https://github.com/BruceLanLan/tapeapi/releases/download/v3.0.0/tapeapi-passport-0.1.0.tgz')
const EXIT = { CONFIRMED: 0, BROKEN: 1, AMBIGUOUS: 1, 'wallet-unset': 1, 'stale-agent-wallet': 1, UNAVAILABLE: 3 }
/** Exit status of a result: 0 CONFIRMED, 1 not a passport (or not confirmed), 3 nothing could be read. / 结果的退出码。 */
export const passportExit = (res) => EXIT[res.state] ?? 1
const NO_PASSPORT = new Set(['registration-file-missing', 'not-listed'])

/** Text lines of one result, in `lang` (en, zh or both). / 一个结果的文字行。 */
export function passportLines(res, { lang = 'both', notes } = {}) {
  const P = (t) => (lang === 'en' ? [t.en] : lang === 'zh' ? [t.zh] : [t.en, t.zh])
  const L = (en, zh) => (lang === 'en' ? en : lang === 'zh' ? zh : `${en} / ${zh}`)
  const out = [`${L('state', '状态')}: ${res.state}${res.reasons.length ? ` (${res.reasons[0]})` : ''}`, ...P(res.display)]
  if (Array.isArray(res.agentId)) out.push(`${L('identities listed', '列出的身份')}: ${res.agentId.join(', ')}`)
  if (res.warnings.length) out.push(`${L('warnings', '警告')}: ${res.warnings.join(', ')}`)
  if (res.state === 'CONFIRMED') out.push(`${L('not checked', '未检查')}: ${[!res.checked.siteOperators && L('site operators', '站点操作员'), !res.checked.holderHistory && L('holder history', '持有人历史')].filter(Boolean).join(', ') || L('nothing', '无')}`)
  out.push(`${L('pinned block', '钉块')}: ${res.pinnedBlock ?? '-'}   ${L('draft', '草案')}: TAPs #${res.draft.pr} @ ${res.draft.head.slice(0, 7)} (${L('open, not merged', '未合并')})`)
  for (const n of notes ?? []) out.push(...P(n))
  return out
}

/**
 * The doctor's `passport` check for a result (not one of the 14; only with --passport): CONFIRMED pass, or warn with
 * what was not checked; no passport published: skip (a service needs none); any other state warn; UNAVAILABLE error.
 * doctor 的 passport 检查（不在 14 项之内，只在 --passport 时出现）。没发布护照：skip（服务不一定需要护照）。
 */
export function passportCheck(res) {
  const d = res.display
  if (res.state === 'CONFIRMED' && !res.warnings.length) return { status: 'pass', detail: d }
  if (res.state === 'CONFIRMED') return { status: 'warn', detail: T(`${d.en} (warnings: ${res.warnings.join(', ')})`, `${d.zh}（警告：${res.warnings.join('、')}）`), fix: T('Not checked is not passed: give log-capable nodes of two operators (tapeapi passport --logs-rpc) to check site operators and the holder history.', '没查不等于没问题：给出两家能查日志的节点（tapeapi passport --logs-rpc）才能检查站点操作员与持有人历史。') }
  if (res.state === 'UNAVAILABLE') return { status: 'error', detail: T(`could not decide: ${d.en}`, `无法判定：${d.zh}`), fix: T('The chain could not be read under strict agreement; run the doctor again (exit code 3 means: retry).', '链上读取未能达成严格共识；重新运行诊断（退出码 3 表示：重试）。') }
  if (res.state === 'BROKEN' && NO_PASSPORT.has(res.reasons[0])) return { status: 'skip', detail: T(`this service publishes no passport (${res.reasons[0]}); a service needs none`, `这个服务没有发布护照（${res.reasons[0]}）；服务不一定需要护照`) }
  return { status: 'warn', detail: d, fix: T('Only the holder can fix this, in their own wallet: see the states table at https://tapeapi.fun/docs/en/passport', '只有持有人能用自己的钱包修复：见 https://tapeapi.fun/docs/zh/passport 的状态表。') }
}
