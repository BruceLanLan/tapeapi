#!/usr/bin/env node
// The TapeAPI signing sidecar for a relay running new-api: it sits IN FRONT of new-api (client -> sidecar -> new-api),
// passes /v1/* through byte for byte and signs a usage receipt for every answer of the API formats FORMATS selects
// (among Chat, Responses, Anthropic Messages and Embeddings; createAIProxy from @tapeapi/server/ai-proxy); a metered
// path of a format FORMATS leaves out is refused (HTTP 400 naming FORMATS). new-api keeps its channels, keys, quotas and billing;
// your users keep their keys and their SDKs. The operator runs it; nobody else hosts it (it sees your users' API keys).
// 给运行 new-api 的中转站用的 TapeAPI 签名旁路：放在 new-api **前面**（客户端 -> 旁路 -> new-api），/v1/* 逐字节透传，并为
// FORMATS 所选格式（Chat、Responses、Anthropic Messages、Embeddings 之中）的每个回答签一份用量回执；FORMATS 未启用的格式的计量路径
// 一律拒绝（HTTP 400，点名 FORMATS）。new-api 的渠道、密钥、额度与计费都不变；用户的密钥与 SDK
// 也不变。旁路由中转站自己运行，不交给任何第三方托管（它经手用户的 API 密钥）。
//
// Environment / 环境变量:
//   PUBLIC_URL           https://api.example.com   the public https root of THIS sidecar (your users' base URL root)
//   CIRCUITS, TOKEN_ID, CONTAINER, DELEGATION_EXPIRES, DELEGATION_SIG   the identity, as the holder console shows them
//   SIGNER_KEY           the service key the delegation names (or SIGNER_KEY_FILE: a file holding it, e.g. a Docker secret)
//   SIGNER_KEY_GENERATE  optional, "1" with SIGNER_KEY_FILE: when that file does not exist yet, the sidecar creates a new
//                        key in it at start (mode 0600) and prints only its address; the key itself is never printed.
//                        Not when SIGNER_ADDRESS is set (a lost key file is then setup mode, not a silent new key).
//                        可选，与 SIGNER_KEY_FILE 一起设为 "1"：该文件还不存在时，旁路启动时在其中生成新密钥（权限 0600），只打印其地址，
//                        从不打印密钥本身。设了 SIGNER_ADDRESS 时不生成（密钥文件丢失即为设置模式，而不是悄悄换一把新密钥）。
//   OPERATOR_SITE_URL    optional: your own site (https). GET / on the sidecar's host answers 302 to it (URL-normalised), with
//                        nothing added. Unset: GET / answers 404 NOT_FOUND as before (503 in setup mode). Never the holder
//                        console. / 可选：你自己的站点（https）。旁路主机名上的 GET / 302 跳转过去（按 URL 标准写法），不附加任何参数。未设：
//                        GET / 与以前一样回答 404 NOT_FOUND（设置模式下 503）。不能是持有人操作台。
//   MODELS_FILE         the price table (default: models.json next to this file)
//   UPSTREAM_BASE_URL    new-api's /v1 base (default http://new-api:3000/v1, the compose service)
//   TAPE_NAME            optional: the service's TapeOut name, printed in the hint for tapeapi-verify users
//   SERVICE_NAME         optional display name (default "AI relay (TapeAPI sidecar)")
//   PORT, HOST           listen address (default 8080, 127.0.0.1; the image sets HOST=0.0.0.0)
//   RATE_IP              requests per minute per client IP at the sidecar (default 600; 0 = off, leave limits to new-api)
//   CLIENT_IP_HEADER     the header your reverse proxy sets to the client's address (x-real-ip, x-forwarded-for, ...);
//                        unset = the TCP peer (then every caller behind one proxy shares one rate-limit bucket)
//   RECEIPT_LOOKUPS_PER_MIN  optional: lookups of the free `receipt` method per client IP per minute (default 10, as
//                        before; 0 refuses every lookup, as in examples/ai-proxy's Worker; off: no budget of its own, RATE_IP
//                        only). A billing layer in front that looks receipts up from one address shares one bucket: raise it there.
//                        Read since 2.5: a value 2.4 ignored, if malformed, is now setup mode.
//                        可选：免费 receipt 方法每个客户端 IP 每分钟的次数（默认 10，与以前相同；0 拒绝所有取回，与 Worker 相同；off 不单独限流，只受 RATE_IP 约束）。2.5 起才读取：2.4 忽略的坏值现在会进设置模式。前面的
//                        计费层从同一个地址取回执时共用一个桶，请调高。
//   UPSTREAM_RESPONSE_HEADERS  optional, experimental (2.5): comma-separated upstream response headers to pass on to
//                        callers; every other upstream header is dropped (content-type, as its media type, charset and boundary
//                        only, and retry-after are always kept). Receipts are unchanged (headers are not in a receipt).
//                        Unset or empty: no allowlist, every header passed, as before; content-type alone = none extra.
//                        可选，实验性（2.5）：逗号分隔的上游响应头白名单，其余上游头一律去掉（content-type 只保留媒体类型与
//                        charset、boundary，以及 retry-after，始终保留）。回执不变（响应头不在回执里）。未设或留空：不开白名单，与以前一样
//                        全部转交；只写 content-type 即除这两个之外一个都不转。
//   SIGNER_ADDRESS       optional: must match SIGNER_KEY (a guard against pasting the wrong key)
//   FORMATS              SET IT: the API formats your new-api really serves, comma-separated, among openai-chat,
//                        openai-responses, anthropic-messages, openai-embeddings (or "all" for the four). Only these are
//                        published in the manifest and get receipts: the manifest is a public statement on chain, so a
//                        relay whose channels are OpenAI-compatible only sets FORMATS=openai-chat. Unset: all four, as
//                        2.0.0 published, with a WARNING in the startup log and a "warning" in /tapeapi/v1/health that
//                        name FORMATS and its values. Unknown names: setup mode, naming the variable. A metered path of
//                        a format left out (POST /v1/messages without anthropic-messages, ...) is answered HTTP 400 naming
//                        FORMATS and never forwarded.
//                        请设置：你的 new-api 真正提供的 API 格式（逗号分隔，或 "all" 表示四种）。只有这些格式写进清单、签发回执：
//                        清单是链上的公开声明，渠道只兼容 OpenAI 的中转站就设 FORMATS=openai-chat。未设：四种都发布（与 2.0.0 相同），
//                        启动日志打印 WARNING、/tapeapi/v1/health 带 warning，点名该变量与可选值。名字不认识：设置模式，并点名该变量。
//                        未启用格式的计量路径（例如未启用 anthropic-messages 时的 POST /v1/messages）答 400 并点名 FORMATS，绝不转发。
//
// Until the identity is complete the sidecar runs in SETUP MODE: /tapeapi/v1/health names the signing address (the
// holder console reads it there to build the delegation) and what is missing; everything else answers 503.
// 身份变量设齐之前旁路处于**设置模式**：/tapeapi/v1/health 给出签名地址（持有人操作台从这里读取它来构造委托）与缺了什么；其余一律 503。
//
//   node examples/new-api-sidecar/server.mjs          (Docker: see docker-compose.yml and README.md)
import http from 'node:http'
import { isIP } from 'node:net'
import { readFileSync, realpathSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createAIProxy } from '@tapeapi/server/ai-proxy'
import { sig, ai } from '@tapeapi/sdk'

export const REQUIRED = ['PUBLIC_URL', 'CIRCUITS', 'TOKEN_ID', 'CONTAINER', 'DELEGATION_EXPIRES', 'DELEGATION_SIG']
export const DEFAULT_UPSTREAM = 'http://new-api:3000/v1'
export const DEFAULT_MODELS_FILE = fileURLToPath(new URL('models.json', import.meta.url))
export const CONSOLE_URL = 'https://tapeapi.fun/console/'
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const HEADER_NAME = /^[a-z0-9!#$%&'*+.^_`|~-]+$/
const LOOPBACK_HTTP = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' }
/**
 * Which gateway the sidecar stands in front of: its name in messages, the log label, the default upstream, and
 * optionally the API format adapters handed to createAIProxy (default ai.FORMATS) and the price table used when
 * MODELS_FILE is unset. Other one-command packages (examples/litellm-sidecar) pass their own; every default here is
 * new-api's, unchanged.
 * 旁路放在哪个网关前面：消息里的名字、日志标签、默认上游，以及可选的格式适配器（默认 ai.FORMATS）与未设 MODELS_FILE 时的价目表。
 * 其它一键包（examples/litellm-sidecar）传入自己的；这里的默认值都是 new-api 的，保持不变。
 * An unset FORMATS keeps every format of the profile (as 2.0.0 published); warnFormatsUnset (new-api's package) then
 * adds a warning to the startup log and to /tapeapi/v1/health, since the manifest should not claim formats the relay
 * does not serve. FORMATS set: only those, whatever the profile says.
 * 未设 FORMATS 时保留该配置的全部格式（与 2.0.0 发布的相同）；warnFormatsUnset（new-api 一键包）再在启动日志与 /tapeapi/v1/health
 * 里加一条警告，因为清单不应声明中转站并不提供的格式。设了 FORMATS：只用所选格式，与配置无关。
 * @typedef {{ upstreamName: string, label: string, defaultUpstream: string, formats?: object[], modelsFile?: string, warnFormatsUnset?: boolean }} SidecarProfile
 */
/** @type {SidecarProfile} */
export const NEW_API_PROFILE = Object.freeze({ upstreamName: 'new-api', label: 'new-api-sidecar', defaultUpstream: DEFAULT_UPSTREAM, warnFormatsUnset: true })
export const FORMATS_VAR = 'FORMATS'

/** What to set FORMATS to, in one sentence. / 一句话说明 FORMATS 可以设成什么。 */
export function formatsChoice(available = ai.FORMATS) {
  return `choose among ${available.map((f) => f.name).join(', ')} (comma-separated), or all; a relay whose channels are OpenAI-compatible only sets ${FORMATS_VAR}=openai-chat`
}

/** The warning when FORMATS is not set (every format published, as 2.0.0 did), in one sentence naming the variable and
 *  its values. / 未设 FORMATS 时的警告（四种格式都发布，与 2.0.0 相同），一句话点名变量与可选值。 */
export function formatsUnsetWarning(available = ai.FORMATS, upstreamName = 'new-api') {
  return `${FORMATS_VAR} is not set, so every format is published and signed (${available.map((f) => f.name).join(', ')}), as 2.0.0 did; set ${FORMATS_VAR} to the formats your ${upstreamName} really serves, comma-separated among ${available.map((f) => f.name).join(', ')}, or all (a relay whose channels are OpenAI-compatible only sets ${FORMATS_VAR}=openai-chat)`
}

/**
 * The formats FORMATS selects among `available` (adapters with a `name`), in the order of `available` (so the manifest's
 * endpoints come out the same whatever order the variable lists them in), or a sentence saying what is wrong. Names are
 * separated by commas or spaces; "all" is every format of `available`; a name twice counts once. Kept in this file on
 * purpose: the Docker image copies server.mjs alone.
 * FORMATS 在 available 中选出的格式（按 available 的顺序，清单端点因此与变量里的书写顺序无关），或一句说明哪里不对的话。名字以逗号或
 * 空白分隔；"all" 表示全部；重复的名字只算一次。刻意放在本文件：Docker 镜像只复制 server.mjs。
 * @param {string} value
 * @param {Array<{ name: string }>} available
 * @returns {object[]|string}
 */
export function selectFormats(value, available = ai.FORMATS) {
  const names = available.map((f) => f.name)
  const asked = String(value ?? '').split(/[\s,]+/).filter(Boolean)
  const choose = formatsChoice(available)
  if (!asked.length) return `${FORMATS_VAR} names no format: ${choose}`
  if (asked.length === 1 && asked[0].toLowerCase() === 'all') return [...available]
  const unknown = asked.filter((n) => !names.includes(n))
  if (unknown.length) return `${FORMATS_VAR} names ${unknown.length === 1 ? 'a format' : 'formats'} this sidecar does not know (${unknown.map((n) => JSON.stringify(n)).join(', ')}): ${choose}`
  return available.filter((f) => asked.includes(f.name))
}

/**
 * OPERATOR_SITE_URL, checked: { url } (null when unset) or { problem }. Your own site, where GET / on the sidecar's host
 * sends a visitor: https (http only for a loopback host), no credentials, query or fragment, at most 200 characters, not
 * TapeAPI's own site (the holder console, CONSOLE_URL, is not your site) and not the sidecar itself (`publicUrl`).
 * OPERATOR_SITE_URL 的检查结果：{ url }（未设为 null）或 { problem }。你自己的站点：https（http 只限回环地址），不带凭据、查询串或
 * 片段，最多 200 个字符；不能是 TapeAPI 自己的站点（持有人操作台 CONSOLE_URL 不是你的站点），也不能是旁路自己。
 * @param {string|undefined} value
 * @param {string|null} [publicUrl]
 * @returns {{ url: string|null, problem?: undefined }|{ problem: string, url?: undefined }}
 */
export function operatorSiteOf(value, publicUrl = null) {
  const v = typeof value === 'string' ? value.trim() : ''
  if (!v) return { url: null }
  const bad = (why) => ({ problem: `OPERATOR_SITE_URL ${why}` })
  if (v.length > 200) return bad('must be at most 200 characters')
  let u
  try { u = new URL(v) } catch { return bad(`must be a URL such as https://www.example.com, not ${JSON.stringify(v.slice(0, 80))}`) }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK_HTTP.test(u.href))) return bad('must be https (http only for 127.0.0.1 or localhost)')
  if (u.username || u.password || u.search || u.hash) return bad('must not carry credentials, a query or a fragment: the sidecar sends visitors there unchanged and adds nothing')
  const host = u.hostname.toLowerCase().replace(/\.$/, '')
  const consoleHost = new URL(CONSOLE_URL).hostname
  if (host === consoleHost || host.endsWith(`.${consoleHost}`)) return bad(`must be your own site, not ${consoleHost} (the holder console is not your site)`)
  if (publicUrl) { try { if (new URL(publicUrl).origin === u.origin) return bad('must be another site than the sidecar\'s own PUBLIC_URL (GET / would send visitors to itself)') } catch { /* PUBLIC_URL is checked on its own */ } }
  return { url: u.href }
}

/**
 * Read and check the environment. Never throws: `ok: false` is setup mode, with `missing` (variables not set) and
 * `problem` (a variable that is set but wrong), so the operator sees one clear sentence instead of a stack trace.
 * 读取并检查环境变量。从不抛出：ok 为 false 即设置模式，missing 列出没设的变量，problem 说明设了但不对的那一个。
 * @param {Record<string, string|undefined>} rawEnv
 * @returns {{ ok: boolean, missing: string[], problem: string|null, signer: string|null, config?: object }}
 */
export function readConfig(rawEnv = process.env, profile = NEW_API_PROFILE) {
  // Values pasted from a phone or a web page often carry a trailing space or newline. / 粘贴来的值常带尾随空白。
  const env = Object.fromEntries(Object.entries(rawEnv || {}).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]))
  const out = (problem, extra = {}) => ({ ok: false, missing: extra.missing ?? [], problem, signer: extra.signer ?? null })

  let signerKey = env.SIGNER_KEY || ''
  if (!signerKey && env.SIGNER_KEY_FILE) {
    try { signerKey = readFileSync(env.SIGNER_KEY_FILE, 'utf8').trim() } catch (e) { return out(`SIGNER_KEY_FILE ${env.SIGNER_KEY_FILE} cannot be read (${e.code || e.message})`) }
  }
  let signer = null
  if (signerKey) {
    try { signer = sig.privateKeyToAddress(signerKey) } catch { return out('SIGNER_KEY is not a private key (0x followed by 64 hex digits); generate one in step 3 of the holder console') }
  }
  const missing = [...(signer ? [] : ['SIGNER_KEY (secret)']), ...REQUIRED.filter((k) => !env[k])]
  if (missing.length) return out(null, { missing, signer })
  if (env.SIGNER_ADDRESS && env.SIGNER_ADDRESS.toLowerCase() !== signer.toLowerCase()) return out(`SIGNER_ADDRESS ${env.SIGNER_ADDRESS} does not match SIGNER_KEY (${signer})`, { signer })

  // Identity / 身份
  let pub
  try { pub = new URL(env.PUBLIC_URL) } catch { return out(`PUBLIC_URL must be a URL such as https://api.example.com, not ${JSON.stringify(env.PUBLIC_URL)}`, { signer }) }
  const publicUrl = pub.href.replace(/\/+$/, '')
  const loopback = LOOPBACK_HTTP.test(publicUrl)
  if (pub.protocol !== 'https:' && !loopback) return out(`PUBLIC_URL must be https (terminate TLS in your reverse proxy in front of the sidecar); http only for 127.0.0.1 or localhost`, { signer })
  if (pub.search || pub.hash || pub.username || pub.password) return out('PUBLIC_URL must not carry a query, a fragment or credentials', { signer })
  // A bare origin: the holder console publishes endpoints of the form https://<host>/tapeapi/v1 only. / 只写到域名：操作台只发布 https://<host>/tapeapi/v1 形式的端点。
  if (pub.pathname !== '/') return out(`PUBLIC_URL must be a bare origin such as https://api.example.com, without the path ${pub.pathname}`, { signer })
  for (const k of ['CIRCUITS', 'CONTAINER']) if (!ADDRESS.test(env[k])) return out(`${k} must be an address (0x followed by 40 hex digits), as the holder console shows it`, { signer })
  if (!/^\d{1,78}$/.test(env.TOKEN_ID)) return out('TOKEN_ID must be a whole number (your circuit\'s token id)', { signer })
  const expires = Number(env.DELEGATION_EXPIRES)
  if (!/^\d{1,12}$/.test(env.DELEGATION_EXPIRES)) return out('DELEGATION_EXPIRES must be a Unix time in seconds, as the holder console shows it', { signer })
  if (expires <= Math.floor(Date.now() / 1000)) return out(`the delegation expired at ${new Date(expires * 1000).toISOString()}: renew it in step 4 of the holder console (${CONSOLE_URL}) and set the new DELEGATION_EXPIRES and DELEGATION_SIG`, { signer })
  if (!/^0x[0-9a-fA-F]{130,}$/.test(env.DELEGATION_SIG)) return out('DELEGATION_SIG must be the 65-byte signature from step 4 of the holder console (0x followed by 130 hex digits)', { signer })

  // Upstream (new-api, or the profile's gateway) / 上游
  const upstreamBaseUrl = env.UPSTREAM_BASE_URL || profile.defaultUpstream
  try { const u = new URL(upstreamBaseUrl); if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error() } catch { return out(`UPSTREAM_BASE_URL must be ${profile.upstreamName}'s /v1 base, such as ${profile.defaultUpstream}`, { signer }) }

  // The API formats published and signed (FORMATS) / 发布并签名的 API 格式
  const available = profile.formats || ai.FORMATS
  const formats = env[FORMATS_VAR] ? selectFormats(env[FORMATS_VAR], available) : [...available]
  if (typeof formats === 'string') return out(formats, { signer })
  // Unset: every format, as 2.0.0 published, and a warning that names FORMATS (startup log, health). / 未设：全部格式，加一条警告。
  const formatsWarning = !env[FORMATS_VAR] && profile.warnFormatsUnset ? formatsUnsetWarning(available, profile.upstreamName) : null

  // The price table, checked against the selected formats / 价目表，按所选格式校验
  const modelsFile = env.MODELS_FILE || profile.modelsFile || DEFAULT_MODELS_FILE
  const models = readModels(modelsFile, publicUrl, formats)
  if (typeof models === 'string') return out(models, { signer })

  // Rate limit and client address / 限流与客户端地址
  const rateIp = env.RATE_IP === undefined || env.RATE_IP === '' ? 600 : Number(env.RATE_IP)
  if (!Number.isInteger(rateIp) || rateIp < 0) return out('RATE_IP must be a whole number of requests per minute per client IP (0 = no limit at the sidecar)', { signer })
  const clientIpHeader = env.CLIENT_IP_HEADER ? env.CLIENT_IP_HEADER.toLowerCase() : null
  if (clientIpHeader && !HEADER_NAME.test(clientIpHeader)) return out(`CLIENT_IP_HEADER must be a header name such as x-real-ip, not ${JSON.stringify(env.CLIENT_IP_HEADER)}`, { signer })
  const name = env.SERVICE_NAME || 'AI relay (TapeAPI sidecar)'
  if ([...name].length > 64) return out('SERVICE_NAME must be at most 64 characters', { signer })
  // The receipt method: lifetime and whether a lookup must name the request hash (for channels whose answer ids are
  // guessable, such as Ollama's). / receipt 方法：保留时长，以及取回是否必须给出请求哈希（渠道的回答 id 可猜时用，例如 Ollama）。
  const receiptTtlS = env.RECEIPT_TTL_S === undefined || env.RECEIPT_TTL_S === '' ? 3600 : Number(env.RECEIPT_TTL_S)
  if (!Number.isInteger(receiptTtlS) || receiptTtlS <= 0) return out('RECEIPT_TTL_S must be a whole number of seconds above 0 (default 3600)', { signer })
  if (![undefined, '', '0', '1'].includes(env.RECEIPT_REQUIRE_HASH)) return out('RECEIPT_REQUIRE_HASH must be 1 (a receipt lookup must name requestSha256 too) or 0', { signer })
  const requireRequestHash = env.RECEIPT_REQUIRE_HASH === '1'
  // The receipt method's own budget per client IP (2.5; the Worker already read this variable). / receipt 方法的按 IP 预算。
  // 0 refuses every lookup (as the Worker); `off` (any case) leaves the receipt method to the sidecar's RATE_IP alone
  // 0 拒绝所有补查（与 Worker 相同）；off（不区分大小写）表示不单独限流，只受 RATE_IP 约束
  const lookupsRaw = env.RECEIPT_LOOKUPS_PER_MIN === undefined || env.RECEIPT_LOOKUPS_PER_MIN === '' ? null : env.RECEIPT_LOOKUPS_PER_MIN
  const receiptLookupsPerMin = lookupsRaw === null ? null : /^off$/i.test(lookupsRaw) ? 'off' : /^\d{1,7}$/.test(lookupsRaw) ? Number(lookupsRaw) : undefined
  if (receiptLookupsPerMin === undefined) return out('RECEIPT_LOOKUPS_PER_MIN must be a whole number of receipt lookups per minute per client IP (default 10; 0 refuses every lookup), or off (no limit of its own)', { signer })
  // Upstream response headers passed on, when listed (2.5, experimental). / 列出时只转交这些上游响应头。
  const upstreamResponseHeaders = env.UPSTREAM_RESPONSE_HEADERS ? env.UPSTREAM_RESPONSE_HEADERS.split(/[\s,]+/).filter(Boolean).map((h) => h.toLowerCase()) : null
  if (upstreamResponseHeaders && (!upstreamResponseHeaders.length || !upstreamResponseHeaders.every((h) => HEADER_NAME.test(h) && h.length <= 128))) return out('UPSTREAM_RESPONSE_HEADERS must be header names separated by commas, such as x-request-id,retry-after', { signer })
  // 0: the clients' session headers (x-claude-code-session-id, session-id, thread-id) do not reach new-api. / 0：不转发会话头。
  if (![undefined, '', '0', '1'].includes(env.FORWARD_SESSION_HEADERS)) return out('FORWARD_SESSION_HEADERS must be 1 (pass the clients\' session headers upstream, the default) or 0', { signer })
  const forwardSessionHeaders = env.FORWARD_SESSION_HEADERS !== '0'
  // Where GET / sends a visitor: the operator's own site, or nowhere (404, as before). / GET / 把访问者送到哪里。
  const site = operatorSiteOf(env.OPERATOR_SITE_URL, publicUrl)
  if (site.problem) return out(site.problem, { signer })

  return {
    ok: true, missing: [], problem: null, signer,
    config: {
      publicUrl, loopback, upstreamBaseUrl, modelsFile, models, formats, signerKey, signer, rateIp, clientIpHeader, receiptTtlS, requireRequestHash, forwardSessionHeaders, receiptLookupsPerMin, upstreamResponseHeaders,
      formatsWarning,
      operatorSiteUrl: site.url,
      tapeName: env.TAPE_NAME || null,
      manifestBase: {
        tapeapi: '0.1', name, circuits: env.CIRCUITS, tokenId: String(BigInt(env.TOKEN_ID)), container: env.CONTAINER,
        delegation: { expires, sig: env.DELEGATION_SIG },
        endpoints: { live: [`${publicUrl}/tapeapi/v1`], async: false },
      },
    },
  }
}

/**
 * The price table from a file: the models array, or a sentence saying what is wrong with it (file, JSON, or the rules
 * of TAPI-20 §3.9 checked exactly as clients check them, against the endpoints of `formats`, the formats FORMATS
 * selected). / 从文件读价目表：返回数组，或一句说明哪里不对的话（按所选格式的端点校验）。
 */
export function readModels(file, publicUrl = 'https://sidecar.invalid', formats = ai.FORMATS) {
  let text
  try { text = readFileSync(file, 'utf8') } catch (e) { return `MODELS_FILE ${file} cannot be read (${e.code || e.message}); copy models.example.json to models.json and edit it` }
  let models
  try { models = JSON.parse(text) } catch (e) { return `MODELS_FILE ${file} is not valid JSON: ${e.message}` }
  if (!Array.isArray(models) || !models.length) return `MODELS_FILE ${file} must hold a JSON array of models: [{ "id", "aliases"?, "formats"?, "prices": [{ "currency", "unit": "1M tokens", "input", "output", ... }] }]`
  // A model limited to a format FORMATS leaves out: said in words before the generic rule. / 模型限定的格式被 FORMATS 排除：先用一句话说清。
  const enabled = new Set(formats.map((f) => f.name))
  const known = new Set(ai.FORMATS.map((f) => f.name))
  for (const [i, m] of models.entries()) {
    const off = Array.isArray(m?.formats) ? m.formats.filter((f) => typeof f === 'string' && known.has(f) && !enabled.has(f)) : []
    if (off.length) return `the price table in ${file} is not valid: models[${i}] (${String(m.id).slice(0, 64)}) lists ${off.join(', ')} in "formats", which ${FORMATS_VAR} does not enable (enabled: ${[...enabled].join(', ')}); remove ${off.length === 1 ? 'it' : 'them'} from the model's "formats" or add ${off.length === 1 ? 'it' : 'them'} to ${FORMATS_VAR}`
  }
  try {
    ai.validateAIField({ endpoints: formats.map((f) => ({ format: f.name, baseUrl: publicUrl + f.baseSuffix })), models }, { allowHttp: true })
  } catch (e) { return `the price table in ${file} is not valid: ${e.message}` }
  return models
}

/** The end of the refusal of a format FORMATS leaves out: what to change, with the names to choose from.
 *  FORMATS 未启用的格式被拒绝时消息的结尾：改什么、可选哪些名字。 */
export function formatsHint(formats, all = ai.FORMATS) {
  return `${FORMATS_VAR} does not enable it; if your upstream really serves it, add it to ${FORMATS_VAR} (comma-separated among ${all.map((f) => f.name).join(', ')}, or all) and restart the sidecar`
}

/** The sidecar for a good configuration: the formats FORMATS selected (config.formats), unless `formats` is given.
 *  Throws what createAIProxy throws. / 按正确配置建出旁路：格式取 FORMATS 所选（config.formats），除非另给 formats。 */
export function buildProxy(config, { fetch, log, formats } = {}) {
  const chosen = formats || config.formats
  return createAIProxy({
    ...(chosen ? { formats: chosen } : {}),
    // A metered path of a format FORMATS leaves out: HTTP 400 naming FORMATS, never passed through without a receipt.
    // FORMATS 未启用的格式的计量路径：答 400 并点名 FORMATS，绝不无回执透传。
    refuseOtherFormats: { hint: formatsHint(chosen) },
    upstream: { baseUrl: config.upstreamBaseUrl },
    manifestBase: config.manifestBase,
    signerKey: config.signerKey,
    models: config.models,
    allowHttp: config.loopback,
    rateLimit: config.rateIp === 0 ? false : { windowMs: 60_000, free: config.rateIp, paid: 0, ip: config.rateIp },
    ...(config.receiptTtlS ? { receiptTtlMs: config.receiptTtlS * 1000 } : {}),
    ...(config.requireRequestHash ? { requireRequestHash: true } : {}),
    ...(config.forwardSessionHeaders === false ? { forwardSessionHeaders: false } : {}),
    ...(Number.isInteger(config.receiptLookupsPerMin) ? { receiptRateLimit: { ip: config.receiptLookupsPerMin, windowMs: 60_000 } } : config.receiptLookupsPerMin === 'off' ? { receiptRateLimit: false } : {}),
    ...(config.upstreamResponseHeaders ? { upstreamResponseHeaders: config.upstreamResponseHeaders } : {}),
    ...(fetch ? { fetch } : {}),
    ...(log ? { log } : {}),
  })
}

/** Setup mode, as examples/cloudflare-worker's setupAnswer (the holder console reads the signer from health).
 *  设置模式，与 examples/cloudflare-worker 的 setupAnswer 相同（持有人操作台从 health 读取签名地址）。 */
export function setupAnswer(state, request) {
  const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...CORS, ...headers } })
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  const path = new URL(request.url).pathname.replace(/\/+$/, '')
  const why = state.problem || `missing: ${state.missing.join(', ')}`
  if (request.method === 'GET' && path === '/tapeapi/v1/health') return json(200, { ok: false, setup: true, signer: state.signer, missing: state.missing, ...(state.problem ? { problem: state.problem } : {}) })
  // An AI client gets the error in the OpenAI shape it can print. / AI 客户端收到它能显示的 OpenAI 错误格式。
  if (path.startsWith('/v1/')) return json(503, { error: { message: `this AI service is being set up (${why})`, type: 'tapeapi_proxy_error', param: null, code: 'setup' } }, { [ai.SIDECAR_ERROR_HEADER]: '1' })
  return json(503, { ok: false, error: { code: 'DELEGATION_INVALID', message: `this service is being set up; ${why}` } })
}

/**
 * The proxy with `warning` added to its GET /tapeapi/v1/health answer (FORMATS unset); everything else untouched.
 * 在 GET /tapeapi/v1/health 的回答里加上 warning（未设 FORMATS 时）；其它一概不动。
 */
export function withHealthWarning(proxy, warning) {
  return {
    ...proxy,
    async handleRequest(request, o) {
      const res = await proxy.handleRequest(request, o)
      if (request.method !== 'GET' || new URL(request.url).pathname.replace(/\/+$/, '') !== '/tapeapi/v1/health') return res
      let body
      try { body = await res.clone().json() } catch { return res }
      return new Response(JSON.stringify({ ...body, warning }), { status: res.status, headers: res.headers })
    },
  }
}

/**
 * The request handler for an environment: the sidecar when the configuration is complete, setup mode otherwise.
 * 按环境变量得到请求处理函数：配置完整时是旁路，否则是设置模式。
 */
export function createSidecar(env = process.env, { fetch, profile = NEW_API_PROFILE, log = (...a) => console.error(`[${profile.label}]`, ...a) } = {}) {
  let state = readConfig(env, profile)
  let proxy = null
  if (state.ok) {
    try { proxy = buildProxy(state.config, { fetch, log }) } catch (e) { state = { ok: false, missing: [], problem: e.message, signer: state.signer } }
    if (proxy && state.config.formatsWarning) proxy = withHealthWarning(proxy, state.config.formatsWarning)
  }
  // GET / (and HEAD /) only, and only when OPERATOR_SITE_URL is set and valid; in setup mode too, so a link to the
  // sidecar's host already lands on the operator's site. Every other path is untouched.
  // 只有 GET /（与 HEAD /），且只在 OPERATOR_SITE_URL 已设且有效时；设置模式下也一样。其它路径一概不动。
  const site = state.ok ? state.config.operatorSiteUrl : (operatorSiteOf(env?.OPERATOR_SITE_URL, env?.PUBLIC_URL).url ?? null)
  const answer = (request, { clientIp } = {}) => (proxy ? proxy.handleRequest(request, { clientIp }) : setupAnswer(state, request))
  return {
    state, proxy,
    config: state.ok ? state.config : null,
    handleRequest: (request, o) => (site ? siteRedirect(request, site) : null) ?? answer(request, o),
  }
}

/** 302 to the operator's own site for GET / or HEAD / (the configured location, URL-normalised, nothing added), else null.
 *  对 GET / 或 HEAD / 回 302 到服务方自己的站点（配置的地址按 URL 标准写法，不附加任何东西），否则为 null。 */
export function siteRedirect(request, site) {
  if (!site || (request.method !== 'GET' && request.method !== 'HEAD')) return null
  if (new URL(request.url).pathname !== '/') return null
  return new Response(null, { status: 302, headers: { location: site, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } })
}

/**
 * SIGNER_KEY_GENERATE=1 with SIGNER_KEY_FILE: create the signing key file when it does not exist yet, on this machine
 * only, readable by its owner only (0600), created exclusively (never overwrites a key). Returns { created, signer } or
 * { created: false, why } and logs one line with the ADDRESS only: the key is never logged, printed or sent anywhere.
 * Nothing happens when SIGNER_KEY is set, when the switch is off, or when SIGNER_ADDRESS is set (a key file that went
 * missing is then setup mode, which names the problem, instead of a new key the delegation does not name).
 * SIGNER_KEY_GENERATE=1 且设了 SIGNER_KEY_FILE：该文件还不存在时在本机生成签名密钥文件，仅所有者可读（0600），独占创建（从不覆盖已有
 * 密钥）。只记录一行**地址**：密钥从不写进日志、不打印、不发送到任何地方。设了 SIGNER_KEY、没打开开关、或设了 SIGNER_ADDRESS 时什么都不做
 * （那时密钥文件丢失就是设置模式并说明问题，而不是换一把委托里没有的新密钥）。
 * @param {Record<string, string|undefined>} rawEnv
 * @param {{ log?: (line: string) => void, randomKey?: () => string }} [o]
 */
export function ensureSignerKeyFile(rawEnv = process.env, { log = () => {}, randomKey = sig.randomPrivateKey } = {}) {
  const env = Object.fromEntries(Object.entries(rawEnv || {}).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]))
  if (env.SIGNER_KEY_GENERATE !== '1') return { created: false, why: 'off' }
  if (env.SIGNER_KEY) return { created: false, why: 'SIGNER_KEY is set' }
  const file = env.SIGNER_KEY_FILE
  if (!file) { log('SIGNER_KEY_GENERATE=1 needs SIGNER_KEY_FILE (where the key is kept); no key was created'); return { created: false, why: 'no SIGNER_KEY_FILE' } }
  if (existsSync(file)) {
    // An existing key file stays as it is; a group- or world-readable one is worth a line. / 已有的密钥文件保持原样；他人可读时提示一句。
    try { if (process.platform !== 'win32' && (statSync(file).mode & 0o077)) log(`${file} can be read by other users of this machine: chmod 600 it`) } catch { /* readConfig reports it */ }
    return { created: false, why: 'exists' }
  }
  if (env.SIGNER_ADDRESS) { log(`SIGNER_KEY_FILE ${file} does not exist and SIGNER_ADDRESS is set: no new key was created (restore the key file, or remove SIGNER_ADDRESS and sign a new delegation)`); return { created: false, why: 'SIGNER_ADDRESS is set' } }
  const key = randomKey()
  const signer = sig.privateKeyToAddress(key)
  try { writeFileSync(file, `${key}\n`, { flag: 'wx', mode: 0o600 }) } catch (e) {
    log(`could not create ${file} (${e.code || 'error'}); no key was created`)
    return { created: false, why: e.code || 'error' }
  }
  log(`created a new signing key in ${file} (readable by its owner only). Its address: ${signer}. The key itself is not shown and never leaves this machine.`)
  log(`next: the delegation must name exactly this address (OPERATOR-KIT.md, "A key made on the server"), then set DELEGATION_EXPIRES and DELEGATION_SIG`)
  return { created: true, signer }
}

/** The client's address: the trusted header when configured (the right-most entry of a list: the one your proxy added),
 *  else the TCP peer. The header's address is written one way per address (IPv6 compressed and lowercase, an
 *  IPv4-mapped IPv6 address as its IPv4), so one client is one rate-limit key; a value that is not an address is
 *  'unknown'. / 客户端地址：配置了可信请求头时取它（列表取最右一项，即你的代理加上的那项），否则取 TCP 对端。头里的地址每个
 *  只有一种写法（一个客户端只占一个限流键）；不是地址的值为 'unknown'。 */
export function clientIpOf(req, header) {
  if (header) {
    const v = req.headers[header]
    const s = Array.isArray(v) ? v[v.length - 1] : v
    const last = typeof s === 'string' ? s.split(',').map((x) => x.trim()).filter(Boolean).pop() : null
    if (last) return canonicalIp(last)
  }
  return req.socket.remoteAddress || 'unknown'
}
function canonicalIp(s) {
  const kind = isIP(s)
  if (kind === 4) return s
  if (kind !== 6) return 'unknown'
  let a
  try { a = new URL(`http://[${s}]/`).hostname.slice(1, -1) } catch { return 'unknown' }   // a zone id ('%eth0') / 带区域标识
  const m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a)
  if (!m) return a
  const hi = parseInt(m[1], 16), lo = parseInt(m[2], 16)
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.')
}

/**
 * Listen and serve. Node's http <-> the fetch-style handler, streaming both ways: an event stream is written chunk by
 * chunk as it comes, never buffered (the same bridge as examples/ai-proxy/index.mjs).
 * 监听并服务。Node http 与 fetch 风格处理函数之间双向流式转换：事件流逐块写出，从不缓冲。
 * @param {{ env?: object, port?: number, host?: string, fetch?: Function, log?: Function, quiet?: boolean,
 *           localPublicUrl?: boolean, profile?: SidecarProfile }} [o]  localPublicUrl: TESTING ONLY, PUBLIC_URL defaults to
 *           http://127.0.0.1:<port>; profile: the gateway in front of which it stands (default new-api's)
 */
export async function startSidecar({ env = process.env, port, host, fetch, log, quiet = false, localPublicUrl = false, profile = NEW_API_PROFILE } = {}) {
  const say = quiet ? () => {} : (l) => console.log(`[${profile.label}] ${l}`)
  let sidecar = null
  const server = http.createServer(async (req, res) => {
    try {
      if (!sidecar) { res.writeHead(503, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"starting","type":"tapeapi_proxy_error","code":"starting"}}') }
      const headers = new Headers()
      for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) { try { headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]) } catch { /* not a fetch header */ } }
      const hasBody = !['GET', 'HEAD'].includes(req.method)
      let it = null
      const body = hasBody ? new ReadableStream({
        async pull(c) { it ??= req[Symbol.asyncIterator](); const { done, value } = await it.next(); if (done) c.close(); else c.enqueue(new Uint8Array(value)) },
        cancel() { req.destroy() },
      }, { highWaterMark: 0 }) : undefined
      const r = await sidecar.handleRequest(new Request(new URL(req.url, 'http://127.0.0.1'), { method: req.method, headers, body, duplex: 'half' }), { clientIp: clientIpOf(req, sidecar.config?.clientIpHeader) })
      res.writeHead(r.status, Object.fromEntries(r.headers))
      if (!r.body) return res.end()
      res.on('close', () => { if (!res.writableEnded) r.body.cancel().catch(() => {}) })   // the client went away / 客户端离开
      for await (const chunk of r.body) res.write(chunk)
      res.end()
    } catch (e) {
      console.error(`[${profile.label}] request failed:`, e?.message || e)
      if (!res.headersSent) { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":{"message":"malformed request","type":"tapeapi_proxy_error","code":"bad_request"}}') } else res.destroy()
    }
  })
  // No overall request timeout: a stream may run for minutes. Headers must still arrive in 15 s.
  // 不设整体请求超时：流可能持续数分钟。请求头仍须在 15 秒内到达。
  server.requestTimeout = 0
  server.headersTimeout = 15_000
  const listenPort = Number(port ?? env.PORT ?? 8080)
  const listenHost = host ?? env.HOST ?? '127.0.0.1'
  await new Promise((resolve, reject) => server.once('error', reject).listen(listenPort, listenHost, resolve))
  const actual = server.address().port
  const effective = localPublicUrl && !env.PUBLIC_URL ? { ...env, PUBLIC_URL: `http://127.0.0.1:${actual}` } : env
  // A key made on this machine, when asked for (SIGNER_KEY_GENERATE=1): only its address is said. / 按要求在本机生成密钥，只说地址。
  ensureSignerKeyFile(effective, { log: (l) => say(`key      ${l}`) })
  sidecar = createSidecar(effective, { fetch, profile, ...(log ? { log } : {}) })

  const { state } = sidecar
  say(`listening on http://${listenHost}:${actual}`)
  if (!state.ok) {
    say(`SETUP MODE: ${state.problem || `missing ${state.missing.join(', ')}`}`)
    say(`signer   ${state.signer ?? '(no SIGNER_KEY yet)'}`)
    say(`next     open ${CONSOLE_URL}; it reads the signer from ${effective.PUBLIC_URL ? effective.PUBLIC_URL.replace(/\/+$/, '') : '<PUBLIC_URL>'}/tapeapi/v1/health`)
  } else {
    const m = sidecar.proxy.manifest(), c = state.config
    say(`${m.name}: signer ${m.signer}, container ${m.container}, delegation until ${new Date(m.delegation.expires * 1000).toISOString().slice(0, 10)}`)
    say(`upstream ${c.upstreamBaseUrl}   (${profile.upstreamName}; your users' keys pass through to it unchanged)`)
    for (const e of m.ai.endpoints) say(`${e.format.padEnd(18)} ${e.baseUrl}`)
    if (c.formatsWarning) say(`WARNING  ${c.formatsWarning}`)
    say(`models   ${m.ai.models.length} priced (${m.ai.models.slice(0, 6).map((x) => x.id).join(', ')}${m.ai.models.length > 6 ? ', ...' : ''}) from ${c.modelsFile}`)
    say(`manifest ${c.publicUrl}/.well-known/tapeapi.json   (publish it on chain from ${CONSOLE_URL})`)
    if (c.rateIp && !c.clientIpHeader) say(`rate     ${c.rateIp}/min per TCP peer: behind a reverse proxy set CLIENT_IP_HEADER, or all callers share one bucket (RATE_IP=0 leaves limits to ${profile.upstreamName})`)
    if (c.tapeName) {
      // Claude Code speaks anthropic-messages and Codex openai-responses: named only when FORMATS enables that format.
      // Claude Code 用 anthropic-messages，Codex 用 openai-responses：只有 FORMATS 启用了对应格式才点名。
      const on = new Set(m.ai.endpoints.map((e) => e.format))
      const clients = [['Claude Code', 'anthropic-messages'], ['Codex', 'openai-responses']]
      const served = clients.filter(([, f]) => on.has(f)).map(([n]) => n)
      say(`verify   clients can check every receipt with: tapeapi-verify ${c.tapeName}${served.length ? `; ${served.join(' and ')} can use it too` : ''}`)
      for (const [n, f] of clients.filter(([, f]) => !on.has(f))) say(`         ${n} calls ${f}, which ${FORMATS_VAR} does not enable: its calls are refused here (HTTP 400), with no receipt`)
    }
    // From 7 days left, the doctor's RENEW_DAYS (it was 30 before 3.0, when the console signed 90 days) / 剩 7 天起，同 doctor 的 RENEW_DAYS
    const days = Math.floor((m.delegation.expires * 1000 - Date.now()) / 86_400_000)
    if (days < 7) say(`RENEW    the delegation expires in ${days} days: renew it in step 4 of ${CONSOLE_URL}`)
  }
  const site = sidecar.state.ok ? sidecar.state.config.operatorSiteUrl : null
  if (site) say(`site     GET / answers 302 to ${site} (OPERATOR_SITE_URL)`)
  return {
    server, port: actual, url: `http://127.0.0.1:${actual}`, state, proxy: sidecar.proxy, handleRequest: sidecar.handleRequest,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()) }),
  }
}

// Run as a program (not when imported by the smoke test or the tests). / 作为程序运行时启动（被测试导入时不启动）。
const isMain = (() => { try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) } catch { return false } })()
if (isMain) {
  const s = await startSidecar()
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await s.close(); process.exit(0) })
}
