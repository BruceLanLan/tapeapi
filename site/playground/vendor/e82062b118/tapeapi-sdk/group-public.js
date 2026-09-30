// The root `group` namespace: the public face of TAPI-27 private groups (review RC-7). group.js also exports senderKey and
// buildEpoch, the key derivation and the epoch builder the handles use; the test vectors and the audits call them
// directly, and they are not part of the API.
// 根命名空间 group：TAPI-27 私密群聊的公开接口。group.js 另外导出的 senderKey 与 buildEpoch（句柄内部使用的密钥派生与纪元构造）
// 只供测试向量与审计测试直接调用，不属于公开接口。
export {
  FUTURE_SKEW_S, GROUP_INVITE_KIND, KEEP_PREVIOUS_MS, MAX_EPOCH, MAX_EPOCH_AGE_S, MAX_MEMBERS, MAX_PLAINTEXT, MAX_WIRE,
  ROSTER_KIND, VERIFY_CONCURRENCY, WIRE_EPOCH, WIRE_MESSAGE, createGroup, groupRoom, joinGroup, openGroupInvite, resumeGroup,
} from './group.js'
// @experimental TAPI-27 §3.8 (format 2, up to 128 members): outside the 1.x stability promise; may change in a minor release.
// @experimental TAPI-27 §3.8（格式 2，至多 128 人）：不在 1.x 稳定性承诺之内，小版本中可能改变。
export { FORMAT_V2_MARK, MAX_MEMBERS_V2, VERIFY_NEGATIVE_S, VERIFY_REUSE_S, channelKeysVerifier } from './group.js'
