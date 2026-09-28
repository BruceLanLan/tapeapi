// Compile-only check of the hand-written .d.ts files of @tapeapi/sdk and @tapeapi/server, through the packages'
// `exports` maps (node_modules/@tapeapi/* are the workspace folders). Never run; `npm run check:types` compiles it:
//   npx --yes -p typescript@5 tsc --noEmit --strict --module nodenext --moduleResolution nodenext --target es2022 \
//     --lib es2022,dom --skipLibCheck false scripts/types-sample.ts
import {
  createTapeAPI, TapeAPIError, MAINNET, BUS_RPC_URLS, createRpc, channel, busPrivacy, webmcp, sig, abi, parseUnits, formatUnits,
  RPC_DEFAULTS, rpcUrlsFor, operatorOf, type RpcNode,
  group, deliverGroupUpdate, checkGroupInvites, type GroupDelivery, type GroupDeliveryResult, type GroupInviteCheck,
  type ResolvedService, type CallResult, type TapeAPI, type Rpc,
} from '@tapeapi/sdk'
import { exposeTapeAPI, manifestToTools } from '@tapeapi/sdk/webmcp'
import { createInvite, acceptInvite, completeInvite, generateIdentity, fanIn } from '@tapeapi/sdk/channel'
import { busPrivacyReader, type BusPrivacyStats } from '@tapeapi/sdk/bus-privacy'
import { canonicalJSON } from '@tapeapi/sdk/canon'
import { validateManifest } from '@tapeapi/sdk/manifest'
import { voucherDigest } from '@tapeapi/sdk/sig'
import { encodeCall } from '@tapeapi/sdk/abi'
import { createRpc as createRpc2 } from '@tapeapi/sdk/rpc'
import { createProvider, memoryStore, VERSION, type Provider } from '@tapeapi/server'
import { ai } from '@tapeapi/sdk'
import { createVerifyingFetch, verifyUsageReceipt, FORMATS, type AIFormat, type UsageReceipt } from '@tapeapi/sdk/ai'
import { createAIProxy, type AIProxy } from '@tapeapi/server/ai-proxy'
import { createMcpServer, receiptOf, hashReceipt, verifyLink, toolResultOf, toolsDigest, invisibleProblems, quoteProvenance, RECEIPT_META_KEY, type Receipt, type HashedReceipt, type McpTool, type CallToolResult } from '@tapeapi/sdk/mcp'
import { CHAINS as CHAINS2, chainById, parseTapeName, formatTapeName, isNameShaped, type TapeOutChain, type ParsedTapeName } from '@tapeapi/sdk/chains'
import { createMcpEndpoint, MCP_PATH } from '@tapeapi/server/mcp'
import { createMcpProxy, MCP_UPSTREAM_TIMEOUT_MS, type McpProxy, type McpProxyStats } from '@tapeapi/server/mcp-proxy'
import { AI_UPSTREAM_TIMEOUT_MS } from '@tapeapi/server/ai-proxy'
import type { ManifestBase } from '@tapeapi/server'

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
  const reader = busPrivacyReader({ rpc: bus, bus: MAINNET.channelBus, rooms: [channel.inboxRoom(container)], cover: { k: 8, store: new Map() }, contract: { onExceed: 'cover' } })
  reader.add('00'.repeat(32), (wire, { room }) => { void wire.length; void room.length })
  const privacy: BusPrivacyStats = reader.stats().privacy
  const k: number | null = privacy.effectiveK
  const r2 = busPrivacy.busPrivacyReader({ rpc: bus, bus: MAINNET.channelBus, mode: 'contract' })
  r2.setMode('plain')
  void [k, reader.covers, r2.mode]
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
  void [chat.method, base, fetch, receipt?.result.prices?.[0]?.amount, receipt?.result.unpriced, receipt?.result.complete, receipt?.result.modelMatchedBy, receipt?.result.usage?.cache_write_1h_tokens, ai.MANIFEST_FIELD]
}

// TAP-27 groups: the owner delivers epoch message and invites in one call; the member checks its inbox.
// TAP-27 群聊：群主一步投递纪元消息与邀请；成员检查收件房间。
async function groups(): Promise<void> {
  const api = createTapeAPI({})
  const relay = await api.resolve('12.1013.tape')
  const me = generateIdentity()
  const created = await group.createGroup({ self: { container: MAINNET.hub }, identity: me, members: [], verifyMember: api.groupVerifier(), clock: () => Date.now() / 1000 })
  const added: number = created.added.length
  const owner: group.OwnerGroup = created.group
  const up: group.GroupUpdate = await owner.rotate()
  const invite: Uint8Array = owner.inviteFor({ container: MAINNET.hub, chainId: 56 })
  const snap: group.GroupSnapshot = owner.snapshot()
  const member: group.GroupHandle = group.joinGroup({ self: { container: MAINNET.factory }, identity: me, invite: { gid: owner.gid, owner: { container: MAINNET.hub, chainId: 56 } }, ownerKeys: {}, lastSeq: snap.lastSeq })
  const accepted = await member.acceptEpoch(up.epochWire, { verifyMember: 'trust-roster' })
  const msg = member.open(owner.seal('hi'), { text: true })
  const epochNow: number | null = member.epoch
  void [invite, accepted.roster.members[0]?.x25519, msg.own ? msg.seq : msg.from, epochNow, owner.epochWire.length]
  const sent: GroupDeliveryResult = await deliverGroupUpdate({ group: owner, update: created, relayClients: [{ api, service: relay }] })
  const d: GroupDelivery | undefined = sent.deliveries[0]
  await deliverGroupUpdate({ group: owner, invite: 'all', busClients: [{ address: MAINNET.channelBus, sendTx: async (tx) => tx.data }], throwOnError: false })
  const found: GroupInviteCheck = await checkGroupInvites({ self: { container: MAINNET.factory, chainId: 56 }, identity: me, relayClients: [{ api, service: relay }], cursors: new Map(), checkSelf: true })
  void [added, d?.room, d?.i, d?.error?.rateLimited, found.invites[0]?.invite.gid, found.skipped, found.room]
}

// MCP: the SDK core, the provider's remote endpoint and the signing proxy (review G1 M12). / MCP：SDK 核心、远程端点、签名代理。
async function mcpAll(): Promise<void> {
  const server = createMcpServer({ info: { name: 'x', version: '1' }, listTools: async (): Promise<McpTool[]> => [], callTool: async (): Promise<CallToolResult> => ({ content: [], isError: false }) })
  const answer: Record<string, unknown> | null = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  const receipt: Receipt = receiptOf({ envelope: {}, method: 'm', params: {}, circuits: '0x', tokenId: 1, name: '11.1013.tape' })
  const hashed: HashedReceipt = hashReceipt(receipt)
  const link: string = verifyLink(hashed, undefined, { content: false })
  const shown: CallToolResult = toolResultOf({ receipt, checkedBy: 'client' })
  const digest: string = toolsDigest([])
  const bad: string[] = invisibleProblems([])
  const quoted = quoteProvenance([{ type: 'text', text: 'x' }])
  const provider = createProvider({ manifest: {}, signerKey: '0x', methods: {} })
  const ep = createMcpEndpoint({ provider, manifest: provider.manifest, name: '11.1013.tape', linkContent: false, onMessage: (m) => void m.method })
  const res: Response = await ep.handleRequest(new Request('https://x.example' + MCP_PATH), { clientIp: '1.2.3.4' })
  const base: ManifestBase = { circuits: '0x', tokenId: '1', container: '0x', endpoints: { live: ['https://m.example/tapeapi/v1'], async: false } }
  const px: McpProxy = createMcpProxy({ upstream: { url: 'https://up.example/mcp' }, manifestBase: base, signerKey: '0x', name: '11.1013.tape', upstreamTimeoutMs: MCP_UPSTREAM_TIMEOUT_MS })
  const st: McpProxyStats = px.stats()
  const timeouts: number[] = [MCP_UPSTREAM_TIMEOUT_MS, AI_UPSTREAM_TIMEOUT_MS]
  void [answer, link, shown.isError, digest, bad, quoted, res.status, st.drift, px.tools().length, timeouts, RECEIPT_META_KEY]
}

// Chains and names. / 各链与名字。
function chainsAll(): void {
  const bnb: TapeOutChain | null = chainById(56)
  const x: TapeOutChain = CHAINS2[196]
  const p: ParsedTapeName | { error: string } | null = parseTapeName('1.2.344.tape')
  const name: string = formatTapeName({ tokenId: 1n, processor: 344, chainId: 196 }, { suffix: false })
  const shaped: boolean = isNameShaped('11.1013')
  void [bnb?.payments, x.area, p && !('error' in p) ? p.chainId : null, name, shaped]
}

// Option interfaces carry no index signature since 1.0 (review G1 S12): a misspelt option is a compile error.
// 1.0 起选项接口不带索引签名：拼错的选项是编译错误。
function optionTypos(): void {
  // @ts-expect-error rpcTimeoutMs, not timeoutMs; and no unknown keys
  createTapeAPI({ rpcUrl: ['https://a.example'] })
  // @ts-expect-error a misspelt provider option
  createProvider({ manifest: {}, signerKey: '0x', methods: {}, allowHTTP: true })
  // @ts-expect-error a misspelt channel option
  channel.createInvite({ self: { container: '0x', staticSecret: new Uint8Array(32), staticSecrets: 1 }, peer: { container: '0x', staticPublic: '0x' } })
}

void consumer; void provider; void aiSidecar; void groups; void mcpAll; void chainsAll; void optionTypos

// FIXED RC-11 (review 2026-09-29, O P1-8): the documented usages the declarations used to reject under --strict, as the
// guides write them (docs/guides/groups.md, channels.md, public-api.md; index.d.ts's own advice on BUS_RPC_URLS).
// FIXED RC-11：声明文件曾在 --strict 下拒绝的文档用法，按指南原样写出。
async function documentedUsages(myContainer: string, myIdentity: ReturnType<typeof generateIdentity>, bobContainer: string): Promise<void> {
  const api = createTapeAPI({ rpcUrls: rpcUrlsFor(56), quorum: 2 })
  const relay = { api, service: await api.resolve('12.1013.tape') }                       // a TapeAPI is a relay client's api
  const members = await Promise.all([bobContainer].map((c) => api.chain.channelKeys(c)))
  const created = await group.createGroup({
    self: { container: myContainer, chainId: 56 }, identity: myIdentity, members, verifyMember: api.groupVerifier(),
    relays: [{ url: 'https://relay.tapeapi.fun/tapeapi/v1', container: relay.service.container }],
  })
  await deliverGroupUpdate({ group: created.group, update: created, relayClients: [relay] })   // createGroup's result is an update
  const g = created.group
  await deliverGroupUpdate({ group: g, update: await g.addMembers([await api.chain.channelKeys(bobContainer)], { verifyMember: api.groupVerifier() }), relayClients: [relay] })
  await deliverGroupUpdate({ group: g, update: await g.removeMembers([bobContainer]), relayClients: [relay] })
  await deliverGroupUpdate({ group: g, update: await g.rotate(), relayClients: [relay] })
  const resumed = await group.resumeGroup({ self: { container: myContainer, chainId: 56 }, identity: myIdentity, snapshot: g.snapshot(), verifyMember: api.groupVerifier() })
  await deliverGroupUpdate({ group: resumed.group, update: resumed, relayClients: [relay] })
  const link = channel.relayTransport({ api, service: relay.service, inbound: created.group.room, outbound: created.group.room })
  link.start((wire) => {
    const t = channel.decodeWire(wire)
    if (t.groupEpoch) void t.groupEpoch.byteLength                                          // the group wires decode too
    if (t.groupMessage) void t.groupMessage.byteLength
    if (t.handshake) void t.handshake
  })
  const busRpc = createRpc({ urls: BUS_RPC_URLS, quorum: 2, timeoutMs: 15000 })            // the readonly defaults as they are
  void busRpc
}
void documentedUsages
