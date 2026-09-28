#!/usr/bin/env node
// Local token counting for the spot-check probe: a small byte-pair-encoding engine for the two published formats most
// open tokenizers use, with no npm dependency.
//   - tiktoken rank files (base64 token + rank per line): OpenAI o200k_base and cl100k_base, Moonshot Kimi K2;
//   - Hugging Face tokenizer.json, byte-level BPE (GPT-2 byte mapping, Split + ByteLevel pre-tokenizers, merge ranks,
//     ignore_merges): Meta Llama 3, Qwen2.5 / Qwen3, DeepSeek-V3, Zhipu GLM-4.5, Mistral Tekken (Nemo).
// The vocabulary files are NOT in the repository (2 MB to 20 MB each). `node tokenizers.mjs download` fetches them on
// demand from commit-pinned URLs into a cache directory and checks each file's sha256 before use; a file whose hash
// differs is refused. The probe itself never needs them: probes.json ships the expected counts of its fixed texts,
// computed with exactly these files (`node tokenizers.mjs check` recomputes them).
// Claude's and Gemini's tokenizers are not published and cannot be counted offline.
// 抽检探针的本地 token 计数：一个不依赖 npm 包的小型 BPE 引擎，支持大多数开源分词器使用的两种发布格式。词表文件不放进仓库，
// `node tokenizers.mjs download` 按需从钉死提交的地址下载到缓存目录，使用前核对 sha256，不符即拒绝。探针本身不需要它们：
// probes.json 自带固定文本的预期计数（`node tokenizers.mjs check` 可重算核对）。Claude 与 Gemini 的分词器未公开，无法离线计数。
//
//   node examples/spot-check/tokenizers.mjs download [family ...|all]   [--cache <dir>]
//   node examples/spot-check/tokenizers.mjs count <family> <text>       [--cache <dir>]
//   node examples/spot-check/tokenizers.mjs check [--write]             recompute probes.json's expected counts
//   node examples/spot-check/tokenizers.mjs list
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------------------------------------------
// The families / 分词器族
// ---------------------------------------------------------------------------------------------------------------
// Each pin is a file at an immutable address (the Azure blob whose sha256 tiktoken's own expected_hash pins, or a Hugging
// Face commit) and its
// sha256. `models` says which models the file was published with; "sameAs" lists other published tokenizers whose
// vocabulary, merges, pre-tokenizer and normaliser we compared and found identical to this one (2026-09-28).
// 每个钉住的文件都在不可变地址（tiktoken 自己钉住的 Azure blob，或 Hugging Face 的某次提交），并附 sha256。
const HF = (repo, commit, file = 'tokenizer.json') => `https://huggingface.co/${repo}/resolve/${commit}/${file}`
// Case-insensitive contractions, spelled out: JavaScript (Node 22) has no inline (?i:...) group. ſ (U+017F) folds to s.
// 大小写不敏感的缩写，逐字展开：Node 22 的正则不支持 (?i:...)。
const CONTRACTIONS = "'[sSſ]|'[tT]|'[rR][eE]|'[vV][eE]|'[mM]|'[lL][lL]|'[dD]"
export const FAMILIES = Object.freeze({
  o200k: {
    kind: 'tiktoken', label: 'OpenAI o200k_base',
    models: 'GPT-4o, GPT-4.1, GPT-5 family, o-series (o200k_base per tiktoken); gpt-oss uses o200k_harmony, the same ranks plus special tokens',
    url: 'https://openaipublic.blob.core.windows.net/encodings/o200k_base.tiktoken',
    sha256: '446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d', bytes: 3613922,
    pattern: `[^\\r\\n\\p{L}\\p{N}]?[\\p{Lu}\\p{Lt}\\p{Lm}\\p{Lo}\\p{M}]*[\\p{Ll}\\p{Lm}\\p{Lo}\\p{M}]+(?:${CONTRACTIONS})?|[^\\r\\n\\p{L}\\p{N}]?[\\p{Lu}\\p{Lt}\\p{Lm}\\p{Lo}\\p{M}]+[\\p{Ll}\\p{Lm}\\p{Lo}\\p{M}]*(?:${CONTRACTIONS})?|\\p{N}{1,3}| ?[^\\s\\p{L}\\p{N}]+[\\r\\n/]*|\\s*[\\r\\n]+|\\s+(?!\\S)|\\s+`,
    flags: 'gu',
  },
  cl100k: {
    kind: 'tiktoken', label: 'OpenAI cl100k_base',
    models: 'GPT-4, GPT-4 Turbo, GPT-3.5 Turbo, text-embedding-3 (cl100k_base per tiktoken)',
    url: 'https://openaipublic.blob.core.windows.net/encodings/cl100k_base.tiktoken',
    sha256: '223921b76ee99bde995b7ff738513eef100fb51d18c93597a113bcffe865b2a7', bytes: 1681126,
    // tiktoken's pattern uses possessive quantifiers; here they change nothing (the classes cannot overlap), so they are dropped.
    // tiktoken 的模式用了占有量词；在这里去掉不改变结果（相邻字符类不重叠）。
    pattern: "'(?:[sSſdDmMtT]|[lL][lL]|[vV][eE]|[rR][eE])|[^\\r\\n\\p{L}\\p{N}]?\\p{L}+|\\p{N}{1,3}| ?[^\\s\\p{L}\\p{N}]+[\\r\\n]*|\\s+$|\\s*[\\r\\n]|\\s+(?!\\S)|\\s",
    flags: 'gu',
  },
  'kimi-k2': {
    kind: 'tiktoken', label: 'Moonshot Kimi K2',
    models: 'Kimi K2 (moonshotai/Kimi-K2-Instruct tiktoken.model)',
    url: HF('moonshotai/Kimi-K2-Instruct', 'fd1984e2b7a3350dbf7305fe73a4ede25c14de50', 'tiktoken.model'),
    sha256: 'b6c497a7469b33ced9c38afb1ad6e47f03f5e5dc05f15930799210ec050c5103', bytes: 2795286,
    // tokenization_kimi.py's pattern; its class intersections (&&[^\p{Han}]) become v-mode set subtraction.
    // 取自 tokenization_kimi.py；其字符类交集写成 v 模式的集合差。
    pattern: `[\\p{Script=Han}]+|[^\\r\\n\\p{L}\\p{N}]?[[\\p{Lu}\\p{Lt}\\p{Lm}\\p{Lo}\\p{M}]--\\p{Script=Han}]*[[\\p{Ll}\\p{Lm}\\p{Lo}\\p{M}]--\\p{Script=Han}]+(?:${CONTRACTIONS})?|[^\\r\\n\\p{L}\\p{N}]?[[\\p{Lu}\\p{Lt}\\p{Lm}\\p{Lo}\\p{M}]--\\p{Script=Han}]+[[\\p{Ll}\\p{Lm}\\p{Lo}\\p{M}]--\\p{Script=Han}]*(?:${CONTRACTIONS})?|\\p{N}{1,3}| ?[^\\s\\p{L}\\p{N}]+[\\r\\n]*|\\s*[\\r\\n]+|\\s+(?!\\S)|\\s+`,
    flags: 'gv',
  },
  llama3: {
    kind: 'hf', label: 'Meta Llama 3',
    models: 'Llama 3, 3.1, 3.2, 3.3 (128k vocabulary)',
    // meta-llama/* is gated; this is an ungated copy. sameAs: unsloth/Llama-3.2-1B-Instruct@5a8abab4 (identical model and pre-tokenizer).
    // meta-llama 的仓库需要申请访问；这是公开的副本，与 unsloth/Llama-3.2-1B-Instruct 的词表、合并与预分词完全相同。
    url: HF('NousResearch/Meta-Llama-3-8B-Instruct', '53346005fb0ef11d3b6a83b12c895cca40156b6c'),
    sha256: 'e134af98b985517b4f068e3755ae90d4e9cd2d45d328325dc503f1c6b2d06cc7', bytes: 9085698,
    sameAs: ['unsloth/Llama-3.2-1B-Instruct@5a8abab4a5d6f164389b1079fb721cfab8d7126c'],
  },
  qwen2: {
    kind: 'hf', label: 'Qwen2.5 / Qwen3',
    models: 'Qwen2.5, Qwen3 (151k vocabulary)',
    url: HF('Qwen/Qwen2.5-7B-Instruct', 'a09a35458c702b33eeacc393d103063234e8bc28'),
    sha256: 'c0382117ea329cdf097041132f6d735924b697924d6f6fc3945713e96ce87539', bytes: 7031645,
    sameAs: ['Qwen/Qwen3-8B@b968826d9c46dd6066d109eabc6255188de91218'],
  },
  'deepseek-v3': {
    kind: 'hf', label: 'DeepSeek-V3',
    models: 'DeepSeek-V3, V3.1 (and R1, which is built on V3; not compared)',
    url: HF('deepseek-ai/DeepSeek-V3', 'e815299b0bcbac849fa540c768ef21845365c9eb'),
    sha256: '621ac2e32d0dba658404412318818aaa8ce8cda492e59830109d8da6b517fb41', bytes: 7847652,
    sameAs: ['deepseek-ai/DeepSeek-V3.1@c0781d039fb7a1ba2abc4add0bdc293e92d2b8db'],
  },
  'glm4.5': {
    kind: 'hf', label: 'Zhipu GLM-4.5',
    models: 'GLM-4.5 (zai-org/GLM-4.5)',
    url: HF('zai-org/GLM-4.5', 'cbb2c7cfb52fa128a9660cb1a7a78e017899e115'),
    sha256: '9340665016419c825c4bdabbcc9acc43b7ca2c68ce142724afa829abb1be5efd', bytes: 19970699,
  },
  'mistral-tekken': {
    kind: 'hf', label: 'Mistral Tekken',
    models: 'Mistral NeMo (mistralai/Mistral-Nemo-Instruct-2407); later Mistral models use Tekken variants, not compared',
    url: HF('mistralai/Mistral-Nemo-Instruct-2407', '04d8a90549d23fc6bd7f642064003592df51e9b3'),
    sha256: 'e11c71726323d33da7b8d6f6f269f1988931c0a52b7122bcdd8c05042974e0db', bytes: 9264445,
  },
})
/** Tokenizers that matter and cannot be counted offline. / 重要但无法离线计数的分词器。 */
export const NOT_OFFLINE = Object.freeze({
  claude: 'Anthropic has not published the Claude tokenizer; its count_tokens API is a network call to Anthropic that reports Anthropic\'s own count.',
  gemini: 'Google has not published the Gemini tokenizer as a file; Gemma\'s is published but its sameness with Gemini\'s is not confirmed here, and Gemma is a SentencePiece model this engine does not implement.',
})

export const defaultCacheDir = () => process.env.TAPEAPI_TOKENIZER_CACHE || join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'tapeapi', 'tokenizers')
export const fileNameOf = (family) => `${family}-${FAMILIES[family].sha256.slice(0, 12)}${FAMILIES[family].kind === 'tiktoken' ? '.tiktoken' : '.json'}`
const sha256Hex = (b) => createHash('sha256').update(b).digest('hex')

// ---------------------------------------------------------------------------------------------------------------
// The engine / 引擎
// ---------------------------------------------------------------------------------------------------------------
// Byte-pair merging: start from one part per unit, repeatedly merge the adjacent pair with the lowest rank (the
// leftmost on a tie), stop when no adjacent pair has a rank. `rankOf(a, b)` returns the pair's rank or undefined.
// 字节对合并：每个单元一段，反复合并秩最低的相邻对（相同时取最左），直到没有可合并的相邻对。
function bpe(parts, rankOf) {
  if (parts.length < 2) return parts
  const ranks = new Array(parts.length - 1)
  for (let i = 0; i < ranks.length; i++) ranks[i] = rankOf(parts[i], parts[i + 1])
  for (;;) {
    let best = -1, bestRank = Infinity
    for (let i = 0; i < ranks.length; i++) if (ranks[i] !== undefined && ranks[i] < bestRank) { bestRank = ranks[i]; best = i }
    if (best < 0) return parts
    parts.splice(best, 2, parts[best] + parts[best + 1])
    ranks.splice(best, 1)
    if (best > 0) ranks[best - 1] = rankOf(parts[best - 1], parts[best])
    if (best < parts.length - 1) ranks[best] = rankOf(parts[best], parts[best + 1])
  }
}

// Split `pieces` by a regex, keeping matches and the gaps between them as pieces (Hugging Face "Isolated"), or only the
// matches (tiktoken, whose patterns match everything). / 按正则切分：保留匹配与间隙（HF 的 Isolated），或只保留匹配（tiktoken）。
function splitIsolated(piece, re, keepGaps) {
  const out = []
  let at = 0
  re.lastIndex = 0
  for (const m of piece.matchAll(re)) {
    if (m[0] === '') continue
    if (keepGaps && m.index > at) out.push(piece.slice(at, m.index))
    out.push(m[0])
    at = m.index + m[0].length
  }
  if (keepGaps && at < piece.length) out.push(piece.slice(at))
  return out
}

const utf8 = new TextEncoder()
const latin1 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192)); return s }

/**
 * A tokenizer from a tiktoken rank file's text (lines "base64 rank") and its split pattern.
 * 由 tiktoken 秩文件文本与切分模式构造分词器。
 * @param {string} text
 * @param {{ pattern: string, flags?: string, name?: string }} o
 */
export function fromTiktoken(text, { pattern, flags = 'gu', name = 'tiktoken' }) {
  const ranks = new Map()
  for (const line of text.split('\n')) {
    if (!line) continue
    const sp = line.indexOf(' ')
    if (sp < 0) throw new Error(`${name}: a line without a rank`)
    ranks.set(Buffer.from(line.slice(0, sp), 'base64').toString('latin1'), Number(line.slice(sp + 1)))
  }
  const re = new RegExp(pattern, flags)
  const rankOf = (a, b) => ranks.get(a + b)
  function encodePiece(piece) {
    const bytes = latin1(utf8.encode(piece))
    if (ranks.has(bytes)) return [bytes]
    return bpe([...bytes], rankOf)
  }
  return {
    name, kind: 'tiktoken', size: ranks.size,
    tokens: (s) => splitIsolated(String(s), re, false).flatMap(encodePiece),
    encode: (s) => splitIsolated(String(s), re, false).flatMap(encodePiece).map((t) => { const r = ranks.get(t); if (r === undefined) throw new Error(`${name}: a byte with no rank`); return r }),
    count: (s) => splitIsolated(String(s), re, false).reduce((n, p) => n + encodePiece(p).length, 0),
    /** Is this token (as UTF-8 text, or bytes) one token of the vocabulary? / 这个 token 是否在词表中？ */
    hasToken: (t) => ranks.has(typeof t === 'string' ? latin1(utf8.encode(t)) : latin1(t)),
  }
}

// GPT-2's byte <-> printable character map used by every byte-level BPE tokenizer.json.
// GPT-2 的字节与可打印字符映射，所有字节级 BPE 的 tokenizer.json 都用它。
const BYTE_TO_CHAR = (() => {
  const bs = []
  for (let b = 0x21; b <= 0x7e; b++) bs.push(b)
  for (let b = 0xa1; b <= 0xac; b++) bs.push(b)
  for (let b = 0xae; b <= 0xff; b++) bs.push(b)
  const map = new Array(256)
  for (const b of bs) map[b] = String.fromCharCode(b)
  let n = 0
  for (let b = 0; b < 256; b++) if (map[b] === undefined) map[b] = String.fromCharCode(256 + n++)
  return map
})()
const byteLevel = (s) => { let o = ''; for (const b of utf8.encode(s)) o += BYTE_TO_CHAR[b]; return o }

// Hugging Face (onig / Rust) regex -> JavaScript. Only what the published byte-level tokenizers use is accepted: a
// (?i:...) group of literal alternatives is spelled out case by case; anything else unusual is refused, not guessed.
// HF 正则 -> JS 正则。只接受已发布分词器实际用到的写法；(?i:...) 字面量分组逐字母展开；其他不认识的写法直接拒绝，不猜。
export function hfRegex(src) {
  let s = String(src).replace(/\(\?i:([^()]*)\)/g, (_, body) => {
    if (/[\\[\]{}*+?.^$]/.test(body)) throw new Error(`unsupported case-insensitive group (?i:${body})`)
    return '(?:' + body.split('|').map((alt) => [...alt].map((c) => { const l = c.toLowerCase(), u = c.toUpperCase(); return l === u ? c : l === 's' ? '[sSſ]' : `[${l}${u}]` }).join('')).join('|') + ')'
  })
  // Outside character classes: no inline flags, possessive quantifiers, anchors \A \z \Z \G or bare script names.
  // Inside: no nested classes and no && intersections. / 字符类外与类内分别检查不支持的写法。
  const refuse = () => { throw new Error(`unsupported regex construct in ${String(src).slice(0, 80)}`) }
  let outside = ''
  for (let i = 0, inClass = false; i < s.length; i++) {
    const c = s[i]
    if (c === '\\') {
      if ((s[i + 1] === 'p' || s[i + 1] === 'P') && s[i + 2] === '{') {
        // A Unicode property: only general categories (script names differ between onig and JavaScript).
        // Unicode 属性：只接受通用类别（脚本名在 onig 与 JS 中写法不同）。
        const end = s.indexOf('}', i)
        if (end < 0 || !/^(L|N|M|P|S|Z|C|Lu|Ll|Lt|Lm|Lo|Mn|Mc|Me|Nd|Nl|No|Pc|Pd|Ps|Pe|Pi|Pf|Po|Sm|Sc|Sk|So|Zs|Zl|Zp|Cc|Cf)$/.test(s.slice(i + 3, end))) refuse()
        if (!inClass) outside += 'X'
        i = end
        continue
      }
      if (!inClass) outside += c + (s[i + 1] ?? '')
      i++
      continue
    }
    if (inClass) {
      if (c === ']') { inClass = false; outside += ']' } else if (c === '[' || (c === '&' && s[i + 1] === '&')) refuse()
      continue
    }
    if (c === '[') { inClass = true; outside += '['; if (s[i + 1] === '^') i++; if (s[i + 1] === ']') i++; continue }
    outside += c
  }
  if (/\(\?[a-zA-Z<]|[+*?}]\+|\\[AzZG]/.test(outside)) refuse()
  return new RegExp(s, 'gu')
}

/**
 * A tokenizer from a Hugging Face tokenizer.json (parsed) of the byte-level BPE kind. Throws on any component it does
 * not implement exactly, rather than approximating. Added (special) tokens are not matched in the text; a text that
 * contains one is refused.
 * 由 HF tokenizer.json（字节级 BPE）构造分词器。遇到未完全实现的组件直接抛错，不近似。文本中含特殊 token 时拒绝。
 */
export function fromTokenizerJson(json, { name = 'tokenizer.json' } = {}) {
  const fail = (m) => { throw new Error(`${name}: ${m}`) }
  const m = json?.model
  if (!m || m.type !== 'BPE') fail('only BPE models are supported')
  if (m.dropout != null && m.dropout !== 0) fail('BPE dropout is not supported')
  if (m.byte_fallback) fail('byte_fallback is not supported')
  if (m.continuing_subword_prefix || m.end_of_word_suffix) fail('subword prefixes and suffixes are not supported')
  // Normaliser / 规范化
  const norms = []
  const addNorm = (n) => {
    if (n == null) return
    if (n.type === 'Sequence') return (n.normalizers || []).forEach(addNorm)
    if (n.type === 'NFC') return norms.push((s) => s.normalize('NFC'))
    fail(`normalizer ${n.type} is not supported`)
  }
  addNorm(json.normalizer)
  // Pre-tokeniser: Split (Isolated) steps, then exactly one ByteLevel without its own regex.
  // 预分词：若干 Split（Isolated），最后恰好一个不带自身正则的 ByteLevel。
  const splits = []
  let sawByteLevel = false
  const addPre = (p) => {
    if (p == null) fail('a byte-level BPE needs a pre-tokenizer')
    if (p.type === 'Sequence') return (p.pretokenizers || []).forEach(addPre)
    if (sawByteLevel) fail('a pre-tokenizer after ByteLevel is not supported')
    if (p.type === 'Split') {
      if (p.behavior !== 'Isolated' || p.invert) fail('only Split with behavior Isolated, not inverted, is supported')
      if (typeof p.pattern?.Regex !== 'string') fail('only Split with a Regex pattern is supported')
      return splits.push(hfRegex(p.pattern.Regex))
    }
    if (p.type === 'ByteLevel') {
      if (p.use_regex) fail('ByteLevel with use_regex is not supported')
      if (p.add_prefix_space) fail('ByteLevel with add_prefix_space is not supported')
      sawByteLevel = true
      return
    }
    fail(`pre-tokenizer ${p.type} is not supported`)
  }
  addPre(json.pre_tokenizer)
  if (!sawByteLevel) fail('only byte-level BPE is supported')
  const vocab = new Map(Object.entries(m.vocab))
  const merges = new Map()
  m.merges.forEach((x, i) => { const k = Array.isArray(x) ? `${x[0]} ${x[1]}` : x; if (!merges.has(k)) merges.set(k, i) })
  const special = (json.added_tokens || []).map((t) => t.content).filter((c) => typeof c === 'string' && c.length > 1)
  const rankOf = (a, b) => merges.get(`${a} ${b}`)
  const ignoreMerges = m.ignore_merges === true
  function prepare(s) {
    let t = String(s)
    for (const n of norms) t = n(t)
    for (const sp of special) if (t.includes(sp)) fail(`the text contains the special token ${sp}`)
    let pieces = [t]
    for (const re of splits) pieces = pieces.flatMap((p) => splitIsolated(p, re, true))
    return pieces
  }
  function encodePiece(piece) {
    const mapped = byteLevel(piece)
    if (ignoreMerges && vocab.has(mapped)) return [mapped]
    return bpe([...mapped], rankOf)
  }
  return {
    name, kind: 'hf', size: vocab.size,
    tokens: (s) => prepare(s).flatMap(encodePiece),
    encode: (s) => prepare(s).flatMap(encodePiece).map((t) => { const id = vocab.get(t); if (id === undefined) fail(`no id for a merged token`); return id }),
    count: (s) => prepare(s).reduce((n, p) => n + encodePiece(p).length, 0),
    hasToken: (t) => vocab.has(typeof t === 'string' ? byteLevel(t) : [...t].map((b) => BYTE_TO_CHAR[b]).join('')),
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Files: cache, download, verify / 文件：缓存、下载、核验
// ---------------------------------------------------------------------------------------------------------------
/** The verified bytes of a family's file from the cache, or null when it is not there. Throws on a hash mismatch. */
export function readCached(family, { cacheDir = defaultCacheDir() } = {}) {
  const f = FAMILIES[family]
  if (!f) throw new Error(`unknown tokenizer family ${family}`)
  const p = join(cacheDir, fileNameOf(family))
  if (!existsSync(p)) return null
  const b = readFileSync(p)
  const h = sha256Hex(b)
  if (h !== f.sha256) throw new Error(`${p}: sha256 ${h}, expected ${f.sha256}; delete it and download again`)
  return b
}

/** Fetch a family's file from its pinned URL, check its sha256, store it in the cache. / 下载、核验并缓存。 */
export async function download(family, { cacheDir = defaultCacheDir(), fetch: fetchImpl = globalThis.fetch, log = () => {} } = {}) {
  const f = FAMILIES[family]
  if (!f) throw new Error(`unknown tokenizer family ${family}`)
  if (readCached(family, { cacheDir })) { log(`${family}: already cached`); return join(cacheDir, fileNameOf(family)) }
  log(`${family}: fetching ${f.url} (${(f.bytes / 1e6).toFixed(1)} MB)`)
  const res = await fetchImpl(f.url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`${family}: HTTP ${res.status} from ${f.url}`)
  const b = Buffer.from(await res.arrayBuffer())
  const h = sha256Hex(b)
  if (h !== f.sha256) throw new Error(`${family}: the file from ${f.url} has sha256 ${h}, expected ${f.sha256}; refused`)
  mkdirSync(cacheDir, { recursive: true })
  const p = join(cacheDir, fileNameOf(family)), tmp = `${p}.${process.pid}.tmp`
  writeFileSync(tmp, b)
  renameSync(tmp, p)
  log(`${family}: ok, ${p}`)
  return p
}

const loaded = new Map()
/**
 * A family's tokenizer from the cache (verified), or null when its file is not cached. Loaded once per process.
 * 从缓存（已核验）加载某族分词器；未缓存时为 null。每个进程只加载一次。
 */
export function loadTokenizer(family, { cacheDir = defaultCacheDir() } = {}) {
  const key = `${cacheDir}|${family}`
  if (loaded.has(key)) return loaded.get(key)
  const b = readCached(family, { cacheDir })
  if (!b) return null
  const f = FAMILIES[family]
  const t = f.kind === 'tiktoken'
    ? fromTiktoken(b.toString('utf8'), { pattern: f.pattern, flags: f.flags, name: family })
    : fromTokenizerJson(JSON.parse(b.toString('utf8')), { name: family })
  loaded.set(key, t)
  return t
}

// ---------------------------------------------------------------------------------------------------------------
// probes.json: the texts whose counts it ships / probes.json 中需要预期计数的文本
// ---------------------------------------------------------------------------------------------------------------
/** { probeId: text } for every probe that carries a `tokenText` (the whole user message of that probe). */
export const tokenTextsOf = (probes) => Object.fromEntries(probes.probes.filter((p) => typeof p.tokenText === 'string').map((p) => [p.id, p.tokenText]))

/** The expected counts for probes.json, per family available in the cache. / 用缓存中可用的分词器重算 probes.json 的预期计数。 */
export function computeExpected(probes, { cacheDir = defaultCacheDir(), families = Object.keys(FAMILIES) } = {}) {
  const texts = tokenTextsOf(probes)
  const out = {}, missing = []
  for (const fam of families) {
    const t = loadTokenizer(fam, { cacheDir })
    if (!t) { missing.push(fam); continue }
    out[fam] = Object.fromEntries(Object.entries(texts).map(([id, s]) => [id, t.count(s)]))
  }
  return { counts: out, missing }
}

// ---------------------------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------------------------
const PROBES_PATH = fileURLToPath(new URL('probes.json', import.meta.url))
async function main(argv) {
  let cacheDir = defaultCacheDir()
  const args = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cache') cacheDir = argv[++i]
    else if (argv[i].startsWith('--cache=')) cacheDir = argv[i].slice(8)
    else args.push(argv[i])
  }
  const [cmd, ...rest] = args
  const say = (s) => process.stderr.write(`[tokenizers] ${s}\n`)
  if (cmd === 'list' || !cmd) {
    for (const [k, f] of Object.entries(FAMILIES)) process.stdout.write(`${k.padEnd(15)} ${existsSync(join(cacheDir, fileNameOf(k))) ? 'cached ' : 'absent '} ${(f.bytes / 1e6).toFixed(1).padStart(5)} MB  ${f.label}: ${f.models}\n`)
    for (const [k, why] of Object.entries(NOT_OFFLINE)) process.stdout.write(`${k.padEnd(15)} n/a              ${why}\n`)
    process.stdout.write(`cache: ${cacheDir}\n`)
    return 0
  }
  if (cmd === 'download') {
    const fams = !rest.length || rest.includes('all') ? Object.keys(FAMILIES) : rest
    for (const fam of fams) await download(fam, { cacheDir, log: say })
    return 0
  }
  if (cmd === 'count') {
    const [fam, ...words] = rest
    const t = loadTokenizer(fam, { cacheDir })
    if (!t) { say(`${fam} is not cached; run: node tokenizers.mjs download ${fam}`); return 1 }
    process.stdout.write(`${t.count(words.join(' '))}\n`)
    return 0
  }
  if (cmd === 'check') {
    const probes = JSON.parse(readFileSync(PROBES_PATH, 'utf8'))
    const { counts, missing } = computeExpected(probes, { cacheDir })
    if (missing.length) say(`not cached, not checked: ${missing.join(', ')} (node tokenizers.mjs download ${missing.join(' ')})`)
    let diff = 0
    for (const [fam, byId] of Object.entries(counts)) {
      for (const [id, n] of Object.entries(byId)) {
        const shipped = probes.tokenizers?.expected?.[fam]?.[id]
        if (shipped !== n) { diff++; say(`${fam} ${id}: computed ${n}, probes.json has ${shipped}`) }
      }
    }
    if (rest.includes('--write')) {
      probes.tokenizers = { ...(probes.tokenizers || {}), pins: Object.fromEntries(Object.entries(FAMILIES).map(([k, f]) => [k, { url: f.url, sha256: f.sha256 }])), expected: { ...(probes.tokenizers?.expected || {}), ...counts } }
      writeFileSync(PROBES_PATH, JSON.stringify(probes, null, 2) + '\n')
      say(`wrote ${PROBES_PATH}`)
      return 0
    }
    say(diff ? `${diff} count(s) differ` : `all ${Object.keys(counts).length} cached families agree with probes.json`)
    return diff ? 1 : 0
  }
  say(`unknown command ${cmd}; use list, download, count or check`)
  return 2
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { process.stderr.write(`[tokenizers] ${e.message}\n`); process.exit(1) })
}
