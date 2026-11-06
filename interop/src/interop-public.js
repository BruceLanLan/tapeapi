// @tapeapi/interop — @experimental visitor grants between apps: a visitor's wallet lets
// one app call a few methods of another app's TapeAPI service, for a short time, a bounded number of times, with no
// payment; the called service checks it and writes its record into its signed answer. Everything this package exports
// is experimental and outside the package's compatibility promise (2.x): it is a PROTOTYPE, not a TAP, whose format text
// is spec/TAPI-28.md (Experimental; where the two differ, the code is authoritative); no service knows the format, and it
// may change or go away in any minor release.
// Boundaries: every cross-app call is an off-chain request, so the calling site is no longer "100% on-chain";
// revocation and the count are enforced by the called service only (useless against a malicious one); before shells
// check it, the visitor must compare the caller named in the grant with the site the wallet says the request comes from.
// 实验性：访客授权。不受兼容承诺约束；是原型，不是规范、不是 TAP，没有任何服务认识它；任何次版本都可能改动或移除。
// 边界：跨应用调用都是链下请求；撤销与计数只由被调用方执行，对恶意服务无效；外壳把关之前，用户要自己比对两个名字。
export {
  GRANT_FORMAT_VERSION, GRANT_DOMAIN_NAME, GRANT_DOMAIN_VERSION, VISITOR_GRANT_TYPE, GRANT_REVOCATION_TYPE,
  VISITOR_GRANT_TYPEHASH, GRANT_REVOCATION_TYPEHASH, MAX_GRANT_METHODS, MAX_GRANT_CALLS, MAX_GRANT_LIFE_S,
  DEFAULT_GRANT_LIFE_S, GRANT_SKEW_S, MAX_REVOKED_GRANTS, MAX_USER_SIG_BYTES, METHOD_NAME_RE, CALL_PROOF_PREFIX,
  CALL_PROOF_PREIMAGE_BYTES, STATEMENT_TEMPLATES, STATEMENT_LANGS, GRANT_WALLET_NOTICE, GRANT_WALLET_NOTICE_ZH,
  normalizeGrant, renderStatement, statementMatches, grantDomain, grantDomainSeparator, hashVisitorGrant, grantDigest,
  grantHashOf, makeGrant, grantTypedData, grantForWallet, signGrant, normalizeGrantRevocation, hashGrantRevocation,
  grantRevocationDigest, grantRevocationTypedData, signGrantRevocation, callProofPreimage, callProofDigest,
  signCallProof, recoverCallProofSigner, wireGrant,
} from './interop-sig.js'
export {
  GRANT_REASONS, GRANT_REVOKE_METHOD, GRANT_RESULT_MEMBER, GRANT_HANDLER_TIMEOUT_MS, GRANT_ANSWER_KEEP_S, grantRefusal, grantReasonOf, grantManifestProblems,
  memoryGrantStore, chainReadsFromApi, verifyVisitorGrant, grantMethods, grantRevokeHandler, prepareGrant,
} from './interop-verify.js'
export { checkGrantRecord, withGrant } from './interop-call.js'
