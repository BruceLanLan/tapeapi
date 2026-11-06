// @tapeapi/passport — @experimental Agent Passport resolver. It follows an OPEN draft, TapeOutProtocol/TAPs pull request
// #83 at head cae25e6 (not merged; its text and vectors may change), and every result carries that head (`draft`).
// Everything here is outside any compatibility promise and may change or go away in any release.
// What it does: read-only, it decides whether one wallet holds both an ERC-8004 agent identity (the identity registry
// deployed on BNB Smart Chain, read through its public interface) and a TapeOut circuit, and published the link in the
// circuit container's site; the answer is one state word with one named reason. What it does not say: which code the
// agent runs, whether it is honest or safe. Nothing on mainnet resolves to CONFIRMED yet. The registries are
// upgradeable by their owner; an unknown implementation makes every result UNAVAILABLE.
// @tapeapi/passport：实验性的 Agent Passport 解析。依据未合并的草案 TAPs PR #83（头 cae25e6，文字与向量都可能变），每个结果都带着这个头。
// 不受任何兼容承诺约束。它只读地判断一个钱包是否同时持有 ERC-8004 身份与 TapeOut 电路、并在容器站点公布了这一关联；结果是一个状态词
// 加一个具名原因。它不说明 agent 运行什么代码、是否诚实或安全。主网上目前还没有任何护照解析为 CONFIRMED。注册表可由其 owner 升级。
import { TapeAPIError } from '@tapeapi/sdk'
import { Broken, decodeKey, resolve, snapshotReads, SNAPSHOT_FORMAT } from './passport-core.js'

export {
  DRAFT, PASSPORT_CONFIG, SNAPSHOT_FORMAT, PASSPORT_KEY, REGISTRATION_KEY, MANIFEST_KEY, REGISTRATION_TYPE, MAX_REGISTRATION_BYTES,
  STATES, REASONS, WARNINGS, CONFUSABLES, encodePassportKey, forbiddenName, normaliseName, strictJson, canonicalJson, JFloat, NoCanonicalForm,
  checkRuntimeCall, checkDelegationProposal, snapshotReads,
} from './passport-core.js'
export { DISPLAY_FORBIDDEN, PASSPORT_NOTES, displayOf, holderText, reasonZh } from './passport-text.js'
export { resolvePassport, liveReads, logsClient, snapshotOf, callOfKey, LOG_TOPICS, LOG_DEFAULTS, MAX_PROCESSOR_SCAN } from './passport-live.js'
export { buildRegistrationFile, checkRegistrationFile, canonicalAgentUri, preparePassportRegistration, registrationSteps } from './passport-registration.js'
export { agentCardFromPassport } from './passport-card.js'

/**
 * §4: the 96-byte tap.passport value -> { chainId, processor, tokenId }. Throws TapeAPIError INVALID_ARGUMENT whose
 * data.reason is the draft's name (no-passport-key, bad-passport-key).
 * §4：96 字节的 tap.passport 值。出错抛 INVALID_ARGUMENT，data.reason 为草案的名字。
 */
export function decodePassportKey(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TapeAPIError('INVALID_ARGUMENT', 'decodePassportKey: a Uint8Array')
  try { return decodeKey(bytes) } catch (e) {
    if (e instanceof Broken) throw new TapeAPIError('INVALID_ARGUMENT', e.message, { data: { reason: e.reason } })
    throw e
  }
}

/**
 * Replay a tap-agent-passport-snapshot/1 (the draft's vectors, or a live resolution's recordSnapshot) offline: the same
 * rules, the same result shape, no network. / 离线回放快照：同样的规则与结果，不联网。
 */
export async function resolveFromSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || snapshot.format !== SNAPSHOT_FORMAT) throw new TapeAPIError('INVALID_ARGUMENT', `resolveFromSnapshot: a ${SNAPSHOT_FORMAT} object`)
  return resolve(snapshotReads(snapshot), snapshot.input, snapshot.config)
}
