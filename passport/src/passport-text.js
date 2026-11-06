// @tapeapi/passport: the fixed sentences of §12 (D-1 to D-7), in English (the draft's own sentences, which its vectors
// pin byte for byte) and Chinese (ours). No sentence says "verified agent", certified, official or trusted, and none
// carries a check mark or a badge (D-7); tests check both languages.
// §12 的固定句子：英文是草案原句（向量逐字钉住），中文是我们的。任何句子都不出现 D-7 禁用的词、勾号或徽章；测试对两种语言都检查。

/** D-7: words and marks no passport text may show, in any state. / 任何状态都不得出现的词与符号。 */
export const DISPLAY_FORBIDDEN = Object.freeze(['verified agent', 'certified', 'official', 'trusted', '✓', '✔', '✅'])

/** The line every output carries. / 每次输出都附带的一行。 */
export const PASSPORT_NOTES = Object.freeze({
  experimental: Object.freeze({
    en: 'Experimental: resolved under the Agent Passport draft (TAPs pull request #83 at head cae25e6, open, not merged). A passport says only that one wallet holds both tokens and that the holder published the link; it does not say which code the agent runs, nor that it is honest or safe.',
    zh: '实验性：按 Agent Passport 草案（TAPs PR #83，头 cae25e6，未合并）解析。护照只说明同一个钱包持有两枚代币、且持有人公布了这一关联；不说明 agent 运行什么代码，也不说明它诚实或安全。',
  }),
  receipt: Object.freeze({ en: 'A receipt proves only what its signer says.', zh: '回执只证明签名方所说的内容。' }),
  holderText: Object.freeze({
    en: "The identity's name, description and image and every text of the registration file are the holder's statements, shown as plain text.",
    zh: '身份的 name、description、image 与登记文件里的全部文字都是持有人的陈述，按纯文本显示。',
  }),
})

const ZH_REASON = Object.freeze({
  'no-such-agent': '没有这个 agent 身份', 'holder-mismatch': '身份与电路不属于同一个持有人', 'no-passport-key': '身份没有 tap.passport 键',
  'bad-passport-key': 'tap.passport 键的格式不对', 'chain-mismatch': 'tap.passport 键写的是另一条链', 'not-tapeout': '不是 TapeOut 电路',
  'no-such-token': '这枚电路不存在', 'not-opened': '电路的容器尚未开通', 'registration-file-missing': '容器站点里没有登记文件',
  'registration-file-too-large': '登记文件超过 65,536 字节', 'registration-file-incomplete': '登记文件的大小或 SHA-256 与站点存储不符',
  'registration-file-no-hash': '登记文件没有在站点存储里声明 SHA-256', 'registration-file-invalid': '登记文件不合草案的格式',
  'forbidden-name': '登记文件的 tap 成员里有禁用的名字', 'file-chain-mismatch': '登记文件的 tap 成员与链上不一致',
  'tape-service-missing': '登记文件缺少 tape 服务条目', 'stale-operator': '有一位早先持有人设置的站点操作员仍然有效',
  'not-listed': '持有人的登记文件没有列出这个身份', 'key-circuit-mismatch': 'tap.passport 键指向的是另一枚电路',
  'wrong-chain': '节点不在 BNB 链上', 'stale-block': '钉住的区块太旧', 'node-disagreement': '节点的回答不一致', unavailable: '节点没有给出足够的一致回答',
  'registry-changed': 'ERC-8004 身份注册表的实现已经改变', 'store-changed': '站点存储的实现已经改变',
})
/** A reason in Chinese; an unknown name is shown as it is (the draft only ever adds names). / 原因的中文；不认识的名字原样显示。 */
export const reasonZh = (r) => ZH_REASON[r] ? `${ZH_REASON[r]}（${r}）` : r

/**
 * D-1 to D-6 for a result: { en, zh }. `en` is the draft's sentence exactly.
 * 结果的显示文字：{ en, zh }；en 与草案原句完全一致。
 */
export function displayOf(res) {
  const s = res.state
  if (s === 'CONFIRMED') {
    let en = `TapeOut passport ${res.name} (container ${res.container}) for agent ${res.agentId}, confirmed at block ${res.pinnedBlock}`
    let zh = `TapeOut 护照成立：${res.name}（容器 ${res.container}），agent ${res.agentId}，于块 ${res.pinnedBlock} 读取`
    if (res.warnings.includes('operators-not-checked')) { en += '; site operators not checked'; zh += '；站点操作员未检查' }
    const ep = res.holderEpoch
    if (ep === null) { en += '; holder history not checked'; zh += '；持有人历史未检查' }
    else { en += `; identity registered at block ${ep.identityRegisteredBlock}`; zh += `；身份登记于块 ${ep.identityRegisteredBlock}` }
    if (ep && ep.changed) {
      en += `; holder changed at block ${ep.startBlock}: earlier reputation does not belong to the current holder`
      zh += `；持有人于块 ${ep.startBlock} 变更：此前的声誉不属于当前持有人`
    }
    return { en, zh }
  }
  if (s === 'BROKEN') return { en: `not a passport: ${res.reasons[0]}`, zh: `不是护照：${reasonZh(res.reasons[0])}` }
  if (s === 'AMBIGUOUS') return { en: "ambiguous: the holder's site lists several agent identities for this registry", zh: '有歧义：持有人的站点为这个注册表列出了多个 agent 身份' }
  if (s === 'wallet-unset') return { en: 'not confirmed: the agent wallet is unset (the identity changed hands); the holder can set it again', zh: '尚未确认：agent 钱包未设置（身份曾经换手）；持有人可以自己重新设置' }
  if (s === 'stale-agent-wallet') return { en: 'not confirmed: the agent wallet differs from the holder', zh: '尚未确认：agent 钱包与持有人不同' }
  return { en: `could not verify: ${res.reasons[0]}`, zh: `无法核对：${reasonZh(res.reasons[0])}；没有任何内容得到核对` }
}

// Code points a person does not see, removed from a holder's text before display (D-7): format characters (Cf: bidi
// controls, zero-width, tags), default-ignorable code points, and C0/C1 controls other than a line feed or a tab. The
// same classes as the SDK's invisibleProblems (mcp.js); here they are removed, not refused.
// 显示持有人文字前去掉人看不见的码点：格式字符（Cf：双向控制、零宽、标签）、Default_Ignorable 码点，以及换行、制表符以外的
// C0/C1 控制符。与 SDK mcp.js 的 invisibleProblems 同一类字符；这里是去掉，不是拒绝。
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]|(?![\n\t])\p{Cc}/gu
/**
 * A holder's statement for display: plain text, invisible and control code points removed, at most `max` code points.
 * 持有人的陈述用于显示：纯文本，去掉不可见与控制字符，至多 max 个码点。
 */
export function holderText(text, max = 280) {
  if (typeof text !== 'string') return null
  const cps = [...text.replace(INVISIBLE, '')]
  return cps.length > max ? cps.slice(0, max).join('') + '…' : cps.join('')
}
