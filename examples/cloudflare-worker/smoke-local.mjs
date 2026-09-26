#!/usr/bin/env node
// Local smoke test of the relay Worker on the real Workers runtime (workerd, through `wrangler dev --local`): real
// Durable Objects, real DO alarms, real request streams. NOT part of `npm test` (npx fetches wrangler from npm the
// first time). Beyond that the Worker reaches nothing: RPC points at dead local ports, nothing is deployed, no login.
// 在真实 Workers 运行时（workerd，经 `wrangler dev --local`）上对中继 Worker 做本地冒烟测试：真实的 Durable Object、
// 真实的 DO alarm、真实的请求流。**不属于** `npm test`（第一次要由 npx 从 npm 取 wrangler）。除此之外 Worker 不连任何地方：
// RPC 指向本机的死端口，不部署任何东西，无需登录。
//
//   node examples/cloudflare-worker/smoke-local.mjs            # all runs / 全部
//   node examples/cloudflare-worker/smoke-local.mjs free sweep # some / 部分：free | sweep | priced | priced-d1
//   WRANGLER=wrangler@4.135.0 KEEP=1 node ...                  # pin another version; keep the temp dir / 换版本；保留临时目录
//
// Each run copies wrangler-relay.toml into a temp dir (so `.wrangler/` state lands there, not in the repo), with
// `main` made absolute and, for priced-d1 only, the commented D1 block filled in with a dummy id for a LOCAL database.
// 每次运行把 wrangler-relay.toml 复制到临时目录（`.wrangler/` 状态落在那里而不是仓库里），只把 `main` 改成绝对路径；
// 仅 priced-d1 会补上 D1 块，用假 id 指向一个**本地**数据库。
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { privateKeyToAddress, signDigest, delegationDigest, recoverResponseSigner } from '../../sdk/src/sig.js'
import { ADDR } from '../../sdk/test/helpers/fake-chain.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const WRANGLER = process.env.WRANGLER || 'wrangler@4.135.0'
const HOLDER_KEY = '0x' + '11'.repeat(32), SIGNER_KEY = '0x' + '22'.repeat(32)
const signer = privateKeyToAddress(SIGNER_KEY)
const EXPIRES = Math.floor(Date.now() / 1000) + 30 * 86400
// A throwaway identity, the same one review-arch.test.mjs uses; only the local runtime ever sees it.
// 一次性身份，与 review-arch.test.mjs 相同；只有本地运行时见得到。
const IDENTITY = {
  SIGNER_KEY, SIGNER_ADDRESS: signer, CIRCUITS: ADDR.circuits, TOKEN_ID: '4246', CONTAINER: ADDR.container,
  DELEGATION_EXPIRES: String(EXPIRES),
  DELEGATION_SIG: signDigest(delegationDigest(56, ADDR.hub, { container: ADDR.container, signer, expires: EXPIRES }), HOLDER_KEY),
  PUBLIC_URL: 'https://relay.example', RPC_URLS: 'http://127.0.0.1:9,http://127.0.0.1:10',   // dead ports: no network / 死端口，不联网
}
const METER_SQL = 'CREATE TABLE IF NOT EXISTS meter (consumer TEXT NOT NULL, provider TEXT NOT NULL, cumulative TEXT NOT NULL, expires INTEGER NOT NULL, sig TEXT NOT NULL, signer TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (consumer, provider))'

const room = (n) => n.toString(16).padStart(64, '0')
const b64 = (...bytes) => Buffer.from(Uint8Array.of(...bytes)).toString('base64')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (ok, what, detail = '') => { if (!ok) failures++; console.log(`  ${ok ? 'PASS' : 'FAIL'} ${what}${detail ? `  (${detail})` : ''}`) }

function configFor(dir, { d1 = false } = {}) {
  let toml = readFileSync(join(HERE, 'wrangler-relay.toml'), 'utf8')
  toml = toml.replace(/^main = ".*"$/m, `main = ${JSON.stringify(join(HERE, 'relay-worker.js'))}`)
  if (d1) toml += '\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "tapeapi-relay-meter"\ndatabase_id = "00000000-0000-0000-0000-000000000000"\n'
  const file = join(dir, 'wrangler.toml')
  writeFileSync(file, toml)
  return file
}

// --prefer-offline: once cached, npx skips the registry round trip (over a slow proxy it took over a minute per spawn).
// --prefer-offline：缓存过之后 npx 不再查询 registry（经慢代理时每次启动要一分多钟）。
function wrangler(args, { cwd, log }) {
  const child = spawn('npx', ['--prefer-offline', '-y', WRANGLER, ...args], {
    cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    // CLOUDFLARE_CF_FETCH_ENABLED=false: miniflare would otherwise fetch a Request.cf sample from Cloudflare at startup.
    // 否则 miniflare 启动时会去 Cloudflare 取一份 Request.cf 样本。
    env: { ...process.env, CI: '1', NO_COLOR: '1', WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_CF_FETCH_ENABLED: 'false' },
  })
  child.stdout.on('data', (d) => log.push(String(d))); child.stderr.on('data', (d) => log.push(String(d)))
  child.done = new Promise((r) => child.once('exit', r))
  return child
}

// One `wrangler dev` per run: its own port, temp dir and vars. / 每次运行一个 `wrangler dev`：各自的端口、临时目录与变量。
async function withDev(name, vars, { d1 = false } = {}, body) {
  const dir = mkdtempSync(join(tmpdir(), `tapeapi-smoke-${name}-`))
  const config = configFor(dir, { d1 })
  const port = 18000 + Math.floor(Math.random() * 2000)
  const log = []
  console.log(`\n== ${name}: ${WRANGLER} dev --local on :${port} (${dir})`)
  if (d1) {
    const exec = wrangler(['d1', 'execute', 'tapeapi-relay-meter', '--local', '-c', config, '--persist-to', join(dir, 'state'), '--command', METER_SQL], { cwd: dir, log })
    const code = await exec.done
    check(code === 0, 'local D1: meter schema applied', `wrangler d1 execute --local exit ${code}`)
  }
  const varArgs = Object.entries({ ...IDENTITY, ...vars }).flatMap(([k, v]) => ['--var', `${k}:${v}`])
  const child = wrangler(['dev', '-c', config, '--local', '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', String(port + 1),
    '--persist-to', join(dir, 'state'), '--show-interactive-dev-session=false', ...varArgs], { cwd: dir, log })
  const base = `http://127.0.0.1:${port}`
  try {
    let up = null
    for (let t = 0; t < 120 && !up; t++) {
      if (child.exitCode != null) break
      try { up = await fetch(`${base}/tapeapi/v1/health`) } catch { await sleep(500) }
    }
    if (!up) throw new Error(`wrangler dev did not come up:\n${log.join('').slice(-3000)}`)
    await body({ base, first: up, log })
  } finally {
    try { process.kill(-child.pid, 'SIGTERM') } catch { /* gone */ }
    await Promise.race([child.done, sleep(5000)])
    try { process.kill(-child.pid, 'SIGKILL') } catch { /* gone */ }
    if (process.env.VERBOSE) console.log(log.join(''))
    if (!process.env.KEEP) rmSync(dir, { recursive: true, force: true })
  }
}

let seq = 0
async function call(base, method, params, headers = {}) {
  const r = await fetch(`${base}/tapeapi/v1/${method}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ id: `s${++seq}`, params }) })
  const text = await r.text()
  let json = null; try { json = JSON.parse(text) } catch { /* not JSON */ }
  return { status: r.status, json, text }
}
const signedBy = (method, params, env) => { try { return recoverResponseSigner({ container: env.container, id: env.id, method, params, ok: env.ok, body: env.ok ? env.result : env.error, ts: env.ts }, env.sig) } catch { return null } }

const RUNS = {
  // (a) the 0x03 survives a 0x02 flood; (d) the per-IP new-room budget. / 0x03 挺过 0x02 洪水；按 IP 的新房间额度。
  async free() {
    await withDev('free', { RATE_NEW_ROOMS: '3' }, {}, async ({ base, first }) => {
      const h = await first.json()
      check(first.status === 200 && h.ok === true && h.signer === signer, 'health answers on workerd', `status ${first.status}, signer ${h.signer}`)
      const r = room(1)
      const inviteParams = { room: r, frame: b64(0x03, ...new Array(60).fill(7)) }
      const inv = await call(base, 'relaySend', inviteParams)
      check(inv.status === 200 && inv.json?.ok && inv.json.result.i === 0, 'one 0x03 posted', inv.text.slice(0, 120))
      check(signedBy('relaySend', inviteParams, inv.json)?.toLowerCase() === signer.toLowerCase(), 'the answer is signed by the delegated signer')
      let okN = 0
      for (let k = 0; k < 300; k++) { const s = await call(base, 'relaySend', { room: r, frame: 'AgAA' }); if (s.json?.ok) okN++ }
      check(okN === 300, '300 0x02 frames posted after it (the frame ring holds 256)', `${okN} ok`)
      const got = await call(base, 'relayRecv', { room: r, after: -1, waitMs: 0 })
      const types = (got.json?.result?.frames || []).map((f) => Buffer.from(f.frame, 'base64')[0])
      check(types.filter((t) => t === 0x03).length === 1, 'relayRecv still returns the 0x03', `${types.length} frames: ${types.filter((t) => t === 0x03).length} x 0x03, ${types.filter((t) => t === 0x02).length} x 0x02`)
      check(got.json?.result?.frames?.[0]?.i === 0, 'the 0x03 is first, in posting order', `first i = ${got.json?.result?.frames?.[0]?.i}`)

      // control for the sweep run: with the production 5-minute alarm, a posted room is still there after a 3 s long-poll
      // 清理那一轮的对照：用生产的 5 分钟 alarm，投递过的房间在 3 秒长轮询之后仍在
      const p2 = await call(base, 'relaySend', { room: room(2), frame: 'AgAA' })
      const lp = await call(base, 'relayRecv', { room: room(2), after: 0, waitMs: 3000 })
      check(lp.json?.ok && lp.json.result.epoch === p2.json?.result?.epoch, 'control: default alarm, room kept across a 3 s long-poll', `epoch ${lp.json?.result?.epoch}`)

      // (d) RATE_NEW_ROOMS = 3: rooms 1 and 2 are used, room 3 is the third, room 4 is refused before idFromName.
      // RATE_NEW_ROOMS = 3：房间 1、2 已用，房间 3 是第三个，房间 4 在 idFromName 之前被拒。
      const third = await call(base, 'relaySend', { room: room(3), frame: 'AgAA' })
      check(third.json?.ok === true, 'third new room accepted')
      const fourth = await call(base, 'relaySend', { room: room(4), frame: 'AgAA' })
      check(fourth.status === 400 && fourth.json?.error?.code === 'BAD_REQUEST' && /too many new rooms/.test(fourth.json.error.message), 'fourth new room refused', `${fourth.status} ${fourth.json?.error?.message}`)
      const again = await call(base, 'relaySend', { room: room(1), frame: 'AgAA' })
      check(again.json?.ok === true, 'a room already used is still served')
      const hs = await call(base, 'relayHandshake', { room: room(5), frame: b64(0x01, ...new TextEncoder().encode('{"t":"accept"}')) })
      check(hs.status === 400 && /too many new rooms/.test(hs.json?.error?.message || ''), 'the free handshake path spends the same budget', `${hs.status} ${hs.json?.error?.message}`)
      // Informational: does the local runtime let a client-written cf-connecting-ip through? (Cloudflare's edge overwrites it.)
      // 仅供参考：本地运行时是否放行客户端自填的 cf-connecting-ip？（Cloudflare 边缘会覆盖它。）
      const spoof = await call(base, 'relaySend', { room: room(6), frame: 'AgAA' }, { 'cf-connecting-ip': '198.51.100.9' })
      console.log(`  INFO a client-sent cf-connecting-ip ${spoof.json?.ok ? 'IS honoured locally (a different budget)' : 'is ignored locally (same budget)'}: ${spoof.status}`)
    })
  },
  // (c) the Durable Object alarm fires and sweeps. / DO alarm 触发并清理。
  async sweep() {
    await withDev('sweep', { RELAY_SWEEP_MS: '1000', RELAY_ROOM_TTL_MS: '1500' }, {}, async ({ base }) => {
      // A long-poll holds the object busy the whole time (so it cannot be evicted) without touching the room: only the
      // alarm can have removed it. / 长轮询让对象一直处于忙碌（不会被回收），又不触碰房间：只有 alarm 能删掉它。
      const sent = await call(base, 'relaySend', { room: room(10), frame: 'AgAA' })
      const t0 = Date.now()
      const lp = await call(base, 'relayRecv', { room: room(10), after: 0, waitMs: 8000 })
      check(sent.json?.ok && lp.json?.ok && lp.json.result.epoch === null && lp.json.result.frames.length === 0,
        'alarm swept the room while a long-poll kept its object alive', `posted epoch ${sent.json?.result?.epoch}, after ${Date.now() - t0} ms epoch ${lp.json?.result?.epoch}`)
      // And an idle room, no request in between. / 以及一个中间没有任何请求的空闲房间。
      const s2 = await call(base, 'relaySend', { room: room(11), frame: 'AgAA' })
      await sleep(5000)
      const got = await call(base, 'relayRecv', { room: room(11), after: -1, waitMs: 0 })
      check(s2.json?.ok && got.json?.result?.epoch === null && got.json.result.frames.length === 0, 'an idle room is gone 5 s later', `epoch ${got.json?.result?.epoch}`)
      // The alarm re-arms on a new post after going idle. / 闲置后新的投递会重新设 alarm。
      const s3 = await call(base, 'relaySend', { room: room(11), frame: 'AgAA' })
      check(s3.json?.ok && s3.json.result.i === 0 && s3.json.result.epoch !== s2.json?.result?.epoch, 'the same name re-created with a new epoch', `i ${s3.json?.result?.i}`)
    })
  },
  // (b) a priced relay without D1 refuses to serve. / 没有 D1 的收费中继拒绝服务。
  async priced() {
    await withDev('priced', { RELAY_PRICE_BEM: '0.00001', ESCROW: ADDR.escrow }, {}, async ({ base, first, log }) => {
      const body = await first.text()
      check(first.status === 500, 'health refused with 500', `status ${first.status}`)
      const s = await call(base, 'relaySend', { room: room(20), frame: 'AgAA' })
      check(s.status === 500, 'relaySend refused with 500 too (every request, not just the first)', `status ${s.status}`)
      await sleep(300)
      const said = /priced relay needs the D1 binding DB/.test(log.join('') + body)
      check(said, 'the reason is in the wrangler log or the error page')
    })
  },
  // (b') the same priced relay with a LOCAL D1 binding starts and meters. / 带本地 D1 的收费中继能启动。
  async 'priced-d1'() {
    await withDev('priced-d1', { RELAY_PRICE_BEM: '0.00001', ESCROW: ADDR.escrow }, { d1: true }, async ({ base, first }) => {
      const h = await first.json()
      check(first.status === 200 && h.ok === true, 'health answers with the D1 binding present')
      const s = await call(base, 'relaySend', { room: room(21), frame: 'AgAA' })
      check(s.status === 402 && s.json?.error?.code === 'PAYMENT_REQUIRED', 'relaySend without a voucher: 402 PAYMENT_REQUIRED', `${s.status} ${s.json?.error?.code}`)
      const hs = await call(base, 'relayHandshake', { room: room(21), frame: b64(0x01, ...new TextEncoder().encode('{"t":"accept"}')) })
      check(hs.json?.ok === true, 'relayHandshake stays free on a priced relay')
    })
  },
}

const want = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(RUNS)
for (const name of want) {
  if (!RUNS[name]) { console.error(`unknown run ${name}; one of ${Object.keys(RUNS).join(', ')}`); process.exit(2) }
  try { await RUNS[name]() } catch (e) { failures++; console.log(`  FAIL ${name}: ${e.message}`) }
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
