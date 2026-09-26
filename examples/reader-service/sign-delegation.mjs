#!/usr/bin/env node
// holder 为 signer 出具 EIP-712 委托签名 / Holder signs the EIP-712 Delegation for a provider signer.
// 用法 / usage:
//   Wallet (recommended: the key never leaves it) / 钱包（推荐，私钥不离开钱包）:
//     node sign-delegation.mjs --container 0x.. --signer 0x.. --expires <unix>            # prints the typed data
//     ... sign it with the circuit holder's wallet (MetaMask / Ledger: eth_signTypedData_v4; a Safe: EIP-1271)
//     node sign-delegation.mjs --container 0x.. --signer 0x.. --expires <unix> --sig 0x.. # checks it and prints the env
//   Raw key (CI and tests only) / 裸私钥（仅用于 CI 与测试）:
//     HOLDER_KEY=0x... node sign-delegation.mjs --container 0x.. --signer 0x.. --expires <unix> [--hub 0x..] [--chain-id 56]
//
// EIP-712 域锚定在 **DeWebHub**（verifyingContract = hub），不是 ServiceDirectory：委托只是"持有人授权了
// 这个签名者"，在任何目录部署之前就成立（TAP-20 §3.4）。`--hub` 省略时用主网中枢。
// The EIP-712 domain is anchored on the **DeWebHub** (verifyingContract = hub), never on a ServiceDirectory:
// a delegation is holder consent and holds before any directory exists (TAP-20 §3.4). `--hub` defaults to
// the mainnet hub.
import { sig, abi, MAINNET } from '@tapeapi/sdk'

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => { if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]]); return acc }, []))
const HOLDER_KEY = process.env.HOLDER_KEY || args['holder-key']
const container = args.container || process.env.CONTAINER
const signer = args.signer || process.env.SIGNER
const hub = args.hub || process.env.HUB || MAINNET.hub
const chainId = Number(args['chain-id'] || process.env.CHAIN_ID || 56)
const expires = Number(args.expires || process.env.DELEGATION_EXPIRES || Math.floor(Date.now() / 1000) + 365 * 86400)

const die = (m) => { console.error(`error: ${m}`); process.exit(1) }
for (const [k, v] of Object.entries({ container, signer, hub })) if (!abi.isAddress(v)) die(`--${k} must be a 0x address`)
if (!Number.isInteger(expires) || expires <= Math.floor(Date.now() / 1000)) die('--expires must be a future unix timestamp')

const delegation = { container, signer, expires }
const digest = sig.delegationDigest(chainId, hub, delegation)
const given = args.sig || process.env.DELEGATION_SIG

// 1. No key and no signature: print what the wallet signs / 既没有私钥也没有签名：打印待签内容
if (!HOLDER_KEY && !given) {
  console.log(JSON.stringify({
    signWith: 'eth_signTypedData_v4',
    note: 'Sign this with the wallet that holds the circuit, then re-run with --sig 0x<signature>.',
    note_zh: '用持有该电路的钱包签署，然后用 --sig 0x<签名> 重新运行本脚本。',
    typedData: sig.delegationTypedData(chainId, hub, delegation),
    digest: abi.toHex(digest),
  }, null, 2))
  process.exit(0)
}

// 2. A signature from a wallet, or one made here from a raw key / 钱包签好的签名，或用裸私钥在本地签出
const signature = given || sig.signDigest(digest, HOLDER_KEY)
if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) die('--sig must be a 65-byte hex signature')
let recovered = null
try { recovered = sig.recoverAddress(digest, signature) } catch { /* a contract holder signs no ECDSA / 合约持有人不产生 ECDSA 签名 */ }
if (HOLDER_KEY && recovered !== sig.privateKeyToAddress(HOLDER_KEY)) die('self-check failed')

console.log(JSON.stringify({
  holder: recovered,
  holderNote: recovered
    ? 'Check that this equals ownerOf(circuits, tokenId); a client verifies exactly that.'
    : 'No ECDSA signer recovered: this must be a contract holder (Safe), which clients verify through EIP-1271.',
  chainId, hub, delegation: { ...delegation, sig: signature },
  env: `DELEGATION_EXPIRES=${expires} DELEGATION_SIG=${signature}`,
}, null, 2))
