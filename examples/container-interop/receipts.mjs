// Checking a signed answer a container gave another container, without trusting whoever passes it on (all three scenarios use it).
// It is the check `api.call` makes on every answer, written out, so that a receipt kept or forwarded can be checked again later:
//   1. the receipt names a container, and the signer recovered from its signature is the signer THAT container's manifest
//      publishes now (resolved from the chain, delegation checked against the current holder);
//   2. the request the signature covers is the request the caller says it made (method and params), when the caller knows it;
//   3. the body the signature covers is the body the caller was shown (the answer), when the caller has it.
// What it proves: this container signed this answer to this request at this time. What it does NOT prove: that the answer is
// right, that it is the answer to anything else, or anything about the model or code behind the container.
// 核验一个容器给另一个容器的签名回答，不必信任转交它的人。就是 `api.call` 对每个回答做的检查，写出来以便事后对保存或转交的回执再核一遍。
// 它证明：这个容器在这个时间对这个请求签了这个回答。它不证明：回答是对的、回答针对别的请求、或容器背后的模型与代码如何。
import { sig, mcp } from '@tapeapi/sdk'

const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()

/**
 * @param {object} api       a client of the verifier (it reads the chain for the container's signer)
 * @param {object} receipt   a TAPI-21 receipt (mcp.receiptOf, v 1) or its hash-only form (mcp.hashReceipt, v 2)
 * @param {object} expect    { container?, method?, params?, id?, result? }: what the verifier knows it asked / was shown
 * @returns {{ ok: boolean, problems: string[], signer: string|null, container: string|null }}
 */
export async function verifyReceipt(api, receipt, expect = {}) {
  const problems = []
  const fail = (m) => { problems.push(m); return { ok: false, problems, signer: null, container: receipt?.service?.container ?? null } }
  if (!receipt || typeof receipt !== 'object' || ![1, 2].includes(receipt.v)) return fail('not a receipt (v 1 or v 2)')
  const container = receipt.service?.container
  if (typeof container !== 'string') return fail('no container named')
  if (expect.container !== undefined && !eq(container, expect.container)) problems.push(`names ${container}, expected ${expect.container}`)
  if (expect.id !== undefined && receipt.id !== expect.id) problems.push(`answers request id ${JSON.stringify(receipt.id)}, expected ${JSON.stringify(expect.id)}`)
  if (expect.method !== undefined && receipt.method !== expect.method) problems.push(`method ${JSON.stringify(receipt.method)}, expected ${JSON.stringify(expect.method)}`)

  // the digest the signature covers: the full receipt carries the request and the body, the hash-only one their hashes
  const hashed = receipt.v === 2 ? receipt : mcp.hashReceipt(receipt)
  if (expect.method !== undefined && expect.params !== undefined) {
    const want = sig.responseRequestHash({ method: expect.method, params: expect.params })
    if (hashed.requestHash !== want) problems.push('the request the signature covers is not the request that was made')
  }
  if (expect.result !== undefined && hashed.bodyHash !== sig.responseBodyHash(expect.result)) problems.push('the body the signature covers is not the answer that was shown')

  let signer = null
  try {
    signer = sig.recoverResponseSignerFromHashes({ container, id: hashed.id, requestHash: hashed.requestHash, ok: hashed.ok, bodyHash: hashed.bodyHash, ts: hashed.ts }, hashed.sig)
  } catch (e) { problems.push(`signature does not recover: ${e.message}`) }
  if (signer) {
    let published = null
    try { published = (await api.resolve(container)).manifest.signer } catch (e) { problems.push(`the container does not resolve: ${e.message}`) }
    // the one check that names who answered: the recovered signer must be the one the container's manifest publishes
    if (!published || !eq(signer, published)) {
      if (published) problems.push(`signed by ${signer}, the container publishes ${published}`)
      signer = null
    }
  }
  return { ok: problems.length === 0 && signer !== null, problems, signer, container }
}
