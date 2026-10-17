// @tapeapi/sdk/connect: `tapeapi connect` as data and text, for the command line and a web page alike. The WHOLE subpath
// is Experimental and outside the package's compatibility promise: it may change or go away in any minor version.
// It reads the chain and the manifest only; it asks for no key or password and sends no transaction.
import type { TapeAPI } from './index.js'

/** @experimental Text in English and Chinese. */
export interface Bilingual { en: string; zh: string }
/** @experimental A tool a settings snippet is written for. */
export type SnippetTool = 'openai-sdk' | 'curl' | 'codex' | 'claude-code'
/** @experimental One client setting: `via` 'sdk' (createVerifyingFetch in the caller's process), 'proxy' (through tapeapi-verify) or 'direct' (not checked); `verifies` is false for 'direct'. */
export interface Snippet { tool: SnippetTool; format: string; via: 'sdk' | 'proxy' | 'direct'; verifies: boolean; title: Bilingual; text: string }
/** @experimental Each tool and the API formats it needs; a tool gets a snippet only for a format the manifest declares. */
export declare const SNIPPET_TOOLS: Readonly<Record<SnippetTool, readonly string[]>>
/** @experimental The format names this SDK knows. */
export declare const FORMAT_NAMES: readonly string[]
/** @experimental The fixed sentences of every card: what a receipt proves, what a price is, the command's boundary, the token. */
export declare const NOTES: Readonly<{ receipt: Bilingual; prices: Bilingual; boundary: Bilingual; token: Bilingual }>
/**
 * @experimental Client settings for an AI service, only for the formats its manifest's ai.endpoints declares, in that
 * order. The token is never written: snippets read the environment variable API_KEY. Pure (no I/O).
 */
export declare function snippetsFor(manifest: { ai?: { endpoints?: { format: string; baseUrl: string }[]; models?: { id: string; formats?: string[] }[] } } | null | undefined, o?: {
  target?: string
  /** a development sidecar URL in place of `target` (testing only: no on-chain identity check) */
  dev?: string | null
  /** the local proxy's port (default 8790) */
  port?: number
  /** the command that starts the proxy (default `tapeapi connect <target> --proxy`) */
  proxyCommand?: string
  tool?: SnippetTool | 'all'
  format?: string
}): Snippet[]
/** @experimental What connectReport found: `exitCode` 0 usable, 1 unavailable (status and reason say why), 2 a usage mistake, 3 could not be read. */
export interface ConnectReport {
  target: string
  dev: boolean
  resolution: 'tap10' | 'dev'
  ok: boolean
  exitCode: 0 | 1 | 2 | 3
  /** 'ok', a TAP status ('unpaid', 'not-opened', 'store-changed', 'no-manifest', 'delegation-invalid', 'unavailable', ...), 'not-ai', 'ai-invalid' or 'not-declared' */
  status: string | null
  reason: Bilingual | null
  detail: string | null
  service: {
    name?: string | null
    tapeName?: string | null
    chainId?: number | null
    chain?: string | null
    container?: string | null
    holder?: string | null
    signer?: string | null
    delegationExpires?: number | null
    activation?: { live: boolean; isLive: boolean | null; isContainerLive: boolean } | null
    endpoints?: { format: string; baseUrl: string }[]
    models?: { id: string; aliases?: string[]; formats?: string[]; prices: Record<string, string>[] }[]
  } | null
  formats: string[]
  snippets: Snippet[]
}
/**
 * @experimental Resolve `target` with `api` (a client built with conform: 'tap10' shows unpaid, not-opened and
 * store-changed as such) and describe it; never throws for a service that cannot be used.
 */
export declare function connectReport(target: string | null, o: { api: Pick<TapeAPI, 'resolve'>; dev?: string | null; tool?: SnippetTool | 'all'; format?: string; port?: number; proxyCommand?: string }): Promise<ConnectReport>
/** @experimental The card as terminal text; colors only on the status words and headings; `next` ends any exit other than 0. */
export declare function renderConnect(report: ConnectReport, o?: { lang?: 'en' | 'zh' | 'both'; color?: boolean; version?: string; now?: number; next?: string | null; nextHint?: Bilingual | null }): string
