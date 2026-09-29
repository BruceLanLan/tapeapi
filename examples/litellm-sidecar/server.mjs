#!/usr/bin/env node
// The TapeAPI signing sidecar for a team running LiteLLM Proxy: it sits IN FRONT of LiteLLM (client -> sidecar ->
// LiteLLM), passes /v1/* through byte for byte and signs a usage receipt for every Chat, Responses, Anthropic Messages and
// Embeddings answer. It is the new-api package's entry (examples/new-api-sidecar/server.mjs: environment, setup mode,
// price-table checks, the Node HTTP bridge) with LiteLLM's profile: the default upstream http://litellm:4000/v1, and one
// adjustment to how the sidecar reads LiteLLM's Responses streams (litellmFormats below). LiteLLM keeps its model list,
// virtual keys, budgets and spend tracking; your users keep their keys and their SDKs. You run it; nobody else hosts it.
// 给运行 LiteLLM Proxy 的团队用的 TapeAPI 签名旁路：放在 LiteLLM **前面**（客户端 -> 旁路 -> LiteLLM），/v1/* 逐字节透传，为每个
// Chat、Responses、Anthropic Messages、Embeddings 回答签一份用量回执。它就是 new-api 一键包的入口（环境变量、设置模式、价目表检查、
// Node HTTP 桥接），换上 LiteLLM 的配置：默认上游 http://litellm:4000/v1，以及读 LiteLLM Responses 流时的一处调整（见 litellmFormats）。
// LiteLLM 的模型列表、虚拟密钥、预算与花费统计都不变；用户的密钥与 SDK 也不变。旁路由你自己运行，不交给任何第三方托管。
//
// Environment: as examples/new-api-sidecar/server.mjs, except UPSTREAM_BASE_URL (default http://litellm:4000/v1) and
// MODELS_FILE (default models.json next to this file).
// 环境变量：与 examples/new-api-sidecar/server.mjs 相同，只是 UPSTREAM_BASE_URL 默认为 http://litellm:4000/v1，MODELS_FILE 默认为本文件旁的 models.json。
//
//   node examples/litellm-sidecar/server.mjs          (Docker: see docker-compose.yml and README.md)
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ai } from '@tapeapi/sdk'
import { readConfig as readConfigFor, createSidecar as createSidecarFor, startSidecar as startSidecarFor } from '../new-api-sidecar/server.mjs'

export { readModels, clientIpOf, setupAnswer, REQUIRED, CONSOLE_URL } from '../new-api-sidecar/server.mjs'
export const DEFAULT_UPSTREAM = 'http://litellm:4000/v1'
export const DEFAULT_MODELS_FILE = fileURLToPath(new URL('models.json', import.meta.url))

/**
 * ai.FORMATS with one adjustment for LiteLLM's streams (checked against LiteLLM 1.103.0; see README "依据 / Sources").
 * It changes only where the sidecar puts the receipt: the signing, the hashes and every verifier are the SDK's, untouched.
 * OpenAI Responses: LiteLLM frames the events as `data:` lines only (no `event:` line) and ends the stream with
 * `data: [DONE]`, so the adapter's final event (`event: response.completed`, ...) never shows and the receipt would
 * land after [DONE], where a verifying client has already stopped (the verifiers end a Responses stream at [DONE]).
 * `data: [DONE]` is added as a final line, as the Chat adapter has it: the receipt goes right before it.
 * (The Chat usage chunk LiteLLM sends with `choices: [{ index: 0, delta: {} }]` needed a second adjustment until the SDK
 * recognised it itself, FIXED P101-b.)
 * ai.FORMATS 加上针对 LiteLLM 事件流的一处调整（按 LiteLLM 1.103.0 核实），只改变回执放在哪里；签名、哈希与所有核验方都是 SDK 的，
 * 未改动。Responses：LiteLLM 的事件只有 data 行、以 `data: [DONE]` 结束，格式的最终事件从不出现，回执会落在 [DONE] 之后，而核验方
 * 在 [DONE] 处就结束了；因此像 Chat 适配器那样把 `data: [DONE]` 也作为最终事件行，回执放在它之前。（LiteLLM 带
 * `choices: [{ index: 0, delta: {} }]` 的 Chat 用量块，在 SDK 自己认得它之前需要第二处调整，见 FIXED P101-b。）
 * @param {object[]} [formats]
 */
export function litellmFormats(formats = ai.FORMATS) {
  return formats.map((f) => {
    if (f.name === 'openai-responses' && f.stream) {
      const final = f.stream.final ?? {}
      const data = [...new Set([...(final.data ?? []), '[DONE]'])]
      return { ...f, stream: { ...f.stream, final: { ...final, data } } }
    }
    return f
  })
}

export const LITELLM_PROFILE = Object.freeze({ upstreamName: 'LiteLLM', label: 'litellm-sidecar', defaultUpstream: DEFAULT_UPSTREAM, modelsFile: DEFAULT_MODELS_FILE, formats: litellmFormats() })

/** readConfig of the new-api package with LiteLLM's profile. / 用 LiteLLM 配置的 readConfig。 */
export const readConfig = (rawEnv = process.env) => readConfigFor(rawEnv, LITELLM_PROFILE)
/** createSidecar with LiteLLM's profile. / 用 LiteLLM 配置的 createSidecar。 */
export const createSidecar = (env = process.env, o = {}) => createSidecarFor(env, { ...o, profile: LITELLM_PROFILE })
/** startSidecar with LiteLLM's profile. / 用 LiteLLM 配置的 startSidecar。 */
export const startSidecar = (o = {}) => startSidecarFor({ ...o, profile: LITELLM_PROFILE })

// Run as a program (not when imported by the smoke test or the tests). / 作为程序运行时启动（被测试导入时不启动）。
const isMain = (() => { try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) } catch { return false } })()
if (isMain) {
  const s = await startSidecar()
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await s.close(); process.exit(0) })
}
