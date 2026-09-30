export declare const FORBIDDEN_KEYS: Set<string>
/** The first key that appears twice in one JSON object of `text`, or null. */
export declare function findDuplicateKey(text: string): string | null
/** JSON.parse that refuses duplicate keys and prototype keys; throws TapeAPIError(code). */
export declare function safeParseJSON(text: string, opts?: { code?: string }): any
/** Canonical JSON (sorted keys, no whitespace) as signed in TAPI-21 envelopes. */
export declare function canonicalJSON(value: unknown): string
