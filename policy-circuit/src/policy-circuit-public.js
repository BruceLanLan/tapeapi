// @tapeapi/policy-circuit — @experimental policy circuits (version 0.1.0): re-run a spending rule written as a tapnet/1
// circuit, following the Policy Circuit Gate TAP draft (TAPs pull request #84, a draft PR, not merged; pinned at its head 0b73174).
// A counterparty that checks a binding can see for itself whether a request is inside the rule its principal signed.
// Boundaries: it constrains only the parties that check it (the agent's wallet may ignore it); it is not a signing
// guardrail; bindings to a mandate (TAP-18, from #47: merged as a Draft, merging is not adoption) or an escrow session (#59, #60:
// submitted, in review) are `conditional` at best, never enforceable, since the rules for their binders rest on drafts that
// can still change, and the escrow contract is not audited and not deployed; nothing is deployed for it
// and nothing here sends a transaction. Everything exported is experimental and may change or go away in any release.
// 实验性：策略电路（0.1.0）。按 Policy Circuit Gate TAP 草稿（TAPs PR #84，目前是 draft PR，未合并，钉在 0b73174）重跑写成 tapnet/1 电路的支出规则。
// 边界：只约束去核查它的一方（代理的钱包可以不理会它）；不是签名护栏；绑定在授权书或托管会话上的结果至多"有条件"，从不报可强制执行；
// 没有任何部署，本包不发送任何交易。全部导出都是实验性的，任何版本都可能改动或移除。
export {
  PolicyCircuitError, POLICY_CONVENTION, POLICY_N_IN, POLICY_N_OUT, MAX_POLICY_BYTES, POLICY_REASONS, policyReasonName,
  policyNetlistHash, checkPolicyCircuit, loadPolicyCircuit, interpretPolicyOutput,
} from './tapnet.js'
export {
  POLICY_KINDS, checkPolicyTables, policyTablesHash, checkPolicyRequest, policyRequestFields, policyRequestWord,
  decodePolicyWord, evaluatePolicyRequest, evalPolicyFile, replayPolicyTrace,
} from './policy-word.js'
export {
  POLICY_HUB, POLICY_BINDING_TYPE, POLICY_REVOCATION_TYPE, POLICY_BINDING_TYPEHASH, POLICY_REVOCATION_TYPEHASH,
  POLICY_SUBJECT_KINDS, MAX_REVOKED_POLICY_HASHES, POLICY_BINDING_DEFAULT_WINDOW_S, POLICY_BINDING_MAX_DEFAULT_WINDOW_S,
  policyDomainSeparator, policyBindingHash, policyRevocationHash, checkPolicyBindingForm, checkPolicyRevocationForm,
  policyRevocationCovers, policySubject, checkPolicyBinding, verifyPolicyBinding, choosePolicyBinding,
  policyBindingTypedData, policyRevocationTypedData, checkTokenPolicyMember, checkSubjectPolicyMember,
} from './policy-binding.js'
export {
  POLICY_TRACE_VERSION, memoryPolicyTraceStore, policyTraceFileStore, policyBinderFromApi, createPolicyGate,
} from './policy-gate.js'
