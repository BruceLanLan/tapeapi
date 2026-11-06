#!/usr/bin/env node
// examples/app-interop: the whole story, printed. `node examples/app-interop/demo.mjs`. Local fake chain only: no network,
// no cost, no real wallet; the escrow is a model of a contract that is neither audited nor deployed.
// 整个过程打印出来。只在本地假链上：不联网、不花钱、不碰真实钱包；托管是未审计、未部署合约的模型。
import { fileURLToPath } from 'node:url'
import { createInteropWorld, APP_A, APP_B, USER, PRICE, HUB } from './world.mjs'
import { discover, callChecked, planGrant, payerFor, askVisitorGrant, signedGrant, revocationRequest } from './app-a.mjs'

export async function runDemo({ log = console.log } = {}) {
  const w = createInteropWorld()
  try {
    log('LOCAL FAKE CHAIN ONLY. The escrow is a model of an unaudited, undeployed contract: none of this works on mainnet today.')
    const api = w.apiA()
    const { svc, methods } = await discover(api, APP_B.name)
    log(`1. A resolved ${APP_B.name} -> container ${svc.container}; manifest read from B's site on chain; methods: ${methods.map((m) => `${m.name} (${m.priceBEM} BEM)`).join(', ')}`)
    const free = await callChecked(api, svc, 'profile', {})
    log(`2. free call profile: signed by ${free.receipt.signer} (= manifest signer: ${free.receipt.ok}); B saw consumer ${w.appB.seen.at(-1).consumer}: anonymous`)
    const cap = 3n * PRICE + PRICE / 2n
    const grant = await planGrant(w.walletApi(), svc, { cap, expires: w.clock() + 3600 })
    log(`3. A asks the user's wallet for 3 transactions (approve ${cap}, fund ${cap}, authorizeSession for A's key ${grant.key} for 1 h)`)
    for (const tx of grant.txs) log(`   wallet sent: ${w.wallet.send(tx)}`)
    const payer = payerFor(api, grant, { user: USER })
    for (let i = 1; i <= 4; i++) {
      try {
        const r = await callChecked(api, svc, 'quote', {}, { payer })
        log(`4.${i} paid call quote: ok, receipt checks out (${r.receipt.ok}); B saw user ${r.result.paidBy}, key ${r.result.key}; nothing names app A`)
      } catch (e) { log(`4.${i} paid call quote: refused by B, ${e.code}: ${e.message}`) }
    }
    log(`5. B settles: ${(await w.settleAll()).join(', ')}; claimed ${w.escrow.claimedOf(USER, APP_B.container)} = 3 prices`)
    const ask = await askVisitorGrant(w.chainA(), { svc, appA: APP_A, appB: APP_B, user: USER, methods: ['history'], maxCalls: 3, now: w.clock(), hub: HUB })
    log(`6. EXPERIMENTAL visitor grant (not a TAP; no service knows it). The wallet's first line: "${ask.payload.message.statement}"`)
    const vg = signedGrant(ask, w.wallet.signTypedData(ask.payload))
    const r = await w.grants.call(api, svc, 'history', {}, vg)
    log(`   B's signed answer names A: caller ${r.result.caller.name} (${r.result.caller.app}); grant record: call ${r.grant.used} of ${r.grant.maxCalls}`)
    const rev = revocationRequest({ user: USER, grantHashes: [ask.hash], issued: w.clock(), hub: HUB })
    const receipt = await callChecked(api, svc, 'grant_revoke', { revocation: rev.message, sig: w.wallet.signTypedData(rev) })
    log(`   the visitor revoked it at B (B's signed receipt: ${receipt.receipt.ok}); the next call: ${await w.grants.call(api, svc, 'history', {}, vg).then(() => 'served', (e) => `${e.code}: ${e.message}`)}`)
    w.advance(3601)
    try { await api.call(svc, 'quote', {}, { payer: payerFor(api, grant, { user: USER, checkLocally: false }) }) } catch (e) { log(`7. after the session lapsed: refused by B, ${e.code}: ${e.message}`) }
    log(`8. requests made: ${w.requests.length}, to ${[...new Set(w.requests.map((u) => new URL(u).origin))].join(', ')} (all in process)`)
    return { ok: true, requests: [...w.requests] }
  } finally { w.close() }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await runDemo()
