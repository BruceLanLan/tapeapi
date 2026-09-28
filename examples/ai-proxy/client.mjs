#!/usr/bin/env node
// A client of the sidecar that verifies every usage receipt: it resolves the service (here from the local dev
// manifest; in production from the chain), wraps fetch with createVerifyingFetch, and makes one plain and one streamed
// call. With the official `openai` package installed it goes through that SDK; without it, through fetch and a small
// event-stream reader. Nothing is added to package.json.
// 旁路的客户端，核验每一份用量回执：解析服务（这里读本地 dev 清单；生产环境读链），用 createVerifyingFetch 包裹 fetch，
// 各做一次普通调用和流式调用。装了官方 openai 包就经由它；没装就用 fetch 加一个小的事件流读取器。不往 package.json 加任何依赖。
//
//   node examples/ai-proxy/index.mjs &   node examples/ai-proxy/client.mjs   [PROXY_URL=http://127.0.0.1:8798] [API_KEY=sk-demo]
import { createTapeAPI, ai } from '@tapeapi/sdk'

const PROXY_URL = (process.env.PROXY_URL || 'http://127.0.0.1:8798').replace(/\/+$/, '')
const API_KEY = process.env.API_KEY || 'sk-demo'

// Production: createTapeAPI({ rpcUrls }) and api.resolve('<#ID>.<processor>.tape'); the signer then comes from the chain.
// 生产环境：createTapeAPI({ rpcUrls }) 并 api.resolve('<#ID>.<processor>.tape')；signer 来自链上。
const api = createTapeAPI({ dev: true })
const svc = await api.resolve({ dev: PROXY_URL })
const show = (r) => console.log(`[client] receipt ${r.ok ? 'OK ' : 'BAD'} ${r.stream ? 'stream ' : 'json   '} id=${r.receipt?.id} model=${r.receipt?.result.model} ` +
  `usage=${JSON.stringify(r.receipt?.result.usage)} prices=${r.receipt?.result.prices ? r.receipt.result.prices.map((p) => `${p.amount} ${p.currency}`).join(' / ') : 'null'}${r.receipt && !r.receipt.result.complete ? ' INCOMPLETE' : ''}` +
  `${r.problems.length ? `  problems: ${r.problems.join('; ')}` : ''}${r.warnings.length ? `  warnings: ${r.warnings.join('; ')}` : ''}`)
const verifyingFetch = ai.createVerifyingFetch({ api, service: svc, onReport: show })
// One endpoint per API format; an OpenAI SDK takes the openai-chat one. / 每种格式一个端点；OpenAI SDK 用 openai-chat 那个。
const baseURL = svc.manifest[ai.MANIFEST_FIELD].endpoints.find((e) => e.format === 'openai-chat').baseUrl
console.log(`[client] ${svc.manifest.name}: baseURL ${baseURL}, signer ${svc.manifest.signer}`)

let OpenAI = null
try { ({ default: OpenAI } = await import('openai')) } catch { /* not installed: plain fetch below / 未安装：用下面的 fetch */ }

if (OpenAI) {
  const client = new OpenAI({ baseURL, apiKey: API_KEY, fetch: verifyingFetch })
  const c = await client.chat.completions.create({ model: 'demo-chat', messages: [{ role: 'user', content: 'Hello from the OpenAI SDK' }] })
  console.log(`[client] answer: ${c.choices[0].message.content}`)
  const s = await client.chat.completions.create({ model: 'demo-chat', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'Stream this, please' }] })
  let text = ''
  for await (const chunk of s) text += chunk.choices[0]?.delta?.content ?? ''
  console.log(`[client] streamed: ${text}`)
} else {
  const call = (body) => verifyingFetch(`${baseURL}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const c = await (await call({ model: 'demo-chat', messages: [{ role: 'user', content: 'Hello from fetch' }] })).json()
  console.log(`[client] answer: ${c.choices[0].message.content}`)
  const res = await call({ model: 'demo-chat', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'Stream this, please' }] })
  let text = '', buf = ''
  const dec = new TextDecoder()
  for await (const bytes of res.body) {
    buf += dec.decode(bytes, { stream: true })
    let k
    while ((k = buf.indexOf('\n\n')) >= 0) {
      const data = buf.slice(0, k).split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n')
      buf = buf.slice(k + 2)
      if (data && data !== '[DONE]') text += JSON.parse(data).choices[0]?.delta?.content ?? ''
    }
  }
  console.log(`[client] streamed: ${text}`)
}
