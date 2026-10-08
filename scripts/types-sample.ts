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
import { TAP10_SEALS, TAP10_MAX_CHAIN_ID, tapesend } from '@tapeapi/sdk'   // 1.5
import { formatPaymentAmount, PAYMENT_TOKENS, AUDITED_ESCROWS, type PaymentToken } from '@tapeapi/sdk'   // escrow v3, experimental
import { exposeTapeAPI, manifestToTools } from '@tapeapi/sdk/webmcp'
import { createInvite, acceptInvite, completeInvite, generateIdentity, fanIn } from '@tapeapi/sdk/channel'
import { busPrivacyReader, type BusPrivacyStats } from '@tapeapi/sdk/bus-privacy'
import { canonicalJSON } from '@tapeapi/sdk/canon'
import { validateManifest, validateAgentMember, type AgentMember } from '@tapeapi/sdk/manifest'
import * as agentKit from '@tapeapi/sdk/agent'
import { createAgentKit, createPaymentKit, paymentOrder, mandateTypedData, encodeContent, decodeContent, type Mandate, type ThreadCheck, type MandateCheck, type AttachmentCheck, type ThreadMessage } from '@tapeapi/sdk/agent'
import { voucherDigest } from '@tapeapi/sdk/sig'
import { encodeCall } from '@tapeapi/sdk/abi'
import { createRpc as createRpc2 } from '@tapeapi/sdk/rpc'
import { createProvider, memoryStore, VERSION, type Provider } from '@tapeapi/server'
import { ai } from '@tapeapi/sdk'
import { createVerifyingFetch, verifyUsageReceipt, FORMATS, type AIFormat, type UsageReceipt, type UsageRequestSkip } from '@tapeapi/sdk/ai'
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
  const fund = await api.tx.fund(svc, 10n ** 8n)
  const approval = await api.tx.approve({ amount: 10n ** 8n, spender: svc })
  const fundUsdt = await createTapeAPI({ escrow: MAINNET.hub, allowEscrows: [MAINNET.hub] }).tx.fund(MAINNET.hub, 1n, { token: MAINNET.hub })
  void [approval.to, fundUsdt.data]
  // escrow v3 (experimental) / 托管 v3（实验性）
  const tok: PaymentToken = await api.chain.escrow.paymentToken(svc)
  const shown: string = formatPaymentAmount(10n ** 18n, tok)
  const accrued: bigint = await api.chain.escrow.treasuryAccrued(svc)
  const claim = api.tx.claimTreasury(svc)
  const labels: string | undefined = PAYMENT_TOKENS[56]?.[tok.token.toLowerCase()]?.label
  const audited: readonly string[] = AUDITED_ESCROWS[56] ?? []
  void [shown, accrued, claim.data, labels, audited, abi.eventTopic('TreasuryClaimed'), await api.chain.escrow.token()]
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
  // 1.6: the client asks for the usage itself; the report says whether it did, or why not. / 客户端自己要用量；报告说明是否做到、为何没有。
  const asking = createVerifyingFetch({ service: {}, requestUsage: true, strict: false, onReport: (r) => { const asked: boolean | undefined = r.usageRequested; const why: UsageRequestSkip | undefined = r.usageRequestSkipped; void [asked, why] } })
  const member: readonly [string, string] | undefined = chat.usageMember
  void [chat.method, base, fetch, asking, member, receipt?.result.prices?.[0]?.amount, receipt?.result.unpriced, receipt?.result.complete, receipt?.result.modelMatchedBy, receipt?.result.usage?.cache_write_1h_tokens, ai.MANIFEST_FIELD]
}

// TAPI-27 groups: the owner delivers epoch message and invites in one call; the member checks its inbox.
// TAPI-27 群聊：群主一步投递纪元消息与邀请；成员检查收件房间。
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
  const member: group.GroupHandle = group.joinGroup({ self: { container: MAINNET.factory }, identity: me, invite: { gid: owner.gid, owner: { container: MAINNET.hub, chainId: 56 } }, ownerKeys: {}, lastSeq: snap.lastSeq, verifyConcurrency: group.VERIFY_CONCURRENCY })
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

// @experimental TAPI-27 §3.8: a format-2 group (up to 128), lazy member checks / 格式 2 群（至多 128 人），惰性核验
async function groupsV2(): Promise<void> {
  const api = createTapeAPI({})
  const me = generateIdentity()
  const verify: group.MemberVerifierV2 = group.channelKeysVerifier(api)
  const created = await group.createGroup({ format: 2, self: { container: MAINNET.hub }, identity: me, members: [], verifyMember: verify })
  const owner: group.OwnerGroupV2 = created.group
  const f: 2 = owner.format
  const member: group.GroupHandleV2 = group.joinGroup({ format: 2, self: { container: MAINNET.factory }, identity: me, invite: { gid: owner.gid, owner: { container: MAINNET.hub, chainId: 56 }, format: 2 }, ownerKeys: {}, verifyMember: verify, verifyReuseS: group.VERIFY_REUSE_S })
  const r = await member.acceptEpoch(created.epochWire)
  const m = member.open(owner.seal('hi'), { text: true })
  const shown: boolean = m.own ? true : m.verified
  const checked = await member.openVerified(owner.seal('again'))
  const scan = await member.verifyMembers({ concurrency: 4 })
  const who: group.RosterMemberV2 | undefined = member.members[0]
  // GRPR-4: a format-2 snapshot resumes to a format-2 owner handle / 格式 2 快照恢复为格式 2 群主句柄
  const resumed = await group.resumeGroup({ self: { container: MAINNET.hub }, identity: me, snapshot: owner.snapshot(), verifyMember: verify })
  const owner2: group.OwnerGroupV2 = resumed.group
  // GRPR-5: format-2 options on a format-1 invite are accepted (and ignored) / 格式 1 邀请上的格式 2 选项被接受（并忽略）
  const v1: group.GroupHandle = group.joinGroup({ self: { container: MAINNET.factory }, identity: me, invite: { gid: owner.gid, owner: { container: MAINNET.hub, chainId: 56 } }, ownerKeys: {}, verifyMember: verify })
  void [f, r.unverified, shown, checked, scan.failed[0]?.error.code, who?.verified, group.MAX_MEMBERS_V2, group.FORMAT_V2_MARK, group.VERIFY_NEGATIVE_S, owner2.format, v1.format]
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

// Security 1.2 (@experimental): the Merkle proof mode. / 默克尔证明模式。
async function security12(): Promise<void> {
  const { proof } = await import('@tapeapi/sdk')
  const api = createTapeAPI({ rpcUrls: rpcUrlsFor(56), pin: true, proofs: 'strict' })
  const svc = await api.resolve('11.1013.tape')
  const root: string | null | undefined = svc.proofs?.stateRoot
  const reads: string[] = (svc.proofs?.verified ?? []).map((x) => x.read)
  const missing: Array<string | undefined> = (svc.proofs?.unavailable ?? []).map((x) => x.reason)
  const b = await api.rpc!.confirmedBlock('finalized', { stateRoot: true })
  const sr: string | undefined = b.stateRoot
  const slots = proof.STORAGE.fileInfo(svc.container, '.well-known/tapeapi.json')
  const s: bigint = slots.sha256Hash
  const checked = proof.verifyAccountProof(b.stateRoot!, MAINNET.siteRegistry, [slots.size, slots.sha256Hash], { accountProof: [], storageProof: [] })
  const v: bigint | undefined = checked.values.get(slots.size)
  const leaf: Uint8Array | null = proof.verifyMptProof(proof.EMPTY_TRIE_ROOT, '0x' + '00'.repeat(32), [], { secure: true })
  try { await api.resolve('11.1013.tape') } catch (e) { if (e instanceof TapeAPIError && (e.code === 'PROOF_INVALID' || e.code === 'PROOF_UNAVAILABLE')) { const what: unknown = e.data?.read; void what } }
  const relaxed = createTapeAPI({ rpcUrls: rpcUrlsFor(56), pin: true, proofs: true })
  void root; void reads; void missing; void sr; void s; void v; void leaf; void relaxed
}
void security12

// Security 1.1 (@experimental): pinning, sentinel, content signature, delegation floor, evidence, second opinions.
async function security11(): Promise<void> {
  const { security } = await import('@tapeapi/sdk')
  const { manifestContentTypedData, manifestContentDigest, MANIFEST_CONTENT_FIELD } = await import('@tapeapi/sdk/sig')
  const api = createTapeAPI({
    rpcUrls: rpcUrlsFor(56), clock: () => Date.now() / 1000, pin: { maxAgeS: 120, by: 'hash' }, sentinel: 'strict',
    requireContentSig: true, delegationFloor: new Map(), onWarning: (w) => { const c: string = w.code; void c },
  })
  const svc = await api.resolve('11.1013.tape')
  const at: number | undefined = svc.pinned?.number
  const seen: 'match' | 'mismatch' | 'unchecked' | undefined = svc.sentinel?.container
  const ok: boolean | undefined = svc.contentSig?.valid
  const block = await api.rpc!.confirmedBlock('finalized')
  const n: number = block.number
  const local: string = security.erc6551Account({ registry: MAINNET.hub, implementation: MAINNET.hub, chainId: 56, tokenContract: MAINNET.factory, tokenId: 1n })
  const td = manifestContentTypedData(56, MAINNET.hub, { container: local, manifest: { tapeapi: '0.1' } })
  const d: Uint8Array = manifestContentDigest(56, MAINNET.hub, { container: local, contentHash: '0x' + '00'.repeat(32) })
  const field: 'contentSig' = MANIFEST_CONTENT_FIELD
  try { await api.callQuorum([svc], 'read', {}) } catch (e) {
    for (const rec of security.contradictionsOf(e)) {
      const check = await security.verifyContradiction(rec, { signerOf: async (c) => (await api.resolve(c)).manifest.signer })
      if (check.valid) { const kind: 'self' | 'cross' = check.kind; const yes: true = check.signersChecked; void kind; void yes }
      else if (check.signaturesConsistent) { const kind: 'self' | 'cross' = check.kind; const no: false = check.signersChecked; void kind; void no }
      else { const why: string = check.reason; void why }
    }
  }
  try { await api.resolve('11.1013.tape') } catch (e) {
    if (e instanceof TapeAPIError && e.code === 'DELEGATION_INVALID' && e.data?.floor) { const had: boolean = await api.clearDelegationFloor(e.data as { container: string; holder: string; signer: string }); void had }
  }
  const unchecked: false | undefined = svc.contentSig?.checked
  const checked = security.withSpotCheck(api, { rate: 0.05, alternates: [svc], onMismatch: (o) => { const same: boolean = o.same; void same }, onError: async (e) => { void e } })
  const r = await checked.call(svc, 'bnbUsd', {})
  void [at, seen, ok, n, td, d, field, r.spotCheck, unchecked]
}
void security11

// @experimental 1.4: the TAP-10 conformance mode and siteStatus / TAP-10 一致模式与 siteStatus
async function conform14() {
  const api = createTapeAPI({ rpcUrls: rpcUrlsFor(56), conform: 'tap10', chains: { 8453: { opener: MAINNET.hub } } })
  const s = await api.siteStatus('#11@1013')
  const status: 'ok' | 'unpaid' | 'not-opened' | 'store-changed' | 'no-such-cpu' | 'no-such-token' | 'not-tapeout' = s.status
  const isLive: boolean | null | undefined = s.activation?.isLive
  const lag: number = s.pinned.lag
  try {
    const svc = await api.resolve('tape://11.1013.tape/')
    const site: 'ok' | undefined = svc.conform?.site
    const mode: 'tap10' | undefined = svc.pinned?.mode
    void [site, mode]
  } catch (e) {
    if (e instanceof TapeAPIError && e.code === 'SITE_STATUS') { const why: unknown = e.data?.status; void why }
  }
  const pinned = createTapeAPI({ rpcUrls: rpcUrlsFor(56), pin: 'tap10' })
  const b = await pinned.rpc!.tap10Block({ maxLag: 400 })
  void [status, isLive, lag, b.lag]
}
void conform14

// @experimental 1.5: the conformance mode's messaging path / 一致模式的消息路径
async function conform15() {
  const api = createTapeAPI({ rpcUrls: rpcUrlsFor(56), conform: 'tap10', sealStatusStore: new Map<string, unknown>() })
  const k = await api.chain.tapeSendKey('0x86DDaEF00401E3F10418398D67D7189fc458eA95')
  const key: string = k.staticPublic
  const sealed: boolean | undefined = k.tap10?.seal.factory
  const block: number | undefined = k.tap10?.pinned.number
  const rec = await api.chain.channelKeys('0x86DDaEF00401E3F10418398D67D7189fc458eA95')
  const accepted: boolean | undefined = rec.tap10?.implementations[0]?.accepted
  const beacon: string = TAP10_SEALS[56].circuitBeacon
  const max: bigint = TAP10_MAX_CHAIN_ID
  const ep: Uint8Array = tapesend.endpoint('0x86DDaEF00401E3F10418398D67D7189fc458eA95', 8453, { conform: 'tap10' })
  void tapesend.endpoint('0x86DDaEF00401E3F10418398D67D7189fc458eA95', 56, null)
  const id: string = tapesend.messageId({ chainId: 56, toChainId: 8453, hub: MAINNET.hub, to: '0x86DDaEF00401E3F10418398D67D7189fc458eA95', inboxIndex: 0, conform: 'tap10' })
  void [key, sealed, block, accepted, beacon, max, ep, id]
}
void conform15

// @experimental 1.5: input without chain information on every chain / 无链信息的输入在所有链上解析
async function conform15all() {
  const api = createTapeAPI({ rpcUrls: rpcUrlsFor(56), conform: 'tap10', allChains: true })
  const s = await api.siteStatus('0x86DDaEF00401E3F10418398D67D7189fc458eA95')
  const chains: Array<{ chainId: number; status: string }> | undefined = s.chains
  const live: boolean | undefined = s.activation?.isLive
  try { await api.resolve('0x0565EA48CA41Ae559d8d491dbb0a9ec945DB551b#1') } catch (e) {
    if (e instanceof TapeAPIError && e.data?.status === 'ambiguous') { const c: unknown = e.data.candidates; void c }
  }
  const svc = await api.resolve('4246.0.tape')
  const seen: Array<{ chainId: number; status: string }> | undefined = svc.conform?.chains
  createTapeAPI({ allChains: null }); createTapeAPI({ allChains: false })
  void [chains, live, seen]
}
void conform15all

// @experimental 1.7: container agents, phase 0 (the whole @tapeapi/sdk/agent subpath) / 容器代理阶段 0
async function agent17() {
  const api = createTapeAPI({ rpcUrls: rpcUrlsFor(56) })
  const kit = createAgentKit(api, { nonces: new Map(), revocationFloor: new Map(), clock: () => 1789000000 })
  const m: Mandate = { principal: '0x86DDaEF00401E3F10418398D67D7189fc458eA95', agent: '0x19366c3c69FFEB3b286D9fA6cC5e616375BAafd3', agentKey: '0x' + '77'.repeat(20), mode: agentKit.MODE_PAY, taskHash: agentKit.taskHashOf({ kind: 'x' }), scope: [], feeToken: '0x' + '00'.repeat(20), feeCap: '0', notBefore: 1, expires: 2, nonce: 1n, subdelegate: false }
  const typed = mandateTypedData(56, MAINNET.hub, m, { task: { kind: 'x' } })
  const w: agentKit.WalletRequest = agentKit.forWallet(typed, { chainId: 56, hub: MAINNET.hub })
  const fileBytes: Uint8Array = agentKit.revocationFileBytes({ chainId: 56, revocation: { principal: m.principal, mandateHashes: [], revokedBefore: 0, issued: 1 }, sig: '0x' })
  void [w, fileBytes]
  const checked: MandateCheck = await kit.verifyMandate({ mandate: m, sig: '0x' }, { agentKey: m.agentKey, readSite: true })
  const none: 'none' = checked.enforcement
  const msgs: ThreadMessage[] = []
  const t: ThreadCheck = await kit.verifyTaskThread(msgs, { at: 1789000000 })
  const self: boolean = t.selfHire
  const pay = createPaymentKit(api, { tokenAllowed: () => false })
  const tx = await pay.transferToContainer({ name: '12.1013.tape', token: '0x' + 'b0'.repeat(20), amount: '1' })
  const lines: string[] = tx.summary
  const viaFee: string = pay.viaContainer({ from: '0x' + 'c1'.repeat(20), tx, value: '200000000000000' }).value
  const viaNoFee: string = pay.viaContainer({ from: '0x' + 'c1'.repeat(20), tx }).value
  const msg = await pay.readMessage({ recipient: '0x' + 'a6'.repeat(20), inboxIndex: 0 })
  const r: AttachmentCheck = await pay.verifyAttachment(msg, msg.attachments[0])
  const order = paymentOrder({ clock: () => 1 })
  order.recordTransfer({ recipient: '0x' + 'a6'.repeat(20), tx: '0x' + '12'.repeat(32) })
  const bytes: Uint8Array = encodeContent({ body: 'paid', attachments: [{ type: 'erc20', chainId: 56, token: '0x' + 'b0'.repeat(20), amount: '1', tx: '0x' + '12'.repeat(32) }] })
  const decoded = decodeContent(bytes)
  const member: AgentMember = validateAgentMember({ tasks: [{ kind: 'x', pricing: { mode: 'free' } }], mandates: { accepts: true } })
  void [typed, none, self, lines, viaFee, viaNoFee, r, decoded, member, agentKit.THREAD_KINDS]
}
void agent17

// 1.8.1: TAPI-26 / TAPI-27 version 2 labels (tape-channel/, tape-group/), opt-in; both sides pass the same.
// 1.8.1：TAPI-26 / TAPI-27 第 2 版标签（tape-channel/、tape-group/），可选；双方传同样的值。
async function labelsV2(): Promise<void> {
  const labels: channel.Labels = 'v2'
  const a = generateIdentity(), b = generateIdentity()
  const { invite, pending } = createInvite({ self: { container: MAINNET.hub, staticSecret: a.x25519.secretKey }, peer: { container: MAINNET.factory, staticPublic: b.x25519.publicKey }, labels })
  const acc = acceptInvite({ self: { container: MAINNET.factory, staticSecret: b.x25519.secretKey }, peer: { container: MAINNET.hub, staticPublic: a.x25519.publicKey }, invite, labels })
  const listen = channel.roomsFor(pending.cid, { labels: pending.labels })
  const inbox: string = channel.inboxRoom(MAINNET.factory, 56, { labels })
  const wire: Uint8Array = channel.sealInvite(invite, { to: b.x25519.publicKey, labels })
  const v: 'v1' | 'v2' = acc.session.labels
  const me = generateIdentity()
  const created = await group.createGroup({ self: { container: MAINNET.hub }, identity: me, members: [], labels })
  const snap: group.GroupSnapshot = created.group.snapshot()
  const v3: group.GroupSnapshotLabelsV2 = { ...snap, v: 3, labels: 'v2', format: 1 }
  const v1snap: group.GroupSnapshotV1 = { v: 1, gid: snap.gid, owner: snap.owner, epoch: snap.epoch, role: 'owner', labels: 'v1' }
  const resumed = await group.resumeGroup({ self: { container: MAINNET.hub }, identity: me, snapshot: snap, labels })
  const room: string = group.groupRoom(created.group.gid, { labels: created.group.labels })
  const member: group.GroupHandle = group.joinGroup({ self: { container: MAINNET.factory }, identity: me, invite: group.openGroupInvite(wire, { self: {}, labels }), ownerKeys: {}, labels })
  const api = createTapeAPI({})
  const found: GroupInviteCheck = await checkGroupInvites({ self: { container: MAINNET.factory }, identity: me, relayClients: [{ api, service: await api.resolve('12.1013.tape') }], labels })
  void [listen.toInitiator, inbox, v, snap.labels, resumed.group.labels, room, member.labels, found.room, v3, v1snap]
}
void labelsV2
