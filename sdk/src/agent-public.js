// @tapeapi/sdk/agent — @experimental (1.7) container agents, phase 0 ("zero-contract loop"). Everything this subpath
// exports is experimental and outside the 2.x compatibility promise: the formats follow the public Ideas
// TapeOutProtocol/TAPs#40 (mandate) and #41 (task protocol, agent listing) and may change with that discussion.
// Phase 0 has no enforcement: a mandate is a holder's signed statement, every check says `enforcement: 'none'`, a
// mandate naming any amount is refused, and payment is a plain transfer verified read-only (TAP-10 §19).
// Designed in internal notes (container agents, phase 0). Phase 1 (experimental, local chains only, internal design
// notes, phase 1): a mandate that names funds is checked against its escrow channels only when the
// caller asks ({ enforcement: 'escrow-channel' }); without it every check is phase 0, exactly as in 1.8.
export {
  AGENT_FORMAT_VERSION, MODE_PAY, MODE_SPEND, VERDICT_ACCEPT, VERDICT_REJECT, MAX_SCOPE_ITEMS, MAX_REVOKED_HASHES,
  SCOPE_TYPE, MANDATE_TYPE, TASK_OFFER_TYPE, TASK_VERDICT_TYPE, MANDATE_REVOCATION_TYPE,
  SCOPE_TYPEHASH, MANDATE_TYPEHASH, TASK_OFFER_TYPEHASH, TASK_VERDICT_TYPEHASH, MANDATE_REVOCATION_TYPEHASH,
  taskHashOf, jsonHashOf,
  phase0Problems, OFFER_FEE_WARNING, MANDATE_PHASE0_NOTICE, MANDATE_FUNDED_WARNING, forWallet,
  phase1Problems, phase1Warnings, mandateNamesFunds, ENFORCEMENT_ESCROW_CHANNEL, MANDATE_ESCROW_CHANNEL_WARNING,
  DEFAULT_FUNDING_PATH, FUNDING_PATHS,
  normalizeMandate, hashScope, hashMandate, mandateDigest, mandateHashOf, mandateTypedData, signMandate,
  normalizeTaskOffer, hashTaskOffer, taskOfferDigest, offerHashOf, taskOfferTypedData, signTaskOffer,
  normalizeTaskVerdict, hashTaskVerdict, taskVerdictDigest, verdictHashOf, taskVerdictTypedData, signTaskVerdict,
  normalizeMandateRevocation, hashMandateRevocation, mandateRevocationDigest, mandateRevocationTypedData, signMandateRevocation,
} from './agent-sig.js'
export {
  createAgentKit, plainText, revocationFileBytes, agentMessageProblem, hashOnlyReceiptProblem, MANDATES_KEY, MANDATES_LIMIT, MANDATES_FORMAT, MAX_MANDATE_S, REVOCATION_ISSUED_SKEW_S,
  THREAD_KINDS, RESERVED_KINDS, KIND_PREFIX, TASK_STATES, EVIDENCE_PROVES, EVIDENCE_DOES_NOT_PROVE,
  withdrawRequestLive, WITHDRAW_COOLDOWN_S, WITHDRAW_WINDOW_S,
} from './agent-verify.js'
export {
  createPaymentKit, paymentOrder, encodeContent, decodeContent, checkAssetAttachment, describeTx,
  SENT_TOPIC, TRANSFER_TOPIC, ATTACHMENT_STALE_S, ATTACHMENT_CROWDED, MAX_ATTACHMENTS, INBOX_PAGE_MAX, PENDING_WINDOW_BLOCKS,
  ATTACHMENT_RESULTS, TRANSFER_SELECTOR, EXECUTE_SELECTOR,
  escrowPlan, ESCROW_PLAN_PATHS, MAX_SESSION_S, closeOutPlan, planApplied, sessionHistory, sessionEntry, EXECUTE_FEE_SELECTOR,
  createSpendLimiter, spendDecision, spendRecheck, spendPin, spendRecord, SPEND_REFUSALS, SPEND_STOPS, SPEND_RECORD_VERSION, SPEND_DEFAULT_CALL_PRICE_PERCENT,
  spendResume, SPEND_RESUME_REFUSALS,
  spendStatement, spendEvidence, SPEND_EVIDENCE_PROBLEMS, SPEND_EVIDENCE_WARNINGS,
} from './agent-pay.js'
export { validateAgentMember, AGENT_PRICING_MODES, AGENT_MAX_TASKS, AGENT_MAX_CAPABILITIES } from './manifest.js'
export {
  passphraseKeyVault, keyVaultKey, keyVaultSeal, keyVaultOpen, keyVaultParse, keyVaultAad, spendKeyContext,
  KEY_VAULT_VERSION, KEY_VAULT_SCRYPT, KEY_VAULT_SALT_BYTES, KEY_VAULT_NONCE_BYTES, KEY_VAULT_MIN_PASSPHRASE, KEY_VAULT_PREFIX,
} from './agent-vault.js'
