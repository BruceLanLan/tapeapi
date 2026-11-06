// examples/app-interop: app A, the CALLING app. What a DeWEB page (or any app) does to use another app's service with
// the TapeAPI SDK: find it by name, read its on-chain manifest, call a free method, check the signed answer itself;
// with the user's funding grant, call a priced method within a cap; with the visitor's VISITOR GRANT
// (@tapeapi/interop, experimental), call a method that serves the visitor's own data at B, naming A.
// Browser-safe: imports only the SDK (a test walks the imports); every network read goes through the `api` it is given,
// every transaction and every signature goes to the user's wallet.
// 示例里的调用方 A：按名字找到另一个应用的服务、读链上清单、调用免费方法并自己核验签名回答；凭用户的资金授权在上限内调用收费
// 方法；凭访客授权（@tapeapi/interop，实验性）调用返回访客自己在 B 的数据的方法，并让 B 认出 A。浏览器安全。
import { sig } from '@tapeapi/sdk'
import { prepareGrant, grantTypedData, grantForWallet, grantRevocationTypedData, grantHashOf } from '@tapeapi/interop'

/** 1. find B by name and read its manifest from the chain / 按名字找到 B，从链上读清单 */
export async function discover(api, name) {
  const svc = await api.resolve(name)
  return { svc, methods: svc.manifest.methods.map((m) => ({ name: m.name, priceBEM: m.priceBEM, ...(m.grant ? { grant: m.grant } : {}) })) }
}

/**
 * 2. check a signed answer again, independently of api.call: recover the signer of the envelope over what A itself sent
 * (method, params) and what came back, and compare it with the manifest's signer. Anyone holding these fields can redo it.
 * 独立复核签名回答：用 A 自己发出的 method、params 和收到的结果恢复签名者，与清单里的 signer 比较。任何拿到这些字段的人都能重做。
 */
export function checkReceipt(svc, method, params, r) {
  const signer = sig.recoverResponseSigner({ container: svc.container, id: r.id, method, params, ok: true, body: r.result, ts: r.ts }, r.sig)
  return { ok: r.verified === true && signer.toLowerCase() === svc.manifest.signer.toLowerCase(), signer, container: svc.container, method, id: r.id, ts: r.ts }
}

/** a call whose answer A checks twice: api.call verifies it, checkReceipt redoes it / 调用并两次核验 */
export async function callChecked(api, svc, method, params = {}, options = {}) {
  const r = await api.call(svc, method, params, options)
  const receipt = checkReceipt(svc, method, params, r)
  if (!receipt.ok) throw new Error(`answer of ${method} does not check out`)
  return { result: r.result, receipt, raw: r }
}

/**
 * 3. the funding grant, as A asks the user's wallet for it. Reuses TAPI-22 as it is (experimental; the escrow is neither
 * audited nor deployed, so this runs on local chains and in tests only): A makes a one-off session key and keeps it; the
 * user signs three transactions: approve exactly `cap`, fund the channel (user -> B) with `cap`, authorize A's key on
 * that channel until `expires` (at most 30 days; there is NO revoke, only expiry, or the user's 48 h withdraw).
 * 资金授权：A 生成一次性会话钥匙并自己保管；用户签三笔交易（approve、fund、authorizeSession）。上限就是通道余额。
 */
export async function planGrant(walletApi, svc, { cap, expires }) {
  const sessionKey = sig.randomPrivateKey()          // stays in A / 留在 A 里
  const key = sig.privateKeyToAddress(sessionKey)
  const txs = [
    await walletApi.tx.approve({ amount: cap, spender: svc }),
    await walletApi.tx.fund(svc, cap),
    walletApi.tx.authorizeSession(svc, key, expires),
  ]
  return { sessionKey, key, expires, cap: BigInt(cap), txs }
}

/**
 * 4. the payer A signs vouchers with. `checkLocally: false` leaves every check to B (the tests use it to show that B,
 * not only A, refuses a lapsed key). / A 签凭证用的 payer；checkLocally: false 把检查全部留给 B。
 */
export function payerFor(api, grant, { user, checkLocally = true } = {}) {
  return api.payer({ consumer: user, sessionKey: grant.sessionKey, ...(checkLocally ? { sessionExpiry: grant.expires } : {}) })
}

/**
 * 5. (experimental) the VISITOR GRANT A asks the visitor's wallet for: a one-off call key K made and kept in A's
 * origin; the identities read from the chain (A's container and holder from A's own name, B's holder), never typed in;
 * the statement generated; the wallet payload rebuilt and compared (grantForWallet). The wallet shows the statement as
 * its first line; the visitor checks that the caller it names is the site the wallet says the request comes from.
 * （实验性）访客授权：A 在自己源里生成一次性调用钥匙 K；身份全部读链；statement 自动生成；钱包载荷重建比对。
 */
export async function askVisitorGrant(chain, { svc, appA, appB, user, methods, maxCalls, lifeS, lang = 'en', now, chainId = 56, hub }) {
  const callerKeyPk = sig.randomPrivateKey()          // stays in A / 留在 A 里
  const message = await prepareGrant({ chain, callerName: appA.name, audience: svc.container, audienceName: appB.name, user, callerKey: sig.privateKeyToAddress(callerKeyPk), methods, maxCalls, lifeS, lang, now })
  const { payload, display } = grantForWallet(grantTypedData(chainId, hub, message), { chainId, hub, callerName: appA.name, audienceName: appB.name })
  return { callerKeyPk, message, payload, display, hash: grantHashOf(chainId, hub, message), chainId, hub }
}

/** 6. the visitor's wallet answered: what withGrant(...).call takes / 钱包签完：交给 withGrant().call 的授权 */
export const signedGrant = (ask, userSig) => ({ chainId: ask.chainId, hub: ask.hub, message: ask.message, userSig, callerKeyPk: ask.callerKeyPk })

/** 7. a revocation for the visitor's wallet to sign, delivered to B's free method grant_revoke / 撤销 */
export function revocationRequest({ user, grantHashes, revokedBefore = 0, issued, chainId = 56, hub }) {
  return grantForWallet(grantRevocationTypedData(chainId, hub, { user, grantHashes, revokedBefore, issued }), { chainId, hub }).payload
}
