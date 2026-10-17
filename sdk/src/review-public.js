// @tapeapi/sdk/review — @experimental evidence-backed reviews between containers, published since 2.0.0. Everything
// this subpath exports is experimental and outside the 2.x compatibility promise: the format is the draft
// "Evidence-Backed Reviews between Containers" (TapeOutProtocol/TAPs pull request #54, tap TBD) and changes with it.
// A review is a public statement signed for a reviewer container by its current holder or delegate, optionally backed by
// a signed answer (level 1) or a task (level 2). Verification reads the chain; summaries count counterparties, never
// amounts, and are not proof of quality.
export {
  REVIEW_TYPE, REVIEW_TYPEHASH, REVIEW_KIND, WITHDRAWAL_KIND, REVIEW_ID_PREFIX, MAX_EVIDENCE_AGE_S, ISSUED_SKEW_S, MAX_TEXT_CODE_POINTS, MAX_TAGS,
  REVIEW_PUBLIC_NOTICE, ReviewFormError,
  endpointId, parseEndpoint, isTapeOutChain, normalizeReview, hashReview, reviewDigest, reviewHashOf, signReview, reviewTypedData,
  jsonHash, textProblem, textHashOf, evidenceHashOf, reviewRequestId, subjectOf, makeReview,
} from './review-sig.js'
export {
  REVIEWS_KEY, REVIEWS_LIMIT, REVIEWS_FORMAT, REVIEW_PROBLEMS, REVIEW_PROVES, REVIEW_DOES_NOT_PROVE,
  checkReview, summarizeReviews, reviewTextForDisplay, reviewFileBytes, reviewMessageContent, createReviewKit,
} from './review-verify.js'
