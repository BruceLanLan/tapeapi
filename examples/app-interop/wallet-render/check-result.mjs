// examples/app-interop/wallet-render: check a result copied from the page, on this machine (no network).
//   node examples/app-interop/wallet-render/check-result.mjs result.json
// It checks that the signed string is one of the page's payloads with only `message.user` set to the account, and that
// the signature recovers to that account under the visitor-grant digest (@tapeapi/interop, experimental). A
// contract wallet (EIP-1271) cannot be checked offline and is reported as such.
// 在本机核对从页面复制的结果：签的字符串就是页面的某个载荷（只有 message.user 换成了账户），签名能按授权摘要恢复出该账户。
import { readFileSync } from 'node:fs'
import { sig, abi } from '@tapeapi/sdk'
import { grantDigest, grantRevocationDigest, grantForWallet } from '@tapeapi/interop'
import { buildPayloads, CHAIN_ID, HUB } from './make-payloads.mjs'

/** @returns {{ ok: boolean, why: string, signer?: string }} */
export function checkResult(rec) {
  if (!rec || typeof rec !== 'object') return { ok: false, why: 'not a result object' }
  if (rec.error) return { ok: false, why: `the wallet did not sign: ${rec.error.message}` }
  const p = buildPayloads().find((x) => x.id === rec.variant)
  if (!p) return { ok: false, why: `unknown variant ${rec.variant}` }
  let td
  try { td = JSON.parse(rec.typedData) } catch { return { ok: false, why: 'typedData is not JSON' } }
  if (!abi.isAddress(rec.account) || !abi.eqAddr(td.message?.user, rec.account)) return { ok: false, why: 'message.user is not the account' }
  const want = JSON.parse(JSON.stringify(p.typedData)); want.message.user = td.message.user
  if (JSON.stringify(td) !== JSON.stringify(want)) return { ok: false, why: 'the signed data is not the page\'s payload (only message.user may differ)' }
  // the SDK's own rebuild accepts it (a grant: the names the page expects) / SDK 自己重建一遍
  // (wallets hand out lower-case accounts; the SDK builds checksummed addresses, and the digest is the same either way)
  const asBuilt = { ...td, message: { ...td.message, user: abi.checksumAddress(td.message.user) } }
  try { grantForWallet(asBuilt, { chainId: CHAIN_ID, hub: HUB, callerName: td.message.callerName, audienceName: td.message.audienceName }) } catch (e) { return { ok: false, why: e.message } }
  const digest = td.primaryType === 'VisitorGrant' ? grantDigest(CHAIN_ID, HUB, td.message) : grantRevocationDigest(CHAIN_ID, HUB, td.message)
  if (typeof rec.signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(rec.signature)) return { ok: false, why: 'not a 65-byte signature (a contract wallet\'s EIP-1271 signature cannot be checked offline)' }
  let signer
  try { signer = sig.recoverAddress(digest, rec.signature) } catch (e) { return { ok: false, why: `signature does not recover: ${e.message}` } }
  if (!abi.eqAddr(signer, rec.account)) return { ok: false, why: `the signature recovers to ${signer}, not ${rec.account}`, signer }
  return { ok: true, why: `${rec.variant}: signed by ${signer} over the page's payload`, signer }
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  if (!process.argv[2]) { console.error('usage: node check-result.mjs result.json'); process.exit(2) }
  const r = checkResult(JSON.parse(readFileSync(process.argv[2], 'utf8')))
  console.log(r.ok ? `OK  ${r.why}` : `NOT OK  ${r.why}`)
  process.exit(r.ok ? 0 : 1)
}
