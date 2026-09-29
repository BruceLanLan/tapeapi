# relay-trial — see it work before you pay for anything / 花钱之前先看它跑通

[中文](#中文) · [English](#english)

## 中文

给 AI 中转站运营者的**本地试跑**：不需要 API 密钥、电路、容器，也不花 gas。一条命令在本机启动 new-api 包自己的签名旁路
（[`examples/new-api-sidecar`](../new-api-sidecar/)），放在仓库的**模拟**上游前面（没有真实模型、没有真实密钥，代表你的 new-api、
LiteLLM 或模型服务），用一次性身份（不在链上）和示例价目表：

```sh
git clone https://github.com/BruceLanLan/tapeapi.git && cd tapeapi
npm install --no-audit --no-fund
node examples/relay-trial/trial.mjs            # --lang zh 只看中文；--keep 跑完不退出，可以自己 curl
```

它依次做四件事，每一步都打印结论：

1. **诊断**：`tapeapi-doctor --offline` 检查旁路：清单格式、委托、`ai` 字段、价目表、端点、可访问、CORS、真实请求拿到可核验的回执、
   按 id 取回执。身份项（电路、容器、链上清单）跳过，因为一次性身份不在链上。上线后你对自己的 TapeOut 名字跑的是同一个检查。
2. **像用户的应用那样调用**：经由 SDK 的 `ai.createVerifyingFetch` 发普通、流式与 Anthropic Messages 请求，每份回执都核验，并打印一份签名回执。
3. **经由 `tapeapi-verify`**：你的 Claude Code、Codex 用户在本机运行的核验代理，打印他们看到的那一行结论。
4. **篡改演示**：把签名回答改动一个字节，回执核验拒绝它。

退出码 0 表示全部通过。所有服务只监听 `127.0.0.1` 的空闲端口，结束时关闭。

试跑通过之后，接下来的每一步（购买电路、开通容器、在你自己的服务器上运行旁路、操作台签委托与发布清单）费用与运行都由你自己承担：
**TapeAPI 不托管任何人的旁路，也不代付电路、容器或 gas**。完整清单与每一步的检查命令见
[AI 服务方指南 · 从零到上线](../../docs/guides/zh-CN/ai-providers.md#从零到上线)。

## English

A **local trial** for AI relay operators: no API key, no circuit, no container, no gas. One command starts the new-api
package's own signing sidecar ([`examples/new-api-sidecar`](../new-api-sidecar/)) in front of the repository's **fake**
upstream (no real model, no real key; it stands for your new-api, LiteLLM or model server), with a throwaway identity
(not on chain) and the example price table:

```sh
git clone https://github.com/BruceLanLan/tapeapi.git && cd tapeapi
npm install --no-audit --no-fund
node examples/relay-trial/trial.mjs            # --lang en for English only; --keep leaves it running for your own curl
```

It does four things, printing a verdict for each:

1. **The doctor**: `tapeapi-doctor --offline` checks the sidecar: manifest format, delegation, the `ai` field, the price
   table, the endpoints, reachability, CORS, a real request getting a receipt that verifies, and the receipt lookup. The
   identity checks (circuit, container, manifest on chain) are skipped: a throwaway identity is not on chain. Once you are
   live you run the same check against your TapeOut name.
2. **Calls as your users' apps make them**, through the SDK's `ai.createVerifyingFetch` (plain, streamed, Anthropic
   Messages), every receipt verified, and one signed receipt printed.
3. **Through `tapeapi-verify`**, the local proxy your Claude Code and Codex users run: the verdict line they see.
4. **Tampering**: one byte of a signed answer is changed, and the receipt check refuses it.

Exit status 0 means every step passed. Everything listens on free `127.0.0.1` ports and stops at the end.

After the trial, every next step (buying a circuit, opening its container, running the sidecar on your own server,
signing the delegation and publishing the manifest in the console) is paid for and run by you: **TapeAPI hosts no one's
sidecar and pays for no circuit, container or gas**. The full checklist, with the check for every step, is in
[AI providers · From zero to live](../../docs/guides/ai-providers.md#from-zero-to-live).
