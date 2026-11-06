// examples/app-interop: app B, the CALLED app. Its methods, as plain handlers for createProvider (@tapeapi/server):
//   profile       free     B's public profile (public data: it takes no grant)
//   quote         priced   0.0001 BEM a call (the price is in B's manifest, not here)
//   history       free     the VISITOR's own data at B: it takes a visitor grant ("required")
//   grant_revoke  free     takes a visitor's signed GrantRevocation (handler from @tapeapi/interop, added by world.mjs)
// The same handlers run in the tests (in process, on the SDK's fake chain) and could run in a Worker (see README: a static
// DeWEB site cannot sign, so B needs an endpoint that holds its signer key). No imports; no Node-only code.
// `seen` records what B can know about each call: it is how the tests show what B can and cannot tell about its caller.
// The visitor-grant check itself is @tapeapi/interop (experimental): world.mjs wraps these handlers
// with its grantMethods, which refuses a bad grant before the handler runs and writes the grant record into the answer.
// 示例里的被调用方 B：profile 免费公开（公开数据不要授权）、quote 收费、history 是访客自己在 B 的数据（必须带访客授权）、
// grant_revoke 接收撤销。`seen` 记下 B 对每次调用能知道什么。授权核验由 @tapeapi/interop（实验性）完成：
// world.mjs 用它的 grantMethods 包装这些处理器，坏授权在处理器之前被拒，授权记录写进签名回答。
export const PROFILE = { name: 'App B', about: 'An example app on a local fake chain. Nothing here is on any real chain.' }

/** B's manifest methods (merged into its manifest by world.mjs) / B 清单里的方法 */
export const B_METHODS = [
  { name: 'profile', priceBEM: '0', params: {}, returns: { profile: 'object', caller: 'object|null' } },
  { name: 'quote', priceBEM: '0.0001', params: { pair: 'string' }, returns: { quote: 'object', paidBy: 'address', key: 'address', caller: 'object|null' } },
  // `grant` is a new optional member of a method descriptor (TAP-11 §3.1: clients ignore members they
  // do not know). / 方法描述符的新可选成员 grant
  { name: 'history', priceBEM: '0', grant: 'required', params: {}, returns: { visitor: 'address', items: 'array', caller: 'object' } },
  { name: 'grant_revoke', priceBEM: '0', params: { revocation: 'object', sig: 'string' }, returns: { revoked: 'object' } },
]

/** @returns {{ methods: object, seen: object[] }} */
export function createAppB() {
  const seen = []
  // what B learns about the caller: the voucher-proven user and key on a priced call; with a visitor grant, the grant
  // record the SDK checked (ctx.grant); nothing at all on a plain free call / B 对调用方能知道的
  function callerOf(method, params, ctx) {
    const view = { method, consumer: ctx.consumer ?? null, voucherSigner: ctx.voucherSigner ?? null, paramKeys: Object.keys(params ?? {}).sort() }
    if (ctx.grant) view.grant = { caller: ctx.grant.caller, callerName: ctx.grant.callerName, user: ctx.grant.user, used: ctx.grant.used }
    seen.push(view)
    if (!ctx.grant) return null
    return { app: ctx.grant.caller, name: ctx.grant.callerName, user: ctx.grant.user, basis: 'visitor grant (experimental): the visitor signed that key K speaks for this name, and K signed this request' }
  }
  const methods = {
    profile: async (params, ctx) => ({ profile: PROFILE, caller: callerOf('profile', params, ctx) }),
    quote: async (params, ctx) => ({
      quote: { pair: typeof params.pair === 'string' ? params.pair.slice(0, 32) : 'BEM/USD', value: 'example-only', block: ctx.block },
      paidBy: ctx.consumer, key: ctx.voucherSigner, caller: callerOf('quote', params, ctx),
    }),
    // with the SDK's check in front, only reached with a verified grant (the descriptor says "required"); a B that does not
    // know grants (the tests' grantAware: false) serves it to anyone. The items are made up. / 有核验时只有验过的授权才到这里
    history: async (params, ctx) => ({ visitor: ctx.grant?.user ?? null, items: [{ pair: 'BEM/USD', note: 'example-only' }], caller: callerOf('history', params, ctx) }),
  }
  return { methods, seen }
}
