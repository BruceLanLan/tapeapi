# Provider directory / 服务方目录

Live at <https://tapeapi.fun/directory/>. / 网页：<https://tapeapi.fun/directory/>。

> **A listing only means the name passed TapeAPI's automated checks (tapeapi-doctor). It is not a recommendation, a
> guarantee or an audit; each provider answers for its own service quality, prices and compliance.**
>
> **只代表通过了 TapeAPI 的自动检查（tapeapi-doctor），不代表推荐、担保或审计；服务质量、价格与合规由服务方自己负责。**

A service needs no listing to work: anyone can resolve it by its TapeOut name, and clients check everything on chain.
The directory only helps people find services, and lets anyone recheck them with one command.

服务的运行不需要登记：任何人都能用 TapeOut 名字解析它，客户端会在链上核对一切。目录只是方便别人找到服务，并让任何人用一条命令复核。

## Rules / 规则

- **No ranking, no fees, no featured places.** The order is fixed by the names themselves: chain, then processor, then
  #ID, all numeric. The format check refuses any other order. Nobody can buy a position.
- **Providers list themselves.** A provider opens a pull request adding its own entry. We list nobody on anyone's behalf
  and pay no one's costs (circuits, containers, gas, servers).
- **An entry is a name and nothing that could be exaggerated:** `name` (the canonical TapeOut name), `added` (a date) and
  an optional `contact` (an https URL). No description, prices, logo or rank. Everything a reader sees is read from the
  chain and the service by `tapeapi-doctor`.
- **Failures are flagged, never removed automatically.** See the flags below.

- **不排名、不收费、不设推荐位。** 顺序由名字本身决定：先按链，再按处理器、#ID，均按数值。格式检查拒绝任何其它顺序，没有人能买到位置。
- **服务方自己登记。** 由服务方提拉取请求加入自己的一条。我们不替任何人上架，也不代付任何费用（电路、容器、gas、服务器）。
- **一条记录只有名字，没有可以夸大的内容：** `name`（规范的 TapeOut 名字）、`added`（日期）、可选的 `contact`（https 地址）。
  没有简介、价格、标志或排名。读者看到的一切都由 `tapeapi-doctor` 从链上和服务本身读出。
- **失败只标记，从不自动删除。** 标记见下文。

## How to be listed / 如何登记

1. Make your service pass the doctor, with exit status 0 (warnings allowed):

   ```sh
   npx -y --package=https://github.com/BruceLanLan/tapeapi/releases/download/v1.3.0/tapeapi-sdk-1.3.0.tgz tapeapi-doctor <your name>
   ```

   The [guide for AI providers](../docs/guides/ai-providers.md#from-zero-to-live) takes you there step by step.
2. Open a pull request that adds one entry to [`site/directory/providers.json`](../site/directory/providers.json), in the
   names' order, and paste the doctor's last line (`result: ... exit 0`) in its description. The
   [service listing form](../.github/ISSUE_TEMPLATE/service_listing.yml) lists the same conditions.

   ```json
   { "name": "42.1013.tape", "added": "2026-10-01", "contact": "https://github.com/<you>" }
   ```

   (`42.1013.tape` is an example name.)
3. CI (`.github/workflows/ci.yml`, job `directory`) runs `node directory/recheck.mjs --validate`: the format and the
   order only, with no network. Merging is not a review of your service.
4. The daily recheck (`.github/workflows/directory-recheck.yml`) runs the doctor on every entry and writes
   `site/directory/status.json`; your entry shows its first result within a day.

1. 先让你的服务通过诊断，退出码为 0（允许警告）：

   ```sh
   npx -y --package=https://github.com/BruceLanLan/tapeapi/releases/download/v1.3.0/tapeapi-sdk-1.3.0.tgz tapeapi-doctor <你的名字>
   ```

   [AI 服务方指南](../docs/guides/zh-CN/ai-providers.md#从零到上线)一步步带你做到这一点。
2. 提一个拉取请求，按名字的顺序在 [`site/directory/providers.json`](../site/directory/providers.json) 里加一条，
   并在描述里贴上诊断的最后一行（`结果：…退出码 0`）。[服务登记表](../.github/ISSUE_TEMPLATE/service_listing.yml)列出了同样的条件。
   上面的 JSON 是格式示例（`42.1013.tape` 是示例名）。
3. CI（`ci.yml` 的 `directory` 任务）运行 `node directory/recheck.mjs --validate`：只查格式与顺序，不联网。合并不代表审核了你的服务。
4. 每日复核（`directory-recheck.yml`）对每一条运行诊断并写入 `site/directory/status.json`；一天之内你的条目就会显示第一次结果。

## Flags / 标记

| Flag | Meaning | 含义 |
|---|---|---|
| `ok` | the doctor exited 0 at the last recheck | 最近一次复核诊断退出码为 0 |
| `failing` | a check failed (exit 1); the failed checks are listed | 有检查失败（退出码 1），列出失败项 |
| `stale` | failing 7 daily rechecks in a row; anyone may then propose its removal in a pull request, with the record | 连续 7 次每日复核失败；此后任何人都可以提拉取请求建议移除，附上复核记录 |
| `undecided` | the chain or the network could not be read (exit 3); yesterday's verdict is kept (`verdict`, `verdictAt`) and a failing or stale flag is not cleared | 读不到链或网络（退出码 3）；保留前一天的结论（`verdict`、`verdictAt`），failing 或 stale 不会被清除 |

## The daily recheck / 每日复核

- Read-only, with no key and no secret: it signs nothing, sends no transaction and spends nothing. The doctor sends each
  endpoint one request with a key that cannot be valid (the sidecar signs the refusal), so it costs providers nothing.
- At most **60 JSON-RPC requests per name** (`RPC_BUDGET_PER_NAME`; a batch counts once), on the SDK's default public
  nodes with quorum 2. Measured on BNB Chain: about 36 for a name that gets through every on-chain check. A name that
  reaches the cap is `undecided`, never `failing`. The doctor's requests to the service itself (health, manifest, CORS
  preflight, one request, one receipt lookup per endpoint) are not RPC and are not counted.
- `site/directory/status.json` is committed back to the repository by `github-actions[bot]`, so the website reads it
  from its own origin. It is not committed while the directory is empty. When a name newly stops passing, the job fails
  so a maintainer sees it.
- Recheck any entry yourself with the same command as step 1.

- 只读，不用任何密钥：不签名、不发交易、不花钱。诊断用一个不可能有效的密钥向每个端点发一次请求（旁路对拒绝同样签回执），服务方也不花钱。
- **每个名字最多 60 次 JSON-RPC 请求**（`RPC_BUDGET_PER_NAME`，批量请求算一次），使用 SDK 默认的公共节点、quorum 2。
  BNB Chain 实测：通过全部链上检查的名字约 36 次。达到上限的名字记为 `undecided`，绝不记为 `failing`。诊断对服务本身的请求
  （健康检查、清单、CORS 预检、每个端点一次请求与一次回执查询）不是 RPC，不计入。
- `site/directory/status.json` 由 `github-actions[bot]` 提交回仓库，网站从自己的站点读取。目录为空时不提交。有名字新近不再通过时
  任务失败，让维护者看到。
- 用第 1 步的同一条命令，你可以自己复核任何一条。

## Files / 文件

| File / 文件 | What / 内容 |
|---|---|
| `site/directory/providers.json` | the list; edited by pull requests / 列表，由拉取请求修改 |
| `site/directory/status.json` | written by the daily recheck, never by hand / 由每日复核生成，不手工编辑 |
| `site/directory/index.html` | the page / 网页 |
| `directory/recheck.mjs` | `--validate` (format, no network) and `--recheck [--write]` (the doctor on every entry) / 格式检查与每日复核 |
| `directory/recheck.test.mjs`, `directory/page.test.mjs` | the tests / 测试 |
