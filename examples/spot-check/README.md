# TapeAPI 抽检探针 / spot-check probe

[中文](#中文) · [English](#english)

## 中文

### 这是什么

TapeAPI 的 AI 服务方在每次调用上签发**用量回执**（TAP-21 §3.5）：谁回答的、回答了哪些确切的字节、声称用了多少 token、收了多少钱。回执**不证明实际跑的是哪个模型**：`model` 只是上游自己报的名字。

抽检探针补上这一块。任何人都可以用它向服务方发送一组**固定的、带版本的测试请求**，逐张核验回执，然后把原始数据写成 JSON 行：

- 问了什么；
- 答了什么；
- 签名回执本身，以及核验结果；
- 各项测量值。

测量值中最有用的一项是：服务方上报的 `prompt_tokens`，与各开源分词器在本地算出的数目并列。

**它只公开原始数据，不下结论。** 记录里没有"结论"字段，报告里没有评分和排名。TapeAPI 不做信任机构。数字意味着什么，由读者判断，服务方也可以回应。

每个数字都附在服务方签过名的回执上，服务方事后无法否认自己报过这个数。这就是 TAP-21 所说的"替换可以追责"：签名让掺水留下证据，但并不让掺水变得不可能。

### 怎么运行

```bash
# 真实服务（按 TapeOut 名字在链上解析，核对委托）
export MY_KEY=...                      # 你在该服务方的 API 密钥
node examples/spot-check/probe.mjs 11.1013.tape --model <模型 id> --api-key-env MY_KEY --out results.jsonl
node examples/spot-check/report.mjs results.jsonl            # 或加 --markdown

# 本地试跑（仓库里的模拟上游 + 签名旁路，不花钱）
node examples/ai-proxy/index.mjs &
DEMO=sk-demo node examples/spot-check/probe.mjs --dev http://127.0.0.1:8798 --model demo-chat --api-key-env DEMO
```

常用选项：

| 选项 | 作用 |
|---|---|
| `--format` | 选择接口格式：`openai-chat`、`openai-responses` 或 `anthropic-messages` |
| `--runs N` | 整组重复 N 次 |
| `--only id,id` | 只跑指定的探测 |
| `--answers truncate:300\|full\|hash` | 回答文本保留多少；sha256 总是记录 |
| `--chat-max-field max_completion_tokens` | 有些模型不接受 `max_tokens`，用这个改字段名 |
| `--delay-ms` | 两次请求之间的间隔 |
| `--rpc` | 指定 BSC 节点 |

密钥只从你指定的**环境变量名**读取（`--api-key-env NAME`），只发往服务方自己的端点。它从不打印、从不写入文件。回答里如果回显了密钥，记录里替换为 `[redacted]`，并标 `redacted: true`。

`--dev` 只用于测试：这种模式不在链上核对身份，记录里会标 `service.dev: true`。

### 各探测测什么（probes.json，版本 `2026-09-28.1`）

| id | 测什么 | 能说明什么 | 不能说明什么 |
|---|---|---|---|
| `tok-base` 与 `tok-en` `tok-zh` `tok-digits` `tok-code` `tok-mixed` | 上报的 `prompt_tokens`。五段文本（英文、中文、长数字、代码、日韩希腊文加 emoji）各接在同一句指令前面 | 分词器家族。报告列出"上报 − 本地计数"及其跨探测的波动（spread），以及"相对 tok-base 的上报差 − 本地差"。后者抵消了聊天模板、隐藏系统提示等固定开销 | 同一家族内的具体型号、参数量、是否量化 |
| `known-arith` `known-letters` | 已知答案：五位数乘四位数；数字母 | 能力层级的粗略信号 | 单次答对或答错说明不了什么；看多轮 |
| `cutoff-self` | 模型自称的知识截止时间 | 原样记录 | 模型常常说错，系统提示也能改 |
| `self-id` | 模型自称是谁 | 原样记录 | 不可靠：系统提示可以改写，蒸馏模型会沿用老师的名字 |
| `logprobs` | 是否返回对数概率，以及返回的前几个 token | 若缓存了分词器文件，会检查每个 token 是否在各家族词表中。某个 token 不在某家族词表里，它就不可能出自该家族 | Anthropic 接口没有对数概率 |
| `stream-count` | 流式回答：首字节时间、总时间、每秒输出 token 数，以及预期序列是否出现 | 服务的硬件与负载情况 | 模型身份：延迟可以人为加，也受网络影响 |
| `refusal-style` | 一个合法但有时会被拒绝的请求（开锁爱好者技巧）：开头怎么答、以什么原因停止 | 原样记录 | 系统提示很容易改变它 |

**没有收录的信号，以及原因：**

- **上下文长度极限探测**：一次要十几万 token，太贵。
- **Anthropic `count_tokens`**：不经过签名，没有回执。
- **按输出分布做统计检验**（MMD 等）：需要可信的参照样本和大量请求。

### 分词器支持（tokenizers.mjs）

仓库里没有放任何词表文件（每个 2 MB 到 20 MB）。`probes.json` 自带这些固定文本在各家族下的预期计数，所以探针运行时**不需要下载**。

想自己核对这些数，可以这样做：

```bash
node examples/spot-check/tokenizers.mjs list
node examples/spot-check/tokenizers.mjs download all     # 从钉死提交的地址下载，核对 sha256，存到 ~/.cache/tapeapi/tokenizers
node examples/spot-check/tokenizers.mjs check            # 重算 probes.json 的预期计数
```

也可以用 `--cache <dir>` 或环境变量 `TAPEAPI_TOKENIZER_CACHE` 指定缓存目录。

| 家族 | 文件 | 对应模型 |
|---|---|---|
| `o200k` | tiktoken o200k_base | GPT-4o、GPT-4.1、GPT-5、o 系列；gpt-oss 与之同秩 |
| `cl100k` | tiktoken cl100k_base | GPT-4、GPT-3.5 Turbo |
| `kimi-k2` | Kimi-K2 tiktoken.model | Kimi K2 |
| `llama3` | Llama 3 tokenizer.json（公开副本） | Llama 3 / 3.1 / 3.2 / 3.3 |
| `qwen2` | Qwen2.5 tokenizer.json | Qwen2.5、Qwen3（已比对完全相同） |
| `deepseek-v3` | DeepSeek-V3 tokenizer.json | DeepSeek-V3、V3.1（已比对完全相同） |
| `glm4.5` | GLM-4.5 tokenizer.json | GLM-4.5 |
| `mistral-tekken` | Mistral-Nemo tokenizer.json | Mistral NeMo |

引擎用纯 JavaScript 实现两种格式，不依赖任何 npm 包：

- tiktoken 秩文件；
- Hugging Face 字节级 BPE。

遇到不认识的组件时直接报错，不做近似。2026-09-28 与 Python 参考实现（`tiktoken` 0.14、`tokenizers` 0.22）逐个 token id 比对：8 个家族、629 段文本（每个家族约 6 万到 7 万 token，含全部探测文本）全部一致。

**离线无法计数的：**

- **Claude**：分词器未公开。据公开报道（未核实），Opus 4.7 起换了新分词器，同一文本多出约 0–35% 的 token。
- **Gemini**：分词器未以文件形式公开。Gemma 3 的技术报告称与 Gemini 2.0 相同，但它是 SentencePiece 格式，本引擎没有实现。

这两类服务的上报数仍然会记录，只是报告里没有本地对照行。

### 伦理与费用

- 只抽检你**有权使用**的服务，遵守它的使用条款。本工具不提供、也不帮助规避任何封禁或地区限制。
- 在真实服务上，每次调用都按服务方的价格计费。`--runs 1` 大约是十来个短请求。
- 公开时发**原始记录**（JSONL），不要只发截图或摘要。写明探测集版本、时间、格式与模型 id。
- **给服务方回应的机会**：先把数据发给对方，并附上他们的回应。不同时间、不同网络的结果会有差异。
- `refusal-style` 只问合法的爱好类问题。不要往探测集里加有害请求。

### 与 TapeAPI 回执的关系

每条记录都带着服务方签名的完整回执信封，以及 `ai.verifyUsageReceipt` 按确切收发字节核验的结果。

- `receipt.params.requestSha256` 等于记录里请求体的 sha256。
- `receipt.result.usage` 就是测量用的 usage。

所以任何人拿到记录，都可以验证两件事：

1. 这个 `prompt_tokens` 是该服务签名报出的；
2. 签名的服务在链上的身份是谁。

核验不通过的回执同样如实记录，连同问题列表一起。

致谢：TapeAPI 的点子来自 [@Theairresearch](https://x.com/Theairresearch)。

## English

### What it is

A TapeAPI AI service signs a **usage receipt** for every call (TAP-21 §3.5). The receipt states:

- who answered;
- exactly which bytes were answered;
- what usage was claimed, and what price.

A receipt **does not prove which model ran**: `model` is only the name the upstream reported.

The spot-check probe covers that gap. Anyone can use it to send a **fixed, versioned probe set** to a service, verify every receipt, and write the raw data as JSON lines:

- the request;
- the answer;
- the signed receipt and its verification result;
- the measurements.

The most useful measurement is the service's reported `prompt_tokens`, placed next to the counts that open tokenizers give locally.

**It publishes raw data only, never verdicts.** Records have no verdict field; the report has no score and no ranking. TapeAPI is not a trust authority. Readers decide what the numbers mean, and providers can respond.

Every number sits on a receipt the service signed, so the service cannot later deny having reported it. This is what TAP-21 means by making substitution attributable: signatures turn a substitution into evidence, but they do not make substitution impossible.

### How to run

```bash
export MY_KEY=...   # your API key for that service
node examples/spot-check/probe.mjs 11.1013.tape --model <model id> --api-key-env MY_KEY --out results.jsonl
node examples/spot-check/report.mjs results.jsonl [--markdown]
# local dry run against the in-repo fake upstream behind the signing sidecar (free):
node examples/ai-proxy/index.mjs &
DEMO=sk-demo node examples/spot-check/probe.mjs --dev http://127.0.0.1:8798 --model demo-chat --api-key-env DEMO
```

Common options:

| Option | What it does |
|---|---|
| `--format` | The API format: `openai-chat`, `openai-responses` or `anthropic-messages` |
| `--runs N` | Repeat the whole set N times |
| `--only id,id` | Run only these probes |
| `--answers truncate:300\|full\|hash` | How much answer text to keep; the sha256 is always recorded |
| `--chat-max-field max_completion_tokens` | Rename the field for models that reject `max_tokens` |
| `--delay-ms` | Pause between requests |
| `--rpc` | BSC nodes to use |

The key is read from the environment variable you **name** (`--api-key-env NAME`) and is sent only to the service's own endpoint. It is never printed or written. If an answer echoes it, the record carries `[redacted]` instead, with `redacted: true`.

`--dev` is for testing only: it does not check the identity on chain, and records carry `service.dev: true`.

### What each probe measures (probes.json, version `2026-09-28.1`)

| id | Measures | Can show | Cannot show |
|---|---|---|---|
| `tok-base`, `tok-en`, `tok-zh`, `tok-digits`, `tok-code`, `tok-mixed` | Reported `prompt_tokens` for five texts (English, Chinese, long digit runs, code, Japanese/Korean/Greek/emoji), each placed before the same instruction | The tokenizer family. The report gives "reported − local" per family with its spread across probes, and "reported delta − local delta" against `tok-base`. The second cancels fixed overhead such as the chat template or a hidden system prompt | The exact model within a family, its size, or whether it is quantised |
| `known-arith`, `known-letters` | Known answers: a 5×4-digit product, and a letter count | A rough capability tier | Little from a single answer; look across runs |
| `cutoff-self` | The self-reported knowledge cutoff | Recorded as stated | Models misstate it, and a system prompt can change it |
| `self-id` | Self-identification | Recorded as stated | Unreliable: system prompts override it, and distilled models repeat their teacher's name |
| `logprobs` | Whether log probabilities are returned, and the first tokens | With cached tokenizer files, whether each returned token is in each family's vocabulary. A token missing from a family's vocabulary cannot come from that family | Anthropic's API has no log probabilities |
| `stream-count` | Streamed answer: time to first byte, total time, output tokens/s, and whether the expected sequence appears | The provider's hardware and load | Model identity: delay can be added, and the network affects it |
| `refusal-style` | A lawful, sometimes-declined request (a locksport technique): how the answer opens and why it stops | Recorded as stated | A system prompt changes it easily |

**Signals left out, and why:**

- **Context-length limit probes**: one call costs 100k+ tokens.
- **Anthropic `count_tokens`**: it is unsigned, so there is no receipt.
- **Distribution tests** (MMD and similar): they need trusted reference samples and many requests.

### Tokenizer support (tokenizers.mjs)

No vocabulary file is in the repository (they are 2 MB to 20 MB each). `probes.json` ships the expected counts of its fixed texts, so the probe needs **no download** at run time.

To recompute those counts yourself:

```bash
node examples/spot-check/tokenizers.mjs list
node examples/spot-check/tokenizers.mjs download all   # commit-pinned URLs, sha256 checked, into ~/.cache/tapeapi/tokenizers
node examples/spot-check/tokenizers.mjs check          # recompute probes.json's expected counts
```

You can set the cache directory with `--cache <dir>` or the `TAPEAPI_TOKENIZER_CACHE` environment variable.

| Family | File | Models |
|---|---|---|
| `o200k` | tiktoken o200k_base | GPT-4o, GPT-4.1, GPT-5, o-series; gpt-oss uses the same ranks |
| `cl100k` | tiktoken cl100k_base | GPT-4, GPT-3.5 Turbo |
| `kimi-k2` | Kimi-K2 tiktoken.model | Kimi K2 |
| `llama3` | Llama 3 tokenizer.json (ungated copy) | Llama 3 / 3.1 / 3.2 / 3.3 |
| `qwen2` | Qwen2.5 tokenizer.json | Qwen2.5, Qwen3 (compared: identical) |
| `deepseek-v3` | DeepSeek-V3 tokenizer.json | DeepSeek-V3, V3.1 (compared: identical) |
| `glm4.5` | GLM-4.5 tokenizer.json | GLM-4.5 |
| `mistral-tekken` | Mistral-Nemo tokenizer.json | Mistral NeMo |

The engine implements two formats in plain JavaScript, with no npm dependency:

- tiktoken rank files;
- Hugging Face byte-level BPE.

It refuses any component it does not implement exactly, rather than approximating. On 2026-09-28 it was compared token id by token id with the Python references (`tiktoken` 0.14, `tokenizers` 0.22): all 8 families matched on 629 texts (about 60k to 70k tokens per family, the probe texts included).

**Not countable offline:**

- **Claude**: the tokenizer is unpublished. Reports say (unverified here) that Opus 4.7 and later use a new tokenizer that yields roughly 0–35% more tokens for the same text.
- **Gemini**: the tokenizer is not published as a file. The Gemma 3 report says Gemma 3 shares Gemini 2.0's tokenizer, but it is a SentencePiece model, which this engine does not implement.

Reported counts for these services are still recorded; the report simply has no local row for them.

### Ethics and cost

- Probe only services you are **allowed to use**, under their terms. This tool neither offers nor helps with getting around any ban or regional restriction.
- On a real provider every call is billed at the service's price. `--runs 1` is about a dozen short requests.
- Publish the **raw records** (JSONL), not only screenshots or summaries. State the probe-set version, the time, the format and the model id.
- **Let providers respond**: send them the data first, and publish their answer alongside it. Results differ with time and network.
- `refusal-style` asks a lawful hobby question. Do not add harmful requests to a probe set.

### How results relate to TapeAPI receipts

Each record carries the full signed receipt envelope and the result of `ai.verifyUsageReceipt` over the exact bytes sent and received.

- `receipt.params.requestSha256` equals the sha256 of the recorded request body.
- `receipt.result.usage` is the usage that was measured.

So anyone holding a record can check two things:

1. that this `prompt_tokens` was reported under the service's signature;
2. which on-chain identity signed it.

Receipts that do not verify are recorded too, with their list of problems.

Credit: the idea behind TapeAPI came from [@Theairresearch](https://x.com/Theairresearch).
