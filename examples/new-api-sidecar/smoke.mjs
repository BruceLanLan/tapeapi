#!/usr/bin/env node
// A local run of the new-api package without Docker: the sidecar's own entry (server.mjs) in front of the repository's
// FAKE upstream (examples/ai-proxy/fake-upstream.mjs, standing in for new-api: no real model, no real key), with the
// example price table (models.example.json). It makes Chat (plain and streamed), Responses (streamed), Anthropic
// Messages (streamed) and Embeddings calls the way clients make them, and checks every receipt with the SDK's
// ai.verifyUsageReceipt against the manifest the sidecar serves, over the exact bytes sent and received.
// The identity is a throwaway: a random holder signs a real EIP-712 delegation for a random service key, but nothing is
// on chain, so this checks the receipts, not an on-chain identity.
// 不用 Docker 的本地演练：旁路自己的入口（server.mjs）放在仓库的**模拟**上游前面（fake-upstream.mjs 代替 new-api：没有真实模型、
// 没有真实密钥），用示例价目表。按客户端的方式调用 Chat（普通与流式）、Responses（流式）、Anthropic Messages（流式）与
// Embeddings，并用 SDK 的 ai.verifyUsageReceipt 按旁路提供的清单、确切的收发字节核验每一份回执。身份是一次性的：随机持有人为随机
// 服务密钥签了真实的 EIP-712 委托，但链上什么都没有，所以这里核验的是回执，不是链上身份。
//
//   node examples/new-api-sidecar/smoke.mjs
import { fileURLToPath } from 'node:url'
import { sig, ai } from '@tapeapi/sdk'
import { startFakeUpstream, DEMO_KEY } from '../ai-proxy/fake-upstream.mjs'
import { startSidecar } from './server.mjs'

export const EXAMPLE_MODELS = fileURLToPath(new URL('models.example.json', import.meta.url))
const DEWEB_HUB = '0xe61A9C7213a6Aa616C246a2B569e555B417b25ee'   // BNB Chain DeWebHub: the delegation's EIP-712 domain (TAP-20 §3.4)
const randomAddress = () => sig.privateKeyToAddress(sig.randomPrivateKey())

/** A complete, throwaway identity (no chain): the environment the holder console would give. / 一次性的完整身份（不上链）。 */
export function throwawayIdentity({ days = 90 } = {}) {
  const holderKey = sig.randomPrivateKey(), signerKey = sig.randomPrivateKey()
  const container = randomAddress(), signer = sig.privateKeyToAddress(signerKey)
  const expires = Math.floor(Date.now() / 1000) + days * 86_400
  return {
    CIRCUITS: randomAddress(), TOKEN_ID: '42', CONTAINER: container,
    DELEGATION_EXPIRES: String(expires),
    DELEGATION_SIG: sig.signDigest(sig.delegationDigest(56, DEWEB_HUB, { container, signer, expires }), holderKey),
    SIGNER_KEY: signerKey,
  }
}

/** Start the fake upstream and the sidecar in front of it. / 启动模拟上游，并在它前面启动旁路。 */
export async function startStack({ env = {}, quiet = true } = {}) {
  const fake = await startFakeUpstream()
  let sidecar
  try {
    sidecar = await startSidecar({
      env: { ...throwawayIdentity(), UPSTREAM_BASE_URL: fake.baseUrl, MODELS_FILE: EXAMPLE_MODELS, SERVICE_NAME: 'Smoke relay', ...env },
      port: 0, host: '127.0.0.1', quiet, localPublicUrl: true, log: () => {},
    })
  } catch (e) { await fake.close(); throw e }
  if (!sidecar.state.ok) { await sidecar.close(); await fake.close(); throw new Error(`the sidecar is in setup mode: ${sidecar.state.problem || sidecar.state.missing.join(', ')}`) }
  const manifest = await (await fetch(`${sidecar.url}/.well-known/tapeapi.json`)).json()
  return { fake, sidecar, manifest, close: async () => { await sidecar.close(); await fake.close() } }
}

/**
 * One call as a client makes it, then the receipt checked against the manifest over the exact bytes.
 * 按客户端的方式调用一次，再按确切字节对照清单核验回执。
 */
export async function callAndVerify({ manifest, format, path, body, headers = {} }) {
  const base = manifest[ai.MANIFEST_FIELD].endpoints.find((e) => e.format === format).baseUrl
  const url = base.replace(/\/v1$/, '') + path   // the service root + the format's path / 服务根 + 格式的路径
  const requestBytes = new TextEncoder().encode(JSON.stringify(body))
  const auth = format === 'anthropic-messages' ? { 'x-api-key': DEMO_KEY, 'anthropic-version': '2023-06-01' } : { authorization: `Bearer ${DEMO_KEY}` }
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...auth, ...headers }, body: requestBytes })
  const responseBytes = new Uint8Array(await res.arrayBuffer())
  const stream = (res.headers.get('content-type') || '').includes('text/event-stream')
  const header = res.headers.get(ai.RECEIPT_HEADER)
  const envelope = header ? ai.decodeReceiptHeader(header) : stream ? ai.readSseReceipt(responseBytes) : null
  const verdict = ai.verifyUsageReceipt({ envelope, manifest, requestBytes, responseBytes, path, status: res.status, stream, maxSkewS: 300 })
  return { res, stream, envelope, verdict, responseBytes }
}

export const CALLS = [
  { label: 'OpenAI Chat', format: 'openai-chat', path: '/v1/chat/completions', body: { model: 'gpt-5-mini', messages: [{ role: 'user', content: 'Hello through the sidecar' }] } },
  { label: 'OpenAI Chat, streamed', format: 'openai-chat', path: '/v1/chat/completions', body: { model: 'deepseek-chat', stream: true, messages: [{ role: 'user', content: 'Stream this please' }] } },
  { label: 'OpenAI Responses, streamed', format: 'openai-responses', path: '/v1/responses', body: { model: 'gpt-5-mini', stream: true, input: 'What does the receipt prove' } },
  { label: 'Anthropic Messages, streamed', format: 'anthropic-messages', path: '/v1/messages', body: { model: 'claude-sonnet-4-5-20250929', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'Hi from Claude Code' }] } },
  { label: 'OpenAI Embeddings', format: 'openai-embeddings', path: '/v1/embeddings', body: { model: 'text-embedding-3-small', input: 'tape out' } },
]

async function main() {
  const stack = await startStack({ quiet: false })
  let failed = 0
  try {
    console.log(`[smoke] sidecar ${stack.sidecar.url} -> fake upstream ${stack.fake.baseUrl} (standing in for new-api); signer ${stack.manifest.signer}`)
    for (const c of CALLS) {
      const { res, stream, envelope, verdict } = await callAndVerify({ manifest: stack.manifest, ...c })
      const r = envelope?.result
      const priced = r?.prices ? r.prices.map((p) => `${p.amount} ${p.currency}`).join(' / ') : 'unpriced'
      const good = res.status === 200 && verdict.ok && !!r?.prices && r.complete === true
      if (!good) failed++
      console.log(`[smoke] ${good ? 'OK  ' : 'FAIL'} ${c.label.padEnd(29)} HTTP ${res.status} ${stream ? 'stream' : 'json  '} model=${r?.model} by=${r?.modelMatchedBy} ` +
        `tokens=${r?.usage ? `${r.usage.prompt_tokens}+${r.usage.completion_tokens}` : '-'} ${priced}${r?.usageInjected ? ' (usage injected)' : ''}` +
        `${verdict.problems.length ? `  problems: ${verdict.problems.join('; ')}` : ''}`)
    }
    // The receipt method: the same signed receipt, fetched by the answer's id. / receipt 方法：按回答 id 取回同一份签名回执。
    const first = await callAndVerify({ manifest: stack.manifest, ...CALLS[0] })
    const got = await (await fetch(`${stack.sidecar.url}/tapeapi/v1/${ai.RECEIPT_METHOD}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'smoke', params: { id: first.envelope.id } }) })).json()
    const same = got.ok && got.result?.sig === first.envelope.sig
    if (!same) failed++
    console.log(`[smoke] ${same ? 'OK  ' : 'FAIL'} receipt by id ${first.envelope.id}`)
  } finally { await stack.close() }
  console.log(failed ? `[smoke] ${failed} check(s) FAILED` : '[smoke] every receipt verified')
  process.exit(failed ? 1 : 0)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main()
