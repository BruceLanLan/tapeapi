#!/usr/bin/env node
// relay.tape: the first TapeAPI service anyone needs. It forwards TAP-26 ciphertext between two peers who cannot
// reach each other directly, and cannot read a byte of it. Anyone may run one.
// relay.tape：人人都用得上的第一个 TapeAPI 服务。它在无法直连的两端之间转发 TAP-26 密文，自己一个字节也读不了。
// 任何人都可以架一个。
import { readFile } from 'node:fs/promises'
import { createProvider } from '@tapeapi/server'
import { sig } from '@tapeapi/sdk'
import { startProvider } from '../_lib/service.mjs'
import { fileStore } from '../_lib/store.mjs'
import { createRelayCore, relayMethods, relayManifestMethods } from './relay-core.mjs'

const PORT = Number(process.env.PORT || 8788)
const HOST = process.env.HOST || '127.0.0.1'
const PRICE = process.env.RELAY_PRICE_BEM || '0'
const PROD = !!(process.env.DELEGATION_SIG && process.env.DELEGATION_EXPIRES)
if (PROD && !process.env.PUBLIC_URL) { console.error('[relay] going live needs PUBLIC_URL=https://... (TAP-20 requires an https endpoint)'); process.exit(1) }
const SIGNER_KEY = process.env.SIGNER_KEY || sig.randomPrivateKey()

const base = JSON.parse(await readFile(new URL('manifest.json', import.meta.url), 'utf8'))
const manifest = {
  ...base,
  signer: sig.privateKeyToAddress(SIGNER_KEY),
  container: process.env.CONTAINER || base.container,
  circuits: process.env.CIRCUITS || base.circuits,
  tokenId: String(process.env.TOKEN_ID || base.tokenId),
  endpoints: { live: [`${(process.env.PUBLIC_URL || `http://${HOST}:${PORT}`).replace(/\/+$/, '')}/tapeapi/v1`], async: false },
  methods: relayManifestMethods({ priceBEM: PRICE }),
  delegation: PROD ? { expires: Number(process.env.DELEGATION_EXPIRES), sig: process.env.DELEGATION_SIG } : null,
  dev: !PROD,
  // A priced relay names its escrow; in dev with no ESCROW the zero address stands in and paid frames are refused
  // with INTERNAL (reason in the log). A live (PROD) manifest refuses the zero address at boot.
  // 收费中继写明托管；dev 下无 ESCROW 时以零地址占位，付费帧被清楚地拒绝。上线清单在启动时拒绝零地址。
  ...(PRICE !== '0' ? { payment: { escrow: process.env.ESCROW || '0x' + '00'.repeat(20), unit: 'BEM', decimals: 8 } } : {}),
}
const core = createRelayCore()
const provider = createProvider({
  manifest, signerKey: SIGNER_KEY,
  // 2-of-3: one node down still leaves a quorum (arch A5) / 三取二：一个节点宕机仍有法定数
  rpcUrls: (process.env.RPC_URLS || 'https://bsc-rpc.publicnode.com,https://bsc-dataseed.bnbchain.org,https://bsc-dataseed1.defibit.io').split(','),
  quorum: 2, allowSingleNode: !PROD, log: (...a) => console.error('[relay]', ...a),
  store: process.env.METER_FILE ? fileStore(process.env.METER_FILE) : undefined,
  methods: relayMethods(core),
})
setInterval(() => core.sweep(), 30_000).unref()
// startProvider fixes the advertised endpoint when PORT=0 and installs SIGINT/SIGTERM
// startProvider 在 PORT=0 时修正公布的端点，并装好信号处理
await startProvider(provider, { tag: 'relay', PORT, HOST }, { lines: [`price    ${PRICE} BEM/frame`] })
