// WebMCP bridge: expose a resolved TapeAPI service's methods as tools an in-browser AI agent can call.
import type { Manifest } from './manifest.js'
import type { ResolveTarget, ResolvedService, Payer, TapeAPI } from './index.js'

export declare const DEFAULT_PREFIX: string
export declare const TOOL_NAME_RE: RegExp

export interface ToolDescriptor {
  name: string
  method: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
  annotations: { untrustedContentHint: boolean; consequentialHint: boolean; [key: string]: unknown }
  priceBEM: string
  /** Price in base units, as a decimal string. */
  price: string
  paid: boolean
}
export interface SkippedMethod { method: string; code: string; reason: string }

export interface ManifestToToolsOptions {
  prefix?: string
  container?: string
  dev?: boolean
  paid?: { maxPriceBEM: string | number; methods?: string[]; [key: string]: unknown }
  accepted?: Record<string, bigint | string | number>
  taken?: Set<string>
}

/** Pure: a TAP-20 manifest -> WebMCP tool descriptors (no execute, no DOM). */
export declare function manifestToTools(manifest: Manifest | Record<string, unknown>, opts?: ManifestToToolsOptions): { tools: ToolDescriptor[]; skipped: SkippedMethod[] }

export interface ExposeOptions {
  /** Explicit model context (tests, polyfills); default document.modelContext ?? navigator.modelContext. */
  modelContext?: unknown
  prefix?: string
  /** Absent: priced methods are NOT exposed. */
  paid?: {
    payer: Payer
    maxPriceBEM: string | number
    budgetBEM: string | number
    methods?: string[]
    confirm?: (req: { tool: string; method: string; priceBEM: string; params: unknown }) => boolean | Promise<boolean>
  }
  format?: 'mcp' | 'object'
  errors?: 'throw' | 'content'
  timeoutMs?: number
  onCall?: (event: { tool: string; method: string; ok: boolean; code?: string; priceBEM: string; [key: string]: unknown }) => void
}

/** Callable handle: calling it disposes (unregisters every tool). */
export interface ExposeHandle {
  (): void
  supported: boolean
  reason: string | null
  svc: ResolvedService | null
  tools: ToolDescriptor[]
  skipped: SkippedMethod[]
  spentBEM(): string
  refresh(): Promise<ExposeHandle>
  dispose(): void
}

/** Register one WebMCP tool per method of a TapeAPI service. */
export declare function exposeTapeAPI(api: TapeAPI, target: ResolveTarget | ResolvedService, opts?: ExposeOptions): Promise<ExposeHandle>

export declare function paramToSchema(notation: unknown, depth?: number): { schema: Record<string, unknown>; optional: boolean; known: boolean }
export declare function paramsToSchema(params: unknown, depth?: number): { schema: Record<string, unknown>; known: boolean }
export declare function sanitizePrefix(prefix: string): string
