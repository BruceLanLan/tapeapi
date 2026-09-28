#!/usr/bin/env node
// Read-only monitor for the live TapeAPI services. Sends no transactions, holds no keys.
// For each service: GET health, resolve it from the chain exactly as a client would (SDK, 3 public BSC nodes of distinct operators, quorum 2),
// check that the on-chain manifest's signer is the one the service answers with, count the days until its delegation
// expires, and make one real call whose signed envelope the SDK verifies. Also GET the website and the docs.
// Exit 0 when everything is healthy, 1 when anything is down or a delegation expires in fewer than 14 days.
//
//   node scripts/monitor.mjs          Markdown report on stdout (used as the GitHub issue body)
//   node scripts/monitor.mjs --json   the raw results and the evaluation as JSON
//
// 只读监控：不发交易、不持有任何密钥。对每个服务：取健康检查；像客户端一样用 SDK 从链上解析它（3 家不同运营方的公共节点、quorum 2）；
// 核对链上清单的 signer 与服务实际使用的一致；计算委托到期天数；做一次真实调用并由 SDK 验签。另外检查官网与文档。
// 全部健康退出码 0；任何服务不可用、或委托不足 14 天到期，退出码 1。
import { fileURLToPath } from 'node:url'
import { rpcUrlsFor } from '../sdk/src/rpc-defaults.js'

// The SDK's defaults: three distinct operators (NodeReal, Alchemy, 48 Club) / SDK 默认：三家运营方
export const RPC_URLS = rpcUrlsFor(56)
export const PROCESSOR = '0xe02c26c7432A7121168AA9B610DE24eCf9a1a414'   // processor 1013
export const HEALTH_PATH = '/tapeapi/v1/health'
export const WARN_DAYS = 14
const DAY_S = 86400

const randomRoom = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('')

// The one list to extend. `probe` is a free method whose answer the SDK verifies against the on-chain signer;
// `check` says whether the verified result looks right.
// 要扩展就改这一处。`probe` 是一个免费方法，SDK 按链上 signer 验签；`check` 判断验过签的结果是否合理。
export const SERVICES = [
  {
    name: 'api', label: '11.1013.tape', base: 'https://api.tapeapi.fun', circuits: PROCESSOR, tokenId: 11,
    probe: {
      method: 'blockNumber', params: () => ({}),
      check: (r) => Number.isInteger(r?.blockNumber) && r.blockNumber > 0,
      detail: (r) => `block ${r?.blockNumber}`,
    },
  },
  {
    name: 'relay', label: '12.1013.tape', base: 'https://relay.tapeapi.fun', circuits: PROCESSOR, tokenId: 12,
    probe: {
      // A random room nobody posted to: TAP-26 says the answer is no frames and epoch null, and it creates nothing.
      // 一个没人发过消息的随机房间：TAP-26 规定答案是无帧、epoch 为 null，且不会创建房间。
      method: 'relayRecv', params: () => ({ room: randomRoom(), after: -1, waitMs: 0 }),
      check: (r) => Array.isArray(r?.frames) && r.frames.length === 0,
      detail: (r) => `empty room, ${Array.isArray(r?.frames) ? r.frames.length : '?'} frames`,
    },
  },
]
export const PAGES = [
  { name: 'website', url: 'https://tapeapi.fun/' },
  { name: 'docs', url: 'https://tapeapi.fun/docs/' },
]

// ---------------------------------------------------------------- pure helpers (unit-tested, no network) / 纯函数

const lc = (a) => (typeof a === 'string' ? a.toLowerCase() : a)
const short = (a) => (typeof a === 'string' && a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : String(a ?? '-'))
const msg = (e) => String(e?.code ? `${e.code}: ${e.message}` : e?.message ?? e).replace(/\s+/g, ' ').slice(0, 200)

/** Whole days from `now` to `expires` (both unix seconds), rounded down; negative once expired. */
export function daysUntil(expires, now) { return Math.floor((expires - now) / DAY_S) }

/** The expiry that bites first: the on-chain manifest's (what clients check) or the service's own (what it enforces). */
export function effectiveExpiry(svc) {
  const xs = [svc?.chain?.expires, svc?.health?.delegationExpires].filter((x) => Number.isFinite(x))
  return xs.length ? Math.min(...xs) : null
}

/**
 * results: { services: [{ name, label, health: { status, ok, signer, delegationExpires, latencyMs, error },
 *                         chain: { signer, expires, error }, call: { method, ok, skipped, error } }],
 *            pages: [{ name, url, status, error }] }
 * now: unix seconds.  Returns { healthy, problems[], warnings[] }.
 */
export function evaluate(results, now = Math.floor(Date.now() / 1000), { warnDays = WARN_DAYS } = {}) {
  const problems = []
  const warnings = []
  for (const s of results?.services ?? []) {
    const n = s.name
    const h = s.health ?? {}
    const c = s.chain ?? {}
    if (h.error || h.status !== 200) problems.push(`${n}: health check failed (${h.error ?? `HTTP ${h.status}`})`)
    else if (h.ok !== true) problems.push(`${n}: health answers ok=${JSON.stringify(h.ok)}`)
    if (c.error) problems.push(`${n}: on-chain resolve failed (${c.error})`)
    if (c.signer && h.signer && lc(c.signer) !== lc(h.signer)) problems.push(`${n}: signer mismatch, chain ${c.signer} vs service ${h.signer}`)
    else if (c.signer && !h.error && h.status === 200 && !h.signer) problems.push(`${n}: health reports no signer`)
    const exp = effectiveExpiry(s)
    if (exp == null) { if (!c.error && !h.error) problems.push(`${n}: delegation expiry unknown`) }
    else if (exp <= now) problems.push(`${n}: delegation EXPIRED ${new Date(exp * 1000).toISOString().slice(0, 10)}; every answer is rejected until the holder re-signs it`)
    else if (daysUntil(exp, now) < warnDays) problems.push(`${n}: delegation expires in ${daysUntil(exp, now)} days (${new Date(exp * 1000).toISOString().slice(0, 10)}); re-sign it now`)
    if (Number.isFinite(c.expires) && Number.isFinite(h.delegationExpires) && c.expires !== h.delegationExpires) {
      warnings.push(`${n}: service reports delegationExpires ${h.delegationExpires}, on-chain manifest says ${c.expires}`)
    }
    const k = s.call ?? {}
    if (!k.skipped && (k.error || k.ok !== true)) problems.push(`${n}: verified ${k.method ?? 'call'} failed (${k.error ?? 'unexpected result'})`)
  }
  for (const p of results?.pages ?? []) {
    if (p.error || p.status !== 200) problems.push(`${p.name}: ${p.url} ${p.error ?? `HTTP ${p.status}`}`)
  }
  return { healthy: problems.length === 0, problems, warnings }
}

/** The Markdown report: one table for the services, one for the pages, then the problems. */
export function report(results, evaluation, now = Math.floor(Date.now() / 1000)) {
  const when = new Date(now * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
  const L = []
  L.push(`## TapeAPI monitor: ${evaluation.healthy ? 'all healthy' : `${evaluation.problems.length} problem(s)`}`, '', `Checked ${when}.`, '')
  L.push('| Service | Health | Latency | Signer (chain = service) | Delegation expires | Verified call |')
  L.push('|---|---|---|---|---|---|')
  for (const s of results.services) {
    const h = s.health ?? {}; const c = s.chain ?? {}; const k = s.call ?? {}
    const health = h.error ? `DOWN (${h.error})` : h.status !== 200 ? `DOWN (HTTP ${h.status})` : h.ok === true ? 'up' : `ok=${h.ok}`
    const lat = Number.isFinite(h.latencyMs) ? `${h.latencyMs} ms` : '-'
    const signer = c.error ? `chain: ${c.error}` : !h.signer ? short(c.signer) + ' (service: none)'
      : lc(c.signer) === lc(h.signer) ? `${short(h.signer)} match` : `MISMATCH ${short(c.signer)} / ${short(h.signer)}`
    const exp = effectiveExpiry(s)
    const expiry = exp == null ? '-' : `${new Date(exp * 1000).toISOString().slice(0, 10)} (${daysUntil(exp, now)} d)`
    const call = k.skipped ? 'skipped' : k.ok ? `${k.method} ok${k.detail ? `, ${k.detail}` : ''}${Number.isFinite(k.latencyMs) ? ` (${k.latencyMs} ms)` : ''}` : `${k.method ?? 'call'} FAILED${k.error ? ` (${k.error})` : ''}`
    L.push(`| ${s.name} \`${s.label}\` | ${health} | ${lat} | ${signer} | ${expiry} | ${call} |`.replace(/\n/g, ' '))
  }
  L.push('', '| Page | Status | Latency |', '|---|---|---|')
  for (const p of results.pages) L.push(`| ${p.url} | ${p.error ? `DOWN (${p.error})` : p.status} | ${Number.isFinite(p.latencyMs) ? `${p.latencyMs} ms` : '-'} |`)
  L.push('')
  if (evaluation.problems.length) L.push('**Problems**', '', ...evaluation.problems.map((p) => `- ${p}`), '')
  if (evaluation.warnings.length) L.push('Notes', '', ...evaluation.warnings.map((p) => `- ${p}`), '')
  return L.join('\n').trimEnd()
}

// ---------------------------------------------------------------- network / 网络

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** Public nodes and edges are flaky: one retry before a step counts as failed. / 公共节点不稳：失败前重试一次。 */
export async function retry(fn, { tries = 2, pauseMs = 2000 } = {}) {
  let last
  for (let i = 0; i < tries; i++) {
    try { return await fn(i) } catch (e) { last = e; if (i < tries - 1) await sleep(pauseMs) }
  }
  throw last
}

async function timedFetch(url, timeoutMs = 15000) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(new Error(`timeout after ${timeoutMs} ms`)), timeoutMs)
  const t0 = performance.now()
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json, text/html' }, redirect: 'follow' })
    const text = await res.text()
    return { res, text, latencyMs: Math.round(performance.now() - t0) }
  } finally { clearTimeout(t) }
}

async function checkHealth(svc) {
  try {
    return await retry(async () => {
      const { res, text, latencyMs } = await timedFetch(svc.base + HEALTH_PATH)
      if (res.status !== 200) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status })
      let j; try { j = JSON.parse(text) } catch { throw new Error('health is not JSON') }
      return { status: res.status, ok: j.ok, signer: j.signer ?? null, delegationExpires: Number.isFinite(j.delegationExpires) ? j.delegationExpires : null, version: j.version ?? null, latencyMs }
    })
  } catch (e) { return { status: e.status ?? null, error: msg(e) } }
}

async function checkChainAndCall(api, svc) {
  let resolved
  const chain = {}
  try {
    resolved = await retry(() => api.resolve({ circuits: svc.circuits, tokenId: svc.tokenId }))
    chain.container = resolved.container
    chain.signer = resolved.manifest.signer
    chain.expires = resolved.manifest.delegation?.expires ?? null
    chain.endpoints = resolved.manifest.endpoints?.live ?? []
  } catch (e) { chain.error = msg(e) }
  const call = { method: svc.probe.method }
  if (!resolved) return { chain, call: { ...call, skipped: true } }
  try {
    const t0 = performance.now()
    const out = await retry(() => api.call(resolved, svc.probe.method, svc.probe.params(), { timeoutMs: 20000 }))
    call.latencyMs = Math.round(performance.now() - t0)
    call.ok = out?.verified === true && svc.probe.check(out.result)
    call.detail = svc.probe.detail(out?.result)
    if (!call.ok) call.error = out?.verified !== true ? 'envelope not verified' : `unexpected result ${JSON.stringify(out?.result).slice(0, 120)}`
  } catch (e) { call.ok = false; call.error = msg(e) }
  return { chain, call }
}

async function checkPage(p) {
  try {
    return await retry(async () => {
      const { res, latencyMs } = await timedFetch(p.url)
      if (res.status !== 200) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status })
      return { ...p, status: res.status, latencyMs }
    })
  } catch (e) { return { ...p, status: e.status ?? null, error: msg(e) } }
}

export async function run({ services = SERVICES, pages = PAGES, rpcUrls = RPC_URLS } = {}) {
  const { createTapeAPI } = await import('../sdk/src/index.js')
  const api = createTapeAPI({ rpcUrls, quorum: 2, rpcTimeoutMs: 25000 })
  const svcResults = await Promise.all(services.map(async (svc) => {
    const [health, cc] = await Promise.all([checkHealth(svc), checkChainAndCall(api, svc)])
    return { name: svc.name, label: svc.label, base: svc.base, health, ...cc }
  }))
  const pageResults = await Promise.all(pages.map(checkPage))
  return { checkedAt: new Date().toISOString(), services: svcResults, pages: pageResults }
}

async function main() {
  const json = process.argv.includes('--json')
  let results
  try { results = await run() } catch (e) {
    // The monitor itself broke (e.g. the SDK failed to load): that is a failure too, and the report says why.
    const text = `## TapeAPI monitor: the monitor itself failed\n\n${msg(e)}\n`
    process.stdout.write(json ? JSON.stringify({ healthy: false, problems: [`monitor crashed: ${msg(e)}`] }, null, 2) + '\n' : text)
    process.exitCode = 1
    return
  }
  const now = Math.floor(Date.now() / 1000)
  const evaluation = evaluate(results, now)
  process.stdout.write(json ? JSON.stringify({ ...results, ...evaluation }, null, 2) + '\n' : report(results, evaluation, now) + '\n')
  // exitCode, not exit(): stdout to a pipe is asynchronous on macOS and exit() could cut the report short.
  process.exitCode = evaluation.healthy ? 0 : 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main()
