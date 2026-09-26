#!/usr/bin/env node
// 玩家客户端：用钱包私钥签分数与存档，通过 SDK 调用（SDK 校验 provider 信封签名）。
// Player client: sign a score and a save with the wallet key, call via the SDK (which verifies the provider's envelope).
//
//   node examples/gaming-leaderboard/player.mjs [http://127.0.0.1:8790] [score]
//   env: PLAYER_KEY (32-byte hex; random if unset), SESSION_KEY (for the paid saveState), CONSUMER
//   --print-only: 只打印可直接 curl 的 submitScore 请求体 / just print a curl-ready submitScore body
import { createTapeAPI, parseUnits, sig } from '@tapeapi/sdk'
import { signScore, signState } from './score-sig.mjs'

const args = process.argv.slice(2).filter(a => !a.startsWith('--'))
const printOnly = process.argv.includes('--print-only')
const base = (args[0] || process.env.PROVIDER_URL || 'http://127.0.0.1:8790').replace(/\/+$/, '')
const score = Number(args[1] ?? Math.floor(Math.random() * 10000))
const PLAYER_KEY = process.env.PLAYER_KEY || sig.randomPrivateKey()
const player = sig.privateKeyToAddress(PLAYER_KEY)
const nonce = Date.now()

const scoreBody = { id: crypto.randomUUID(), params: { player, score, nonce, sig: signScore({ player, score, nonce }, PLAYER_KEY) } }
if (printOnly) {
  console.log(`# player ${player}${process.env.PLAYER_KEY ? '' : '  (ephemeral key; set PLAYER_KEY to reuse an identity — the key is not printed)'}`)
  console.log(`curl -s -X POST ${base}/tapeapi/v1/submitScore -H 'content-type: application/json' -d '${JSON.stringify(scoreBody)}'`)
  process.exit(0)
}

const api = createTapeAPI({ dev: true })
const svc = await api.resolve({ dev: base })
console.log(`provider ${svc.manifest.name}   container ${svc.container}   signer ${svc.manifest.signer}`)
console.log(`player   ${player}${process.env.PLAYER_KEY ? '' : '   (ephemeral key; set PLAYER_KEY to reuse an identity)'}`)

// 1. 提交分数（免费）/ submit score (free)
const r1 = await api.call(svc, 'submitScore', scoreBody.params, { id: scoreBody.id })
console.log(`submitScore(${score}) -> ${JSON.stringify(r1.result)}   verified=${r1.verified}`)

// 2. 排行榜 / leaderboard
const r2 = await api.call(svc, 'top', { n: 5 })
console.log(`top(5) -> ${JSON.stringify(r2.result)}`)

// 3. 存档（收费 0.0001 BEM；dev 下需要 provider 加 FREE_ALL=1，否则会收到签名的错误信封）
//    save state (paid; in dev start the provider with FREE_ALL=1, otherwise you get a signed error envelope)
const state = { level: 3, hp: 72, inventory: ['sword', 'potion'], checkpoint: 'cave-2' }
const def = svc.manifest.methods.find(m => m.name === 'saveState')
const opts = {}
if (parseUnits(def.priceBEM) > 0n) {
  const sessionKey = process.env.SESSION_KEY || sig.randomPrivateKey()
  opts.payer = api.payer({ consumer: process.env.CONSUMER || sig.privateKeyToAddress(sessionKey), sessionKey })
}
try {
  const n2 = Date.now()
  const r3 = await api.call(svc, 'saveState', { player, state, nonce: n2, sig: signState({ player, state, nonce: n2 }, PLAYER_KEY) }, opts)
  console.log(`saveState -> ${JSON.stringify(r3.result)}`)
} catch (e) { console.log(`saveState -> ${e.code}: ${e.message}${e.signed ? '  (signed error envelope; paid path needs a chain, see README)' : ''}`) }

// 4. 读档（免费）/ load state (free)
const r4 = await api.call(svc, 'loadState', { player })
console.log(`loadState -> ${JSON.stringify(r4.result)}`)
