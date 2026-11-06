// The local world of the container-interop example (EXPERIMENTAL; the fake chain only; nothing leaves this process).
// It is the agent-service demo world (principal container A = #11, agent container #12, providers #13 and #14) plus two
// containers the channel scenario needs: a relay (#15, the reference relay core behind createProvider, served in-process) and
// a service container B (#16, one free method, `quote`, whose answers are signed by its manifest signer). A and B publish a
// channel record each, authorised by their holders, exactly as scripts/channel-keys.mjs would.
// FAKE KEYS, FOR THIS FAKE CHAIN ONLY: every key below is a fixture of the test helpers or a repeated byte. They exist on no
// real chain and guard nothing; never use one of them anywhere else.
// 容器互通示例的本地世界（实验性；只在假链上；不出本进程）。它是 agent-service 演示世界（委托方容器 A = #11、代理容器 #12、服务 #13、#14）
// 加上通道场景需要的两个容器：中继（#15，createProvider 背后的参考中继核心，进程内提供）与服务容器 B（#16，一个免费方法 `quote`，
// 回答由其清单 signer 签名）。A 与 B 各发布一份由持有人授权的通道记录，与 scripts/channel-keys.mjs 做的一样。
// 密钥只是假链夹具或重复字节：它们在任何真链上都不存在、不保护任何东西，绝不要用到别处。
import { createProvider } from '@tapeapi/server'
import { channel, sig, canonicalJSON, CHANNEL_KEYS_KEY } from '@tapeapi/sdk'
import { createDemoWorld, restoreTime, KEYS, P, AG, S, S2, NOW } from '../agent-service/demo-world.mjs'
import { createRelayCore, relayMethods, relayManifestMethods } from '../relay-service/relay-core.mjs'
import { ADDR } from '../../sdk/test/helpers/agent-chain.mjs'

export { restoreTime, KEYS, P, AG, S, S2, NOW }
export const RELAY = '0x' + '3e'.repeat(20)                // relay container, #15
export const B = '0x' + 'b7'.repeat(20)                    // service container B, #16
export const RELAY_ORIGIN = 'https://relay.example'
export const RELAY_URL = `${RELAY_ORIGIN}/tapeapi/v1`
export const B_ORIGIN = 'https://b.example'
export const FIXTURE = {
  relayHolder: '0x' + 'c1'.repeat(32), relaySigner: '0x' + 'c2'.repeat(32),
  bHolder: '0x' + 'b1'.repeat(32), bSigner: '0x' + 'b2'.repeat(32),
}
const MANIFEST_PATH = '.well-known/tapeapi.json'
const hex = (b) => '0x' + Buffer.from(b).toString('hex')
const DAY = 86_400

/**
 * @param {object} o
 *   spend, agentOptions, sameHolder, readMethod   passed to createDemoWorld (see examples/agent-service/demo-world.mjs)
 *   channels   publish the channel records of A and B and serve the relay and B (default true)
 * Returns the demo world with: relay { core, url }, b { container, provider, signer }, identities { a, b } (the channel
 * secrets, which a real container keeps in a file of its own), and apiFor() for one more independent client.
 */
export async function createInteropWorld({ channels = true, ...demo } = {}) {
  const world = await createDemoWorld(demo)
  const { x } = world
  const out = { ...world }
  // apiFor(): one more client, reading the fake chain the 1.x way and saying so with `dev: true` (since 2.0 that means the 1.x
  // resolution, not deprecated); `conform: undefined` drops the deprecated `conform: false` of the shared test helper. The
  // 2.0 default (`conform: 'tap10'`) refuses this fake chain's own hub and factory. The clients of the agent-service demo
  // world (principalApi and the others) are that example's and still pass the helper's `conform: false`.
  // apiFor()：再一个客户端，按 1.x 方式读假链并用 dev: true 写明；2.0 默认（conform: 'tap10'）不接受假链自己的 hub 与 factory。
  // agent-service 演示世界里的客户端（principalApi 等）属于那个示例，仍沿用测试辅助的 conform: false。
  out.apiFor = () => x.api({ fetch: world.fetch, clock: world.clock, dev: true, conform: undefined })
  if (!channels) return out

  const manifestOf = (c) => JSON.parse(new TextDecoder().decode(x.chain.state.files.get(`${c.toLowerCase()}:${MANIFEST_PATH}`).bytes))
  const serve = (c, origin, methods) => {
    const m = { ...manifestOf(c), endpoints: { live: [`${origin}/tapeapi/v1`], async: false }, methods }
    x.chain.writeFile(c, MANIFEST_PATH, JSON.stringify(m))
    return m
  }

  // #15 the relay: the reference relay core, behind a verified provider, in this process. It stores ciphertext per room.
  x.service(RELAY, 15, { holderKey: FIXTURE.relayHolder, signerKey: FIXTURE.relaySigner, name: 'Relay' })
  const core = createRelayCore()
  const relayManifest = serve(RELAY, RELAY_ORIGIN, relayManifestMethods({ priceBEM: '0' }))
  world.hosts.set(RELAY_ORIGIN, createProvider({ manifest: relayManifest, signerKey: FIXTURE.relaySigner, dev: true, methods: relayMethods(core), rateLimit: false, log: () => {} }))
  out.relay = { container: RELAY, core, url: RELAY_URL }

  // #16 container B: one free method. `quote` answers { sku, qty } with a reference; what B signs is a TAPI-21 envelope.
  x.service(B, 16, { holderKey: FIXTURE.bHolder, signerKey: FIXTURE.bSigner, name: 'Container B' })
  const quotes = []
  const bManifest = serve(B, B_ORIGIN, [{ name: 'quote', priceBEM: '0', params: {}, returns: {} }])
  const provider = createProvider({
    manifest: bManifest, signerKey: FIXTURE.bSigner, dev: true, rateLimit: false, log: () => {},
    methods: {
      // params are data: nothing in them chooses a method, a container or an address
      quote: async (params) => {
        const sku = typeof params?.sku === 'string' ? params.sku.slice(0, 64) : ''
        const qty = Number.isSafeInteger(params?.qty) && params.qty > 0 && params.qty <= 1000 ? params.qty : 1
        quotes.push({ sku, qty })
        return { sku, qty, unitPriceCents: 250, totalCents: 250 * qty, reference: `Q-${quotes.length}` }
      },
    },
  })
  world.hosts.set(B_ORIGIN, provider)
  out.b = { container: B, provider, signer: sig.privateKeyToAddress(FIXTURE.bSigner), quotes }

  // each container publishes the channel keys its holder authorised (TAPI-26 §3.1): the secrets stay with the container
  const publish = (container, holderKey, { relays = [] } = {}) => {
    const id = channel.generateIdentity()
    const keys = { container, x25519: hex(id.x25519.publicKey), ed25519: hex(id.ed25519.publicKey), inbox: { relays }, issued: NOW - 60, expires: NOW + 30 * DAY }
    const record = { tapechannel: '1', container, chainId: 56, ...keys, sig: sig.signDigest(sig.channelKeysDigest(56, ADDR.hub, keys), holderKey) }
    x.chain.writeFile(container, CHANNEL_KEYS_KEY, canonicalJSON(record))
    return { id, record }
  }
  const relays = [{ url: RELAY_URL, container: RELAY }]
  out.identities = { a: publish(P, KEYS.principalHolder, { relays }), b: publish(B, FIXTURE.bHolder, { relays }) }
  out.publishChannelKeys = publish
  return out
}
