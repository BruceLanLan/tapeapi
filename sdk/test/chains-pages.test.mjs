// Multi-chain (workstream E) at the edges: receipts and MCP provenance, tapeapi-verify / tapeapi-mcp arguments, the
// verify page's logic, the dashboard's parser and the holder console's chain table, all offline.
// 多链（工作线 E）的外围：回执与 MCP 来源说明、tapeapi-verify / tapeapi-mcp 参数、核验页逻辑、面板的解析与操作台的链表，全部离线。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CHAINS, TapeAPIError, sig } from '../src/index.js'
import { receiptOf, toolResultOf } from '../src/mcp.js'
import { signResponse, recoverResponseSigner, privateKeyToAddress, randomPrivateKey, delegationTypedData, delegationDigest, signDigest } from '../src/sig.js'
import { nameClaim, checkName, verifyReceipt, parseReceipt, chainOfReceipt } from '../../site/verify/lib.js'
import { parseInput as dashboardInput } from '../../site/dashboard/lib.js'
import * as C from '../../site/console/lib.js'

const CIRCUITS = '0x839bdD6fa7A66416A609A735e11DE5411B98574e'   // processor 0 on X Layer AND on Base / X Layer 与 Base 上的 0 号处理器
const X_CONTAINER = '0xe2e5ffd861c8a0b50ce21a7bcbdd6bb5aac250ab'   // hub.accountOf(processor 0, #1) on X Layer (fixtures/chains-onchain.json)
const B_CONTAINER = '0x5c1f84a79ae2bf03adb7d7761299b9979e08fd57'   // ... on Base
const KEY = randomPrivateKey(), SIGNER = privateKeyToAddress(KEY)
const NOW = 1_800_000_000

function receipt({ container = X_CONTAINER, name = '1.2.0.tape', block } = {}) {
  const env = { container, id: 'mcp-1', ts: NOW - 60, ok: true, result: { v: 1 }, ...(block ? { block } : {}) }
  env.sig = signResponse({ container, id: env.id, method: 'm', params: {}, ok: true, body: env.result, ts: env.ts }, KEY)
  return receiptOf({ envelope: env, method: 'm', params: {}, circuits: CIRCUITS, tokenId: '1', name: name ?? undefined })   // null: no name / null 表示没有名字
}
const service = (container) => ({ container, manifest: { name: 'x', circuits: CIRCUITS, tokenId: '1', container, signer: SIGNER, delegation: { expires: NOW + 86400, sig: '0x' } }, verified: { delegation: true, holder: SIGNER } })

// ── receipts and MCP / 回执与 MCP ──────────────────────────────────────────────────────────────────────────────
test('a receipt keeps its frozen shape; an L2 service is told apart by its name, and the provenance line names its chain', () => {
  const r = receipt({ block: 71_824_813 })
  assert.deepEqual(Object.keys(r.service), ['circuits', 'tokenId', 'container', 'name'], 'no new field in service')
  assert.match(toolResultOf({ receipt: r, checkedBy: 'client' }).content[1].text, /Signed by TapeAPI service 1\.2\.0\.tape \(container 0x[0-9a-f]{40}\) at X Layer block 71824813\./)
  assert.match(toolResultOf({ receipt: receipt({ container: B_CONTAINER, name: '1.3.0.tape', block: 5 }), checkedBy: 'client' }).content[1].text, / at Base block 5\./)
  // BNB Chain wording is unchanged, with or without a name / BNB 的措辞不变
  assert.match(toolResultOf({ receipt: receipt({ name: '11.1013.tape', block: 9 }), checkedBy: 'client' }).content[1].text, / at BNB Chain block 9\./)
  assert.match(toolResultOf({ receipt: receipt({ name: null, block: 9 }), checkedBy: 'client' }).content[1].text, / at BNB Chain block 9\./)
})

// ── the verify page / 核验页 ─────────────────────────────────────────────────────────────────────────────────────
test('verify page: an L2 name selects the chain; the receipt is resolved and its name checked there', async () => {
  const r = parseReceipt(receipt())
  assert.deepEqual(nameClaim(r), { tokenId: '1', processor: '0', chainId: 196 })
  assert.equal(chainOfReceipt(r), 196)
  assert.equal(nameClaim(parseReceipt(receipt({ name: '1.2.0' }))), 'malformed', 'the suffix is part of the name a receipt carries')
  assert.equal(nameClaim(parseReceipt(receipt({ name: '1.4.0.tape' }))), 'malformed', 'an unassigned area code')
  assert.equal(chainOfReceipt(parseReceipt(receipt({ name: null }))), 56)
  const seen = []
  const io = {
    recover: recoverResponseSigner, now: NOW,
    resolve: async (t) => { seen.push(t); return service(t.chainId === 196 ? X_CONTAINER : B_CONTAINER) },
    cpuAt: async (p, chainId) => { seen.push({ p, chainId }); return CIRCUITS },
  }
  const out = await verifyReceipt(r, io)
  assert.equal(out.verdict, 'valid')
  assert.deepEqual(seen, [{ chainId: 196, circuits: CIRCUITS, tokenId: '1' }, { p: '0', chainId: 196 }])
  // The name is unsigned: one that points at Base for a receipt signed for the X Layer container derives Base's
  // container and fails the (signed) container check. / 名字未签名：指向 Base 的名字在 Base 推导出别的容器，过不了容器核对。
  const lying = parseReceipt({ ...receipt(), service: { ...receipt().service, name: '1.3.0.tape' } })
  const bad = await verifyReceipt(lying, io)
  assert.deepEqual([bad.verdict, bad.failed], ['invalid', 'container'])
  // BNB names still call cpuAt(processor) with no chain / BNB 名字照旧只传处理器编号
  const bnb = []
  await checkName(parseReceipt(receipt({ name: '1.0.tape' })), async (...a) => { bnb.push(a); return CIRCUITS })
  assert.deepEqual(bnb, [['0']])
  // an outage on the L2 is "could not check", never a verdict / L2 读不到只是"没能核对"
  const down = await verifyReceipt(r, { ...io, resolve: async () => { throw new TapeAPIError('RPC_UNAVAILABLE', 'x') } })
  assert.equal(down.verdict, 'unchecked')
})

test('verify page: the page resolves AI receipts by the container\'s chain and names the chain it read', () => {
  const js = readFileSync(new URL('../../site/verify/verify.js', import.meta.url), 'utf8')
  assert.match(js, /api\.chainOfContainer\(c\)/)
  assert.match(js, /cpuAt: \(p, id\) => api\.forChain\(id \?\? 56\)\.chain\.cpuAt\(p\)/)
  assert.match(js, /operatorsOn\(o\.svc\.chainId \?\? 56\)/, 'the operator count shown is that chain\'s')
})

// ── the dashboard / 我的服务 ─────────────────────────────────────────────────────────────────────────────────────
test('dashboard: names with an area code are kept with their chain; reserved and unassigned codes are not names', () => {
  assert.deepEqual(dashboardInput('1.2.344.tape'), { kind: 'name', key: '1.2.344.tape', id: '1', processor: '344', area: 2, chainId: 196 })
  assert.deepEqual(dashboardInput(' 01.3.05.TAPE '), { kind: 'name', key: '1.3.5.tape', id: '1', processor: '5', area: 3, chainId: 8453 })
  assert.equal(dashboardInput('1.02.5.tape').key, '1.2.5.tape', 'leading zeros are normalised, as for BNB names')
  for (const bad of ['1.0.5.tape', '1.1.5.tape', '1.4.5.tape', '1.2.3.4.tape', '0.2.5.tape', '1.00.5.tape']) assert.equal(dashboardInput(bad), null, bad)
  assert.deepEqual(dashboardInput('11.1013.tape'), { kind: 'name', key: '11.1013.tape', id: '11', processor: '1013' }, 'BNB names unchanged')
  const js = readFileSync(new URL('../../site/dashboard/dashboard.js', import.meta.url), 'utf8')
  assert.match(js, /api\.forChain\(p\.chainId \?\? 56\)\.chain/, 'discover reads on the name\'s chain')
  assert.match(js, /q\.set\('chain', String\(p\.chainId\)\)/, 'the renew link carries the chain to the console')
})

// ── the holder console / 持有人操作台 ─────────────────────────────────────────────────────────────────────────────
test('console: its chain table is the SDK\'s, and every chain-specific output equals what the SDK builds for that chain', async () => {
  for (const id of [56, 196, 8453]) {
    const c = C.CHAINS[id]
    assert.deepEqual([c.chainId, c.hex, c.factory, c.hub, c.siteRegistry], [id, '0x' + id.toString(16), CHAINS[id].factory, CHAINS[id].hub, CHAINS[id].siteRegistry], `chain ${id}`)
  }
  assert.throws(() => C.chainOf(97), /not one this page publishes on/)
  const d = { container: X_CONTAINER, signer: SIGNER, expires: NOW }
  for (const id of [56, 196, 8453]) {
    assert.deepEqual(C.delegationTypedData({ ...d, chainId: id }), delegationTypedData(id, CHAINS[id].hub, d))
    assert.equal(Buffer.from(C.delegationDigest({ ...d, chainId: id })).toString('hex'), Buffer.from(delegationDigest(id, CHAINS[id].hub, d)).toString('hex'))
  }
  // The page's chain (useChain) becomes every default, and BNB Chain is the default otherwise / 页面的链成为默认值
  const tx56 = C.putFileTx({ container: X_CONTAINER, text: '{}', sha256Hex: '0x' + '00'.repeat(32) })
  try {
    assert.equal(C.useChain(196).name, 'X Layer')
    assert.deepEqual(C.delegationTypedData(d), delegationTypedData(196, CHAINS[196].hub, d))
    const tx = C.putFileTx({ container: X_CONTAINER, text: '{}', sha256Hex: '0x' + '00'.repeat(32) })
    assert.deepEqual([tx.to, tx.data], [CHAINS[196].siteRegistry, tx56.data], 'same bytes, the L2 SiteRegistry')
    const asked = []
    const w = (a) => '0x' + a.slice(2).toLowerCase().padStart(64, '0')
    const call = async (to, data) => { asked.push(to); return data.startsWith(C.SEL.isCPU) ? '0x' + '0'.repeat(63) + '1' : w(data.startsWith(C.SEL.accountOf) ? X_CONTAINER : CIRCUITS) }
    await C.readCircuit(call, { processor: '0', tokenId: '1' })
    assert.deepEqual(asked.slice(0, 3), [CHAINS[196].factory, CHAINS[196].factory, CHAINS[196].hub])
    // A delegation signed for BNB Chain does not authorise anything on X Layer / BNB 的委托在 X Layer 上不授权任何东西
    const HOLDER_KEY = '0x' + '11'.repeat(32), holder = privateKeyToAddress(HOLDER_KEY)
    const manifestFor = (domainChain) => JSON.stringify({ tapeapi: '0.1', circuits: CIRCUITS, tokenId: '1', container: X_CONTAINER, signer: SIGNER, endpoints: { live: ['https://svc.example.com/tapeapi/v1'] },
      delegation: { expires: NOW, sig: signDigest(delegationDigest(domainChain, CHAINS[domainChain].hub, d), HOLDER_KEY) } })
    const circuit = { circuits: CIRCUITS, tokenId: '1', container: X_CONTAINER, holder }
    assert.equal(C.onChainAuthorisation(manifestFor(196), circuit).ok, true)
    assert.equal(C.onChainAuthorisation(manifestFor(56), circuit).code, 'NOT_HOLDER')
    assert.equal(C.onChainAuthorisation(manifestFor(56), { ...circuit, chainId: 56 }).ok, true, 'an explicit chainId overrides the page\'s')
  } finally { C.useChain(56) }
  assert.equal(C.putFileTx({ container: X_CONTAINER, text: '{}', sha256Hex: '0x' + '00'.repeat(32) }).to, C.SITE_REGISTRY)
  assert.deepEqual(C.prefillFromQuery('?chain=196&processor=344&circuit=1'), { chainId: 196, processor: '344', circuit: '1' })
  for (const bad of ['97', '0x2105', 'base', '']) assert.deepEqual(C.prefillFromQuery(`?chain=${bad}`), {}, bad)
})

test('console page: the chain is chosen before anything is read, the wallet is switched to it, and ChannelBus stays on BNB Chain', () => {
  const js = readFileSync(new URL('../../site/console/console.js', import.meta.url), 'utf8')
  const html = readFileSync(new URL('../../site/console/index.html', import.meta.url), 'utf8')
  assert.ok(js.indexOf('C.useChain(') > 0 && js.indexOf('C.useChain(') < js.indexOf("const call = "), 'the lib is set to the chain before any read')
  assert.match(js, /wallet_switchEthereumChain', \[\{ chainId: CHAIN_HEX \}\]/)
  assert.match(js, /chainId: CHAIN_HEX, to: tx\.to/, 'the manifest is published on the page\'s chain')
  assert.equal((js.match(/chainId: BSC,/g) || []).length, 2, 'the ChannelBus deploy and probe stay on BNB Chain')
  assert.match(js, /\$\('btn-deploy'\)\.disabled = [^\n]*CHAIN_HEX !== BSC/)
  assert.match(js, /\(s\.chainId \?\? 56\) === CHAIN\.chainId/, 'a circuit read on another chain is not this page\'s')
  const sel = /<select id="chain"[^>]*>([\s\S]*?)<\/select>/.exec(html)
  assert.ok(sel, 'step 1 has a chain selector')
  assert.deepEqual([...sel[1].matchAll(/value="(\d+)"/g)].map((m) => m[1]), ['56', '196', '8453'])
  assert.ok(html.indexOf('id="chain"') < html.indexOf('id="btn-connect"'), 'chosen before connecting')
  const note = html.slice(html.indexOf('id="chain-note"'), html.indexOf('id="wallet-status"'))
  assert.equal((note.match(/<span lang="zh">/g) || []).length, (note.match(/<span lang="en">/g) || []).length)
})

// ── the bins / 命令行 ────────────────────────────────────────────────────────────────────────────────────────────
const run = (bin, args) => new Promise((ok) => {
  const c = spawn(process.execPath, [fileURLToPath(new URL(`../bin/${bin}`, import.meta.url)), ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  let e = ''; c.stderr.on('data', (d) => { e += d }); c.stdout.on('data', () => {})
  const t = setTimeout(() => c.kill('SIGKILL'), 20_000)
  c.on('exit', (code) => { clearTimeout(t); ok({ code, e }) })
})
// Two unreachable nodes of two "operators" (their hostnames): nothing leaves this machine. / 两个连不上的本地节点：不出本机。
const DEAD = 'http://127.0.0.1:9,http://127.0.0.2:9'

test('tapeapi-verify: an X Layer name is read on X Layer (--rpc-xlayer), an unassigned area code is not a name', async () => {
  const x = await run('tapeapi-verify.js', ['1.2.344.tape', '--rpc', DEAD, '--rpc-xlayer', DEAD, '--port', '0'])
  assert.equal(x.code, 1); assert.match(x.e, /cannot use 1\.2\.344\.tape: .*(RPC_UNAVAILABLE|only 0\/2)/)
  assert.match((await run('tapeapi-verify.js', ['1.4.344.tape'])).e, /not a TapeOut name/)
  assert.match((await run('tapeapi-verify.js', ['1.2.344.tape', '--rpc-xlayer', 'http://127.0.0.1:9'])).e, /--rpc-xlayer needs nodes of at least 2 independent operators/)
  assert.match((await run('tapeapi-verify.js', ['--help'])).e + '', /^$/, 'help goes to stdout')
})

test('tapeapi-mcp: L2 names are accepted, and --rpc-base is checked like --rpc', async () => {
  assert.match((await run('tapeapi-mcp.js', ['1.3.5.tape', '--rpc-base', 'http://127.0.0.1:9'])).e, /--rpc-base needs nodes of at least 2 independent operators/)
  const src = readFileSync(new URL('../bin/tapeapi-mcp.js', import.meta.url), 'utf8')
  assert.match(src, /name: nameOf\(target\)\?\.name/, 'a receipt carries the canonical name, which tells a verifier the chain')
  assert.match(src, /n\.area === null \? `t\$\{n\.tokenId\}_\$\{n\.processor\}_` : `t\$\{n\.tokenId\}_\$\{n\.area\}_\$\{n\.processor\}_`/, 'tool prefixes keep chains apart')
})

test('sig: the same delegation is a different digest on each chain / 同一委托在每条链上摘要不同', () => {
  const d = { container: X_CONTAINER, signer: SIGNER, expires: NOW }
  const ds = [56, 196, 8453].map((id) => Buffer.from(sig.delegationDigest(id, CHAINS[id].hub, d)).toString('hex'))
  assert.equal(new Set(ds).size, 3)
})
