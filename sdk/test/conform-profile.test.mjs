// 2.0: CONFORM_PROFILE, which texts the conformance mode resolves by, carried as
// svc.conform.profile. Only added: every field svc.conform had keeps its name and value, the 1.x resolution
// (conform: false) has no svc.conform and so no profile, siteStatus (any mode) and the errors are unchanged, and the
// type declarations say what the code does. Offline, on the conform chain (helpers/conform-chain.mjs).
// 2.0：CONFORM_PROFILE（一致模式按哪一版文本解析）随 svc.conform.profile 带出。只加不改：svc.conform 原有字段名与值
// 不变；1.x 的解析（conform: false）没有 svc.conform，也就没有 profile；siteStatus（任何模式）与错误不变；类型声明与代码一致。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createTapeAPI, CONFORM_PROFILE, MANIFEST_KEY, MAINNET, TapeAPIError, sig } from '../src/index.js'
import { createConformChain } from './helpers/conform-chain.mjs'

const T = 1_790_000_000
const RPC = ['http://rpc1', 'http://rpc2', 'http://rpc3']
const HOLDER_KEY = '0x' + '11'.repeat(32), SIGNER_KEY = '0x' + '22'.repeat(32)
const holder = sig.privateKeyToAddress(HOLDER_KEY), signer = sig.privateKeyToAddress(SIGNER_KEY)
const EXPIRES = T + 30 * 86_400
// The fields of svc.conform before CONFORM_PROFILE was added, in order / CONFORM_PROFILE 之前 svc.conform 的字段
const CONFORM_FIELDS = ['version', 'chainId', 'name', 'processor', 'tokenId', 'circuits', 'container', 'holder', 'opened', 'activation', 'implementations', 'pinned', 'derivation', 'status', 'site']
const SITE_FIELDS = ['version', 'status', 'chainId', 'name', 'processor', 'tokenId', 'circuits', 'container', 'holder', 'opened', 'activation', 'implementations', 'pinned']

function world() {
  const chain = createConformChain()
  chain.state.headTime = T
  const c = chain.circuit(4246, { holder })
  chain.setAccount(4246, c.container)   // the hub's derivation, read by the 1.x resolution / 1.x 解析读的 hub 推导
  chain.writeFile(c.container, MANIFEST_KEY, JSON.stringify({
    tapeapi: '0.1', name: 'Profile', circuits: c.circuits, tokenId: c.tokenId, container: c.container, signer,
    delegation: { expires: EXPIRES, sig: sig.signDigest(sig.delegationDigest(56, MAINNET.hub, { container: c.container, signer, expires: EXPIRES }), HOLDER_KEY) },
    endpoints: { live: ['https://api.example.com/tapeapi/v1'], async: false },
    methods: [{ name: 'ping', priceBEM: '0', params: {}, returns: {} }],
  }))
  return { chain, c }
}
const mk = (chain, o = {}) => createTapeAPI({ rpcUrls: RPC, fetch: chain.fetch, clock: () => T, quiet: true, onWarning: () => {}, ...o })

test('CONFORM_PROFILE names TAP-10 at its version (the version of every result) and TAP-11 as a Draft', () => {
  assert.equal(CONFORM_PROFILE, 'tap10@1.1+tap11@draft')
  assert.equal(typeof CONFORM_PROFILE, 'string')
  assert.match(CONFORM_PROFILE, /^tap10@[0-9]+\.[0-9]+\+tap11@(draft|[0-9]+\.[0-9]+)$/)
})

test('the default resolve and conform: \'tap10\' carry svc.conform.profile; every older field keeps its name and value', async () => {
  for (const opts of [{}, { conform: 'tap10' }]) {
    const { chain, c } = world()
    const svc = await mk(chain, opts).resolve('4246.7.tape')
    assert.equal(svc.conform.profile, CONFORM_PROFILE, JSON.stringify(opts))
    assert.deepEqual(Object.keys(svc.conform), [...CONFORM_FIELDS, 'profile'], 'profile is only added, at the end')
    assert.equal(svc.conform.version, '1.1')
    assert.ok(CONFORM_PROFILE.startsWith(`tap10@${svc.conform.version}+`), 'the profile and version agree')
    assert.equal(svc.conform.status, 'resolved'); assert.equal(svc.conform.site, 'ok')
    assert.equal(svc.conform.container, c.container); assert.equal(svc.conform.holder, holder)
    assert.equal(svc.pinned.mode, 'tap10')
    assert.equal('profile' in svc, false, 'not a top-level field of the service')
  }
})

test('conform: false and null resolve the 1.x way: no svc.conform, no profile anywhere in the result', async () => {
  for (const opts of [{ conform: false }, { conform: null }]) {
    const { chain } = world()
    const svc = await mk(chain, opts).resolve('4246.7.tape')
    assert.equal(svc.conform, undefined, JSON.stringify(opts))
    assert.equal(JSON.stringify(svc, (_, x) => (typeof x === 'bigint' ? String(x) : x)).includes(CONFORM_PROFILE), false)
  }
})

test('siteStatus (default and conform: false) and the errors of the default are unchanged: no profile', async () => {
  for (const opts of [{}, { conform: false }]) {
    const { chain } = world()
    const s = await mk(chain, opts).siteStatus('4246.7.tape')
    assert.deepEqual(Object.keys(s), SITE_FIELDS, JSON.stringify(opts))
    assert.equal(s.version, '1.1'); assert.equal(s.status, 'ok')
  }
  const { chain } = world()
  chain.setUnactivated()
  await assert.rejects(mk(chain).resolve('4246.7.tape'), (e) => e instanceof TapeAPIError && e.code === 'SITE_STATUS' && e.data.status === 'unpaid' && !('profile' in e.data))
})

test('the type declarations say what the code does: CONFORM_PROFILE\'s literal and svc.conform.profile', () => {
  const dts = readFileSync(new URL('../types/index.d.ts', import.meta.url), 'utf8')
  const m = dts.match(/export declare const CONFORM_PROFILE: '([^']+)'/)
  assert.ok(m, 'CONFORM_PROFILE is declared with its literal value')
  assert.equal(m[1], CONFORM_PROFILE)
  const from = dts.indexOf('  conform?: Omit<SiteStatus')
  const conformType = dts.slice(from, dts.indexOf('  sentinel?:', from))
  assert.match(conformType, /profile: typeof CONFORM_PROFILE/, 'ResolvedService.conform declares profile')
  // SiteStatus does not declare it: siteStatus never returns it / SiteStatus 不声明：siteStatus 不返回它
  const siteType = dts.slice(dts.indexOf('export interface SiteStatus'), dts.indexOf('export interface ResolvedService'))
  assert.doesNotMatch(siteType, /profile/)
})
