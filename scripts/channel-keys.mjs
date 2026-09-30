#!/usr/bin/env node
// A container's channel identity (TAPI-26 §3.1), in three steps, with the holder's key never leaving the wallet.
// 容器的通道身份（TAPI-26 §3.1），分三步完成，持有人的私钥始终不离开钱包。
//
//   1. node scripts/channel-keys.mjs new --container 0x.. [--identity ./identity.json] [--days 180]
//                                        [--relay https://host/tapeapi/v1@0xRelayContainer] [--bus 0xChannelBus]
//      Generates the X25519 + Ed25519 keys, writes them to --identity (mode 600: THE SECRETS, keep them), and prints
//      the EIP-712 typed data the circuit holder's wallet signs (eth_signTypedData_v4; a Safe signs via EIP-1271).
//      生成密钥并写入 --identity（权限 600，里面是私钥，务必保管），打印持有人钱包要签的 EIP-712 内容。
//   2. Sign it with the wallet that holds the circuit. / 用持有该电路的钱包签名。
//   3. node scripts/channel-keys.mjs record --identity ./identity.json --sig 0x..
//      Prints the record and the putFile transaction that publishes it (sent by the holder or a site operator).
//      打印记录，以及发布它的 putFile 交易（由持有人或站点操作员发送）。
//
// The identity file holds secrets; nothing in the record or the transaction does.
// 身份文件里是私钥；记录与交易里都没有私钥。
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createTapeAPI, sig, channel, MAINNET } from '../sdk/src/index.js'

const [cmd, ...rest] = process.argv.slice(2)
const args = {}
for (let i = 0; i < rest.length; i++) if (rest[i].startsWith('--')) { const k = rest[i].slice(2); (args[k] ??= []).push(rest[i + 1]); i++ }
const one = (k, d) => (args[k] ? args[k][0] : d)
const die = (m) => { console.error(`error: ${m}`); process.exit(1) }
const hex = (b) => '0x' + Buffer.from(b).toString('hex')
const hub = one('hub', MAINNET.hub)
const chainId = Number(one('chain-id', 56))
const identityPath = one('identity', './identity.json')
if (cmd === 'new' && existsSync(identityPath)) die(`${identityPath} already exists: it may hold keys that are already published. Choose another --identity path.`)

if (cmd === 'new') {
  const container = one('container')
  if (!/^0x[0-9a-fA-F]{40}$/.test(container || '')) die('--container 0x.. is required')
  const days = Number(one('days', 180))
  if (!(days >= 1 && days <= 366)) die('--days must be 1..366')
  const relays = (args.relay || []).map((r) => { const [url, c] = r.split('@'); return { url, container: c } })
  const bus = one('bus')
  try { channel.checkRelays(relays); channel.checkBus(bus) } catch (e) { die(e.message) }
  const id = channel.generateIdentity()
  const inbox = { relays, ...(bus ? { bus } : {}) }
  const keys = { container, x25519: hex(id.x25519.publicKey), ed25519: hex(id.ed25519.publicKey), inbox, issued: Math.floor(Date.now() / 1000), expires: Math.floor(Date.now() / 1000) + days * 86400 }
  writeFileSync(identityPath, JSON.stringify({
    warning: 'SECRET KEYS. Anyone holding this file can speak as this container on Tape Channel. / 私钥：持有此文件者可以该容器身份使用 Tape Channel。',
    chainId, hub, ...keys,
    x25519Secret: hex(id.x25519.secretKey), ed25519Secret: hex(id.ed25519.secretKey),
  }, null, 2) + '\n', { mode: 0o600, flag: 'wx' })   // never overwrite existing secrets, never inherit a looser mode / 绝不覆盖已有私钥，也不沿用更宽松的权限
  console.log(JSON.stringify({
    wrote: identityPath,
    signWith: 'eth_signTypedData_v4 (MetaMask, Ledger, ...) or the Safe app for a Safe holder',
    note: 'Sign with the wallet that holds the circuit, then: node scripts/channel-keys.mjs record --identity ' + identityPath + ' --sig 0x<signature>',
    note_zh: '用持有该电路的钱包签名，然后运行上面的 record 命令。签名内容只授权这两把通道公钥，不涉及任何资金。',
    typedData: sig.channelKeysTypedData(chainId, hub, keys),
  }, null, 2))
} else if (cmd === 'record') {
  let id
  try { id = JSON.parse(readFileSync(identityPath, 'utf8')) } catch (e) { die(`cannot read ${identityPath}: ${e.message}`) }
  const signature = one('sig') || (process.env.HOLDER_KEY ? sig.signDigest(sig.channelKeysDigest(id.chainId, id.hub, id), process.env.HOLDER_KEY) : null)   // id carries inbox / id 中含 inbox
  // 65 bytes for a wallet; a contract holder (EIP-1271, e.g. a Safe) may return up to 1024. / 钱包 65 字节；合约持有人最多 1024 字节
  if (!/^0x(?:[0-9a-fA-F]{2}){65,1024}$/.test(signature || '')) die('--sig 0x<signature, 65..1024 bytes> is required (or HOLDER_KEY for tests)')
  let signer = null
  try { signer = sig.recoverAddress(sig.channelKeysDigest(id.chainId, id.hub, id), signature) } catch { /* contract holder / 合约持有人 */ }
  const record = {
    tapechannel: '1', container: id.container, chainId: id.chainId, x25519: id.x25519, ed25519: id.ed25519,
    issued: id.issued, expires: id.expires, sig: signature, inbox: id.inbox,
  }
  const api = createTapeAPI({ chainId: id.chainId, hub: id.hub })
  const { txs, sha256Hash, size } = api.tx.publishChannelKeys({ container: id.container, record })
  console.log(JSON.stringify({
    signer,
    signerNote: signer
      ? 'This must equal ownerOf(circuits, tokenId) of the circuit; clients refuse the record otherwise.'
      : 'No ECDSA signer: valid only if the holder is a contract that accepts it under EIP-1271.',
    record, size, sha256Hash, publish: txs,
    inboxRoom: channel.inboxRoom(id.container, id.chainId),
  }, null, 2))
} else {
  die('usage: channel-keys.mjs new --container 0x.. | record --identity file --sig 0x..')
}
