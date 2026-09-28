// The root `group` namespace: the public face of TAP-27 private groups (review RC-7). group.js also exports senderKey and
// buildEpoch, the key derivation and the epoch builder the handles use; the test vectors and the audits call them
// directly, and they are not part of the API.
// 根命名空间 group：TAP-27 私密群聊的公开接口。group.js 另外导出的 senderKey 与 buildEpoch（句柄内部使用的密钥派生与纪元构造）
// 只供测试向量与审计测试直接调用，不属于公开接口。
export {
  FUTURE_SKEW_S, GROUP_INVITE_KIND, KEEP_PREVIOUS_MS, MAX_EPOCH, MAX_EPOCH_AGE_S, MAX_MEMBERS, MAX_PLAINTEXT, MAX_WIRE,
  ROSTER_KIND, WIRE_EPOCH, WIRE_MESSAGE, createGroup, groupRoom, joinGroup, openGroupInvite, resumeGroup,
} from './group.js'
