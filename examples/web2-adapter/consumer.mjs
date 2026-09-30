#!/usr/bin/env node
// Node 消费者：dev 模式解析 provider，调一个免费方法，再用随机 session key 调一个收费方法。
// Node consumer: resolve a provider in dev mode, call a free method, then a paid method with a random session key.
//
//   node examples/web2-adapter/consumer.mjs [http://127.0.0.1:8788]
//   env: FREE_METHOD (default: first free method), PAID_METHOD (default: first paid method), PAID_PARAMS (JSON),
//        CONSUMER (0x address), SESSION_KEY (32-byte hex; must be authorised on-chain via Escrow.authorizeSession for mainnet)
import { createTapeAPI, parseUnits, formatUnits, sig, abi } from '@tapeapi/sdk'

const base = (process.argv[2] || process.env.PROVIDER_URL || 'http://127.0.0.1:8788').replace(/\/+$/, '')
const api = createTapeAPI({ dev: true }) // dev: true 才允许 resolve({ dev }) 与 http 端点；不需要链 RPC / dev: true is required for { dev } targets and http endpoints

// 1. 解析清单 / resolve the manifest
const svc = await api.resolve({ dev: base })
console.log(`provider  ${svc.manifest.name}`)
console.log(`container ${svc.container}   signer ${svc.manifest.signer}   verified ${JSON.stringify(svc.verified)}`)
for (const m of svc.manifest.methods) console.log(`  ${m.name.padEnd(12)} ${m.priceBEM} BEM  params=${JSON.stringify(m.params)}`)

// 2. 免费方法 / free method: the SDK verifies the signed envelope before returning
const freeDef = svc.manifest.methods.find(m => m.name === process.env.FREE_METHOD) || svc.manifest.methods.find(m => parseUnits(m.priceBEM) === 0n)
if (freeDef) {
  console.log(`\n== free call: ${freeDef.name}`)
  try {
    const r = await api.call(svc, freeDef.name, {})
    console.log(`result   ${JSON.stringify(r.result)}`)
    console.log(`verified ${r.verified}   block ${r.block}   ts ${r.ts}   sig ${r.sig.slice(0, 18)}...`)
  } catch (e) { console.log(`error    ${e.code}: ${e.message}${e.signed ? '  (error envelope was signed by the provider)' : ''}`) }
}

// 3. 收费方法 / paid method
const paidDef = svc.manifest.methods.find(m => m.name === process.env.PAID_METHOD) || svc.manifest.methods.find(m => parseUnits(m.priceBEM) > 0n)
if (!paidDef) { console.log('\n(no paid method in manifest; FREE_ALL=1 on the provider?)'); process.exit(0) }
const price = parseUnits(paidDef.priceBEM)
const params = process.env.PAID_PARAMS ? JSON.parse(process.env.PAID_PARAMS) : { amount: 100 }
const sessionKey = process.env.SESSION_KEY || sig.randomPrivateKey()
const consumer = process.env.CONSUMER || sig.privateKeyToAddress(sessionKey) // 无 CONSUMER 时 session key 就是消费者本人 / without CONSUMER the session key *is* the consumer
const payer = api.payer({ consumer, sessionKey })
console.log(`\n== paid call: ${paidDef.name} (${paidDef.priceBEM} BEM)  consumer ${consumer}  voucher signer ${payer.signer}`)

// 手工构造 voucher 并直接 POST，这样无论成功失败都能看到线上传的是什么。
// Build the voucher by hand and POST directly so the wire format is visible whether or not it succeeds.
// （生产代码只需 api.call(svc, method, params, { payer }) / production code just calls api.call(svc, method, params, { payer }).）
const voucher = await payer.voucherFor(svc, price)
console.log('voucher  ' + JSON.stringify(voucher))
const id = crypto.randomUUID()
const res = await fetch(`${svc.manifest.endpoints.live[0]}/${paidDef.name}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, method: paidDef.name, params, voucher }),
})
const env = await res.json()
// TAPI-21 v2：摘要覆盖 {method, params} 与 ok，验签时用自己发出的请求重算 / v2 digest covers the request and ok
const recovered = sig.recoverResponseSigner({ container: svc.container, id, method: paidDef.name, params, ok: env.ok, body: env.ok ? env.result : env.error, ts: env.ts }, env.sig)
const signedByProvider = abi.eqAddr(recovered, svc.manifest.signer)
console.log(`http ${res.status}  envelope signed by ${recovered}  matches manifest.signer: ${signedByProvider}`)
if (env.ok) {
  console.log(`result   ${JSON.stringify(env.result)}`)
  console.log(`paid     cumulative now ${formatUnits(payer.cumulativeOf(svc))} BEM for this provider (provider will settle on-chain later)`)
  console.log(`         (api.call would also resync from a signed BAD_VOUCHER { data: { lastCumulative } } and retry once; voucherFor() commits immediately)`)
} else {
  console.log(`error    ${env.error.code}: ${env.error.message}`)
  if (svc.manifest.dev) {
    console.log(`
  ^ expected in dev mode: the provider checks vouchers against TapeAPIEscrow on-chain (balance, allowance, session key),
    and this manifest points at a placeholder escrow, so the paid path cannot succeed without a chain.
    What was demonstrated: the SDK built a TAPI-22 voucher (cumulative ${voucher.cumulative} wei = ${paidDef.priceBEM} BEM, signed by
    the session key), sent it, and the provider answered with a *signed* error envelope you can verify offline.
  On mainnet the consumer does once: api.tx.fund(${svc.container}, amount),
    api.tx.authorizeSession(${payer.signer}, expires) — then api.call(svc, '${paidDef.name}', params, { payer }) just works.`)
  }
}
