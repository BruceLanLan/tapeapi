// Compile-only check of the hand-written .d.ts files of @tapeapi/sdk and @tapeapi/server, through the packages'
// `exports` maps (node_modules/@tapeapi/* are the workspace folders). Never run; `npm run check:types` compiles it:
//   npx --yes -p typescript@5 tsc --noEmit --strict --module nodenext --moduleResolution nodenext --target es2022 \
//     --lib es2022,dom --skipLibCheck false scripts/types-sample.ts
import {
  createTapeAPI, TapeAPIError, MAINNET, BUS_RPC_URLS, createRpc, channel, webmcp, sig, abi, parseUnits, formatUnits,
  RPC_DEFAULTS, rpcUrlsFor, operatorOf, type RpcNode,
  group, deliverGroupUpdate, checkGroupInvites, type GroupDelivery, type GroupDeliveryResult, type GroupInviteCheck,
  type ResolvedService, type CallResult, type TapeAPI, type Rpc,
} from '@tapeapi/sdk'
import { exposeTapeAPI, manifestToTools } from '@tapeapi/sdk/webmcp'
import { createInvite, acceptInvite, completeInvite, generateIdentity, fanIn } from '@tapeapi/sdk/channel'
import { canonicalJSON } from '@tapeapi/sdk/canon'
import { validateManifest } from '@tapeapi/sdk/manifest'
import { voucherDigest } from '@tapeapi/sdk/sig'
import { encodeCall } from '@tapeapi/sdk/abi'
import { createRpc as createRpc2 } from '@tapeapi/sdk/rpc'
import { createProvider, memoryStore, VERSION, type Provider } from '@tapeapi/server'
import { ai } from '@tapeapi/sdk'
import { createVerifyingFetch, verifyUsageReceipt, FORMATS, type AIFormat, type UsageReceipt } from '@tapeapi/sdk/ai'
import { createAIProxy, type AIProxy } from '@tapeapi/server/ai-proxy'
import { createOpenAIProxy } from '@tapeapi/server/openai-proxy'

async function consumer(): Promise<void> {
  const api: TapeAPI = createTapeAPI({
    rpcUrls: ['https://bsc-dataseed.bnbchain.org', 'https://bsc-mainnet.public.blastapi.io', 'https://rpc-bsc.48.club'],
    quorum: 2,
  })
  const defaults: string[] = rpcUrlsFor(56)
  const nodes: readonly RpcNode[] = RPC_DEFAULTS[56]
  const who: string = operatorOf(nodes[0].url)
  const operators: string[] = createRpc({ urls: defaults, quorum: 2 }).operators
  const svc: ResolvedService = await api.resolve('11.1013.tape')
  const r: CallResult<{ bnbUsd: string }> = await api.call(svc, 'bnbUsd', {})
  const s: string = r.result.bnbUsd
  const again = await api.refresh(svc)
  const other = await api.resolve({ circuits: MAINNET.hub, tokenId: 1n })
  const q = await api.callQuorum([again, other], 'bnbUsd', { block: r.block }, { quorum: 2, onDissent: 'reject' })
  const agreed: string[] = q.agreed
  const accepted: Record<string, bigint> = api.acceptPrice(svc)
  const one: bigint | undefined = api.acceptedPrice(svc, 'bnbUsd')
  const payer = api.payer({ consumer: MAINNET.hub, sessionKey: api.randomPrivateKey(), ttl: 600 })
  const lease = await payer.reserve(svc, parseUnits('0.01'))
  await lease.commit()
  const fund = api.tx.fund(svc, 10n ** 8n)
  const pub = api.tx.publishManifest({ container: svc.container, manifest: svc.manifest })
  const rpc: Rpc | null = api.rpc
  const head: number | undefined = await rpc?.blockNumber()
  const container: string = await api.chain.accountOf(MAINNET.hub, 1)
  const keys = await api.chain.channelKeys(container)
  const bus = createRpc({ urls: [...BUS_RPC_URLS], quorum: 2, timeoutMs: 15000 })
  const rpc2 = createRpc2({ urls: ['http://a', 'http://b'] })
  try { await api.call(svc, 'nope') } catch (e) { if (e instanceof TapeAPIError) { const c: string = e.code; void c } }
  void [s, agreed, accepted, one, fund.to, pub.txs, head, keys.x25519, bus, rpc2, formatUnits(1n), sig.randomPrivateKey(), abi.ZERO_ADDRESS]

  const tools = manifestToTools(svc.manifest, { prefix: 'x_' }).tools
  const handle = await exposeTapeAPI(api, '11.1013.tape', { modelContext: null })
  if (handle.supported) await handle.refresh()
  handle()
  const h2 = await webmcp.exposeTapeAPI(api, svc)
  h2.dispose()
  void tools[0]?.inputSchema

  const a = generateIdentity(), b = channel.generateIdentity()
  const { invite, pending } = createInvite({
    self: { container: MAINNET.hub, staticSecret: a.x25519.secretKey },
    peer: { container: MAINNET.factory, staticPublic: b.x25519.publicKey },
    relays: [{ url: 'https://relay.tapeapi.fun' }],
  })
  const acc = acceptInvite({ self: { container: MAINNET.factory, staticSecret: b.x25519.secretKey }, peer: { container: MAINNET.hub, staticPublic: a.x25519.publicKey }, invite })
  const done = completeInvite(pending, acc.accept)
  acc.session.confirm(done.ready)
  const frame: Uint8Array = done.session.seal('hi')
  void [frame, fanIn, canonicalJSON({ a: 1 }), validateManifest, voucherDigest, encodeCall('ownerOf', [1n])]
}

async function provider(): Promise<void> {
  const p: Provider = createProvider({
    manifest: {},
    signerKey: '0x' + '11'.repeat(32),
    methods: { bnbUsd: async (_params, ctx) => ({ block: ctx.block, free: ctx.price === 0n }) },
    rpcUrls: ['https://bsc-dataseed.bnbchain.org', 'https://bsc-mainnet.public.blastapi.io'],
    store: memoryStore(),
  })
  const server = await p.listen(8787)
  server.close()
  const res: Response = await p.handleRequest(new Request('https://x/tapeapi/v1/bnbUsd', { method: 'POST', body: '{}' }), { clientIp: '1.2.3.4' })
  const due = await p.dueSettlements({ marginS: 600 })
  void [res.status, due[0]?.reason, p.settleTx(due[0]!), VERSION, p.container]
}

// AI usage receipts: the sidecar and client-side verification. / AI 用量回执：旁路与客户端核验。
async function aiSidecar(): Promise<void> {
  const px: AIProxy = createAIProxy({
    upstream: { baseUrl: 'https://upstream.example/v1' }, manifestBase: { circuits: '0x', tokenId: '1', container: '0x', endpoints: { live: ['https://ai.example/tapeapi/v1'], async: false } },
    signerKey: '0x' + '11'.repeat(32), models: [{ id: 'm', aliases: ['m-2026'], formats: ['openai-chat'], prices: [{ currency: 'BEM', unit: '1M tokens', input: '1', output: '2', cacheRead: '0.5', cacheWrite1h: '4' }, { currency: 'USD1', unit: '1M tokens', input: '0.1', output: '0.2' }] }],
  })
  const chat: AIFormat = FORMATS[0]
  const base: string = px.manifest().ai.endpoints[0].baseUrl
  const fetch = createVerifyingFetch({ service: {}, api: createTapeAPI({}), onReport: (r) => void r.receipt?.result.usage?.cache_read_tokens })
  const receipt: UsageReceipt | null = verifyUsageReceipt({ envelope: null, manifest: { container: '0x', signer: '0x' } }).receipt
  void [chat.method, base, fetch, receipt?.result.prices?.[0]?.amount, receipt?.result.unpriced, receipt?.result.complete, receipt?.result.modelMatchedBy, receipt?.result.usage?.cache_write_1h_tokens, ai.MANIFEST_FIELD, createOpenAIProxy]
}

// TAP-27 groups: the owner delivers epoch message and invites in one call; the member checks its inbox.
// TAP-27 群聊：群主一步投递纪元消息与邀请；成员检查收件房间。
async function groups(): Promise<void> {
  const api = createTapeAPI({})
  const relay = await api.resolve('12.1013.tape')
  const me = generateIdentity()
  const created = await group.createGroup({ self: { container: MAINNET.hub }, identity: me, members: [], verifyMember: api.groupVerifier() })
  const added: number = created.added.length
  const sent: GroupDeliveryResult = await deliverGroupUpdate({ group: created.group, update: created, relay: { api, svc: relay } })
  const d: GroupDelivery | undefined = sent.deliveries[0]
  await deliverGroupUpdate({ group: created.group, invite: 'all', bus: { address: MAINNET.channelBus, sendTx: async (tx) => tx.data }, throwOnError: false })
  const found: GroupInviteCheck = await checkGroupInvites({ self: { container: MAINNET.factory, chainId: 56 }, identity: me, relay: { api, svc: relay }, cursors: new Map(), checkSelf: true })
  void [added, d?.room, d?.i, d?.error?.rateLimited, found.invites[0]?.invite.gid, found.skipped, found.room]
}

void consumer; void provider; void aiSidecar; void groups
