// @experimental The calling app's side of a visitor grant: decorate the request with the
// top-level member `grant` (the visitor's signed grant and a fresh call proof signed with the calling app's one-off
// key), and refuse an answer that does not carry the called service's grant record (`GRANT_NOT_HONOURED`).
// Outside the package's compatibility promise; a PROTOTYPE, not a TAP. Its format text is spec/TAPI-28.md (Experimental);
// where the two differ, the code is authoritative.
// 调用方 A 一侧：给请求加上顶层成员 grant（访客签过的授权 + 用 A 的一次性钥匙新签的调用证明），并拒绝没有回写授权记录的回答。
//
// Where the grant travels: a top-level request member `grant`, with the record written back in `result.grant`. The
// alternative (`params.grant`, the proof covering the params without `grant`) is not implemented; it would only be
// needed if the TAP editors refuse a later TAP defining a top-level member.
// / 承载：请求顶层 grant + 回写 result.grant；params 方案未实现。
//
// How, without changing the SDK's Stable `call`: the decorated `fetch` is the one the client is created with. Only a
// request whose `id` was registered for a grant (callWithGrant registers a fresh random id) and that goes to one of the
// service's own endpoints gets the member; every other request passes through byte for byte. The proof is computed from
// the request body as sent (id, method, params), and recomputed with a fresh ts on the SDK's retry of the same id.
// 不改 SDK 稳定的 call：A 用装饰过的 fetch 创建客户端；只有为授权登记过 id、且发往该服务自己端点的请求才加成员，其余原样转发。
import { randomBytes } from '@noble/hashes/utils'
import { TapeAPIError } from '@tapeapi/sdk'
import { eqAddr, toHex } from '@tapeapi/sdk/abi'
import { privateKeyToAddress } from '@tapeapi/sdk/sig'
import { normalizeGrant, statementMatches, grantHashOf, signCallProof, wireGrant, GRANT_SKEW_S } from './interop-sig.js'

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * Check the grant record in a VERIFIED answer's result (api.call already checked the envelope): the service wrote
 * { hash, caller, user, used, maxCalls } for this grant. Throws GRANT_NOT_HONOURED otherwise: an answer without it means
 * the service did not apply the grant, and is not a success. / 核对已验回答里的授权记录；没有即 GRANT_NOT_HONOURED
 */
export function checkGrantRecord(result, { hash, caller, user, maxCalls }) {
  const g = isPlainObject(result) ? result.grant : undefined
  const bad = (why) => { throw new TapeAPIError('GRANT_NOT_HONOURED', `the service's signed answer does not carry this grant's record (${why}): it did not apply the grant`) }
  if (!isPlainObject(g)) bad('no result.grant')
  if (g.hash !== hash) bad('another hash')
  if (!eqAddr(g.caller, caller) || !eqAddr(g.user, user)) bad('another caller or user')
  if (g.maxCalls !== maxCalls || !Number.isSafeInteger(g.used) || g.used < 1 || g.used > maxCalls) bad('used / maxCalls out of range')
  return { hash: g.hash, used: g.used, maxCalls: g.maxCalls }
}

/**
 * withGrant(fetch, { clock }) -> { fetch, attach(id, bundle), detach(id), call(api, svc, method, params, grant, opts) }
 *   fetch       give it to the SDK client: createTapeAPI({ ..., fetch: g.fetch })
 *   attach      low level: the request with this id to this service carries this grant
 *   call        the usual way: checks the grant locally, sends it with a fresh id, then checks the record
 * `grant` = { chainId, hub, message, userSig, callerKeyPk }: the message and the visitor's signature as the wallet
 * returned them, and the one-off key that stays in A's origin.
 * withGrant(fetch) 返回装饰过的 fetch 与 call。grant = { chainId, hub, message, userSig, callerKeyPk }。
 */
export function withGrant(baseFetch, { clock = () => Math.floor(Date.now() / 1000) } = {}) {
  const f = baseFetch ?? globalThis.fetch
  if (typeof f !== 'function') throw new TapeAPIError('INVALID_ARGUMENT', 'withGrant needs a fetch')
  const pending = new Map()                 // id -> { endpoints, chainId, message, hash, userSig, callerKeyPk }
  async function fetchWithGrant(url, init) {
    const b = pending.get(idOf(init))
    if (!b || init?.method !== 'POST' || !b.endpoints.some((e) => String(url).startsWith(e + '/'))) return f(url, init)
    const body = JSON.parse(init.body)
    const proof = signCallProof({ audience: b.message.audience, grantHash: b.hash, id: body.id, method: body.method, params: body.params, ts: clock() }, b.callerKeyPk)
    const member = JSON.stringify(wireGrant({ chainId: b.chainId, message: b.message, userSig: b.userSig, proof }))
    // the SDK's own bytes are kept; the member is appended / 保留 SDK 原有字节，只在末尾追加成员
    const text = init.body.trimEnd()
    return f(url, { ...init, body: text.slice(0, -1) + (text === '{}' ? '' : ',') + `"grant":${member}}` })
  }
  const idOf = (init) => { try { return typeof init?.body === 'string' ? JSON.parse(init.body).id : undefined } catch { return undefined } }
  function bundleOf(svc, grant) {
    const message = normalizeGrant(grant.message)
    if (!statementMatches(message)) throw new TapeAPIError('GRANT_INVALID', 'the grant\'s statement is not a v1 rendering of its fields')
    if (!eqAddr(message.audience, svc.container)) throw new TapeAPIError('GRANT_INVALID', `the grant is for ${message.audience}, not ${svc.container}`)
    if (!eqAddr(privateKeyToAddress(grant.callerKeyPk), message.callerKey)) throw new TapeAPIError('GRANT_INVALID', 'callerKeyPk is not the grant\'s callerKey')
    return { endpoints: svc.manifest.endpoints.live.map(String), chainId: grant.chainId, message, hash: grantHashOf(grant.chainId, grant.hub, message), userSig: grant.userSig, callerKeyPk: grant.callerKeyPk }
  }
  return {
    fetch: fetchWithGrant,
    attach(id, svc, grant) { pending.set(id, bundleOf(svc, grant)) },
    detach(id) { pending.delete(id) },
    /**
     * api.call with the grant: local checks first (the method is in the grant and the manifest marks it; not expired;
     * no payer: a grant never travels with a voucher), then the call with a fresh id, then the record check. Returns the
     * verified answer with `grant: { hash, used, maxCalls }`. / 先本地检查，再调用，再核对回写
     */
    async call(api, svc, method, params, grant, opts = {}) {
      const b = bundleOf(svc, grant)
      const def = svc.manifest.methods.find((d) => d.name === method)
      if (!b.message.methods.includes(method)) throw new TapeAPIError('GRANT_INVALID', `${method} is not in the grant`)
      if (!def || (def.grant !== 'required' && def.grant !== 'optional')) throw new TapeAPIError('GRANT_INVALID', `${method} takes no grant in ${svc.container}'s manifest`)
      if (opts.payer) throw new TapeAPIError('GRANT_INVALID', 'a grant is never sent together with a voucher (the statement says it includes no payment)')
      const now = clock()
      if (now + GRANT_SKEW_S < b.message.notBefore || now >= b.message.expires) throw new TapeAPIError('GRANT_INVALID', 'the grant is not valid now')
      const id = 'g-' + toHex(randomBytes(16)).slice(2)
      pending.set(id, b)
      try {
        const r = await api.call(svc, method, params, { ...opts, id })
        return { ...r, grant: checkGrantRecord(r.result, { hash: b.hash, caller: b.message.caller, user: b.message.user, maxCalls: b.message.maxCalls }) }
      } finally { pending.delete(id) }
    },
  }
}
