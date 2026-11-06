// @tapeapi/passport/feedback (@experimental, OPTIONAL, CONDITIONAL on TAPs #54 at 703b2a9, NOT merged): §10 of the
// passport draft. Not loaded by the main entry; nobody has written such feedback yet.
// §10（可选、以未合并的 #54 为前提）。主入口不加载；还没有人写过这类反馈。
import type { PassportResult, PassportReads, PassportSnapshot, PassportConfig } from './passport.js'

export declare const FEEDBACK_DRAFT: Readonly<{ pr: 54; head: '703b2a91edf7545b3179a08b8041b49190fd4a0a'; merged: false; section: string; status: string }>
export declare const REVIEW_TYPEHASH: '0xb9c66a727a6fba79714dcc4f0dfdbaf876840b1a35de576ed8fe3eef1f1b9a0b'
export interface Review { reviewer: string; reviewee: string; kind: number; score: number; subject: string; evidenceHash: string; textHash: string; issued: number }
export declare function reviewHash(review: Review): string
export declare function reviewFileKey(reviewHash: string): string
/** §10.2: the giveFeedback arguments and the file to store first; building them sends nothing. */
export declare function feedbackParams(record: { review: Review; [k: string]: unknown }, agentId: number | string, reviewerName: string, gatewayDomain: string, level: 1 | 2): {
  agentId: number | string; value: number; valueDecimals: 0; tag1: 'tap-review'; tag2: string; endpoint: ''; feedbackURI: string; feedbackHash: string; fileKey: string; fileBytes: string
}
export interface FeedbackLevel { reviewers: number; holders: number; scores: Record<'1' | '2' | '3' | '4' | '5', number> }
export type FeedbackSummary =
  | { computed: false; why: string; draft: typeof FEEDBACK_DRAFT }
  | { computed: true; counted: string[]; excluded: { feedback: string; reason: string }[]; summary: { 'level-1': FeedbackLevel; 'level-2': FeedbackLevel }; outsideClientSet: number; earlierHolders: number; getSummaryClientAddresses: string[] | null; clientAddresses: string[]; draft: typeof FEEDBACK_DRAFT }
/** §10.3 F-0 to F-10 for a CONFIRMED passport; never a weighted or averaged score. */
export declare function summariseFeedback(reads: PassportReads, result: PassportResult, opts: { config?: PassportConfig; clientAddresses: string[]; maxEntries?: number | null; review54?: Record<string, { counted: boolean; level: number }>; feedback?: unknown[] }): Promise<FeedbackSummary>
export declare function summariseFeedbackFromSnapshot(snapshot: PassportSnapshot, result: PassportResult): Promise<FeedbackSummary>
