# new-api relay: the operator's kit / 运营者工具包

[中文](#中文) · [English](#english)

## 中文

这份说明给**已经在运营 new-api** 的中转站：把签名旁路加到你现有的部署旁边、给它一个单独的主机名、每天自动检查一次。
**每一步都是你自己在自己的机器和账号上做**：你的服务器、你的 Cloudflare、你的 GitHub、你的钱包。TapeAPI 不托管旁路、不登录你的
任何账号、不持有你的任何密钥，也不替你值班。

### 两个主机名

```
api.example.com   ──> new-api:3000                 照旧，不变；没有回执
tape.example.com  ──> 旁路 ──> new-api:3000/v1     同一套接口，每个回答带签名回执；写进链上清单的是它（PUBLIC_URL）
```

`api.` 一点都不动：现有用户照旧用它。想要回执的用户把 base URL 换成 `tape.`。两个主机名都由你的反向代理终结 TLS。

### 旁路对 `GET /` 的回答（核实于本仓库的 `server.mjs`）

- 不设 `OPERATOR_SITE_URL`：与以前完全一样。配置齐全时 `GET /`（以及 `HEAD /`、其它未知路径）回答 `404`
  `{"ok":false,"error":{"code":"NOT_FOUND","message":"no such route"}}`；设置模式下回答 `503`（`DELEGATION_INVALID`，说明缺什么）。
- 设了 `OPERATOR_SITE_URL=https://www.example.com`：只有 `GET /` 与 `HEAD /` 回答 `302`，`Location` 就是你填的地址（按 URL 标准写法：只写到域名时末尾补一个 `/`），**从不附加任何参数**
  （包括邀请码），带 `cache-control: no-store` 与 `referrer-policy: no-referrer`；设置模式下也一样。其它路径一概不变。
- 地址必须是 https（http 只限 127.0.0.1 / localhost）、不带查询串/片段/凭据、最多 200 个字符；**不能是 tapeapi.fun**（持有人操作台不是
  你的站点），也不能是旁路自己的 `PUBLIC_URL`。填错时旁路进入设置模式，一句话点名 `OPERATOR_SITE_URL`。
- Worker 版（`examples/ai-proxy/worker.js`）规则相同。

### 档 B：加进你现有的 new-api compose（你的服务器）

文件：`docker-compose.sidecar.yml`（只含旁路这一个服务）、`tapeapi-sidecar.env.example`（旁路的设置，全是占位符）、`add-sidecar.sh`。

```sh
git clone https://github.com/BruceLanLan/tapeapi.git && cd tapeapi/examples/new-api-sidecar
sh add-sidecar.sh --no-build --no-up /path/to/your/new-api   # 只复制三个文件到你的 compose 旁边，已存在的不覆盖
# 编辑 /path/to/your/new-api/tapeapi-sidecar.env（PUBLIC_URL=https://tape.example.com、FORMATS、UPSTREAM_BASE_URL）
# 与 tapeapi-models.json（价目表；可用 pricing-convert.mjs 从 new-api 的价目生成）
sh add-sidecar.sh /path/to/your/new-api                      # 构建镜像、只启动旁路、打印签名地址
```

脚本做的事都写在它开头：复制文件（你的 compose 文件与 `.env` 不动）、`docker build`（镜像由本检出构建）、
`docker compose -f <你的文件> -f docker-compose.sidecar.yml up -d tapeapi-sidecar`（不重启 new-api）、从旁路的 health 读出**地址**。
不想用脚本，照 `docker-compose.sidecar.yml` 开头的五行命令手动做也一样。之后每条 `docker compose` 命令都要带上两个文件，
或者在你的 `.env` 里写 `COMPOSE_FILE=docker-compose.yml:docker-compose.sidecar.yml`。

反向代理只加一个主机名（Caddy 示例；Nginx 要点见 README）：

```
tape.example.com {
    reverse_proxy 127.0.0.1:8080 {
        flush_interval -1
        header_up X-Real-IP {remote_host}
    }
}
```

并在 `tapeapi-sidecar.env` 里设 `CLIENT_IP_HEADER=x-real-ip`。

#### 在服务器上生成的密钥

`docker-compose.sidecar.yml` 设了 `SIGNER_KEY_GENERATE=1` 与 `SIGNER_KEY_FILE=/keys/signer.key`：

- 旁路第一次启动时**在容器内**生成签名密钥，写进卷 `tapeapi-signer`（文件权限 0600，独占创建，从不覆盖已有密钥）；
- 日志、`/tapeapi/v1/health`、`add-sidecar.sh` 的输出里**只有地址**，密钥本身从不打印、不发送；它也不在任何变量里，所以
  `docker compose config` 看不到它；
- 第一次启动后把地址写进 `SIGNER_ADDRESS`：万一卷丢失，旁路会停在设置模式并说明，而不是悄悄生成一把委托里没有的新密钥；
- 删除卷 = 删除密钥：要重新签委托、重新发布清单。

**现状（重要）**：持有人操作台目前只为**它自己在第 3 步生成的**密钥签首次委托（它要求旁路报出的地址等于页面生成的那把）。
为“在服务器上生成的密钥”签首次委托，需要操作台增加一条路径：持有人输入自己终端里打印的地址，操作台核对旁路报出的正是它再签。
这条路径还没有。在它出现之前，请用现有路径：操作台第 3 步生成密钥，存进服务器上的一个文件（权限 600），用 `SIGNER_KEY_FILE`
指向它，不设 `SIGNER_KEY_GENERATE`。续期（第 4 步“续期”）不受影响：它为链上已授权的签名地址重签。

### 档 A：Cloudflare Worker（你的 Cloudflare 账号）

文件：`wrangler.toml`（`main` 指向 `../ai-proxy/worker.js`）。`tape.example.com` 上的 Worker 经 https 调用
`https://api.example.com/v1`（你现有的 new-api）。**先核实**：Worker 能从 Cloudflare 网络访问你的 new-api（防火墙或人机验证可能拒绝它）。

1. 在 GitHub 上 fork 本仓库（你自己的账号）。
2. Cloudflare 后台：Workers & Pages → Create → Import a repository → 你的 fork；构建命令 `npm ci`，部署命令
   `npx --yes wrangler@4.141.0 deploy -c examples/new-api-sidecar/wrangler.toml`。Worker 名须与 `wrangler.toml` 的 `name` 一致。
3. Worker → Settings → Domains & Routes → Custom domain：`tape.example.com`；变量 `PUBLIC_URL`、`FORMATS`、`MODELS_JSON` 等。
4. 持有人操作台第 3–5 步（与 `docs/guides/provide.md` 第 2 节相同）：第 3 步生成的密钥设为机密 `SIGNER_KEY`。
   Worker 没有自己的磁盘，所以“在服务器上生成密钥”不适用于档 A。

**关于“Deploy to Cloudflare”按钮**：按钮会把一个仓库（或其中一个目录）复制成你账号下的新仓库再部署。本 Worker 依赖仓库里的
`../ai-proxy/`、`../cloudflare-worker/` 与 `server/` 工作区，单独复制一个目录跑不起来；按钮需要一个专为它准备的独立仓库，本仓库没有提供。
上面的“导入你的 fork”是已经用过的路径。（按钮的具体行为未在本地核实。）

### 每日检查：跑在你自己的 GitHub 账号里

文件：`templates/tapeapi-daily-check.yml`（工作流模板）、`templates/daily-check.mjs`（检查本身）。

1. 在**你自己的** GitHub 账号里建一个仓库（私有即可），把模板复制成 `.github/workflows/tapeapi-daily-check.yml`。
2. 把你已发布的 `models.json` 与 `models.newapi-source.json`（`pricing-convert.mjs --out` 写出的）提交到仓库根目录。
3. 仓库 Settings → Secrets and variables → Actions → **Variables**：`TAPE_NAME`（你的 TapeOut 名字），可选 `NEW_API_PRICING_URL`
   （`https://<你的 new-api>/api/pricing`）。**不需要任何机密**。
4. 把模板里的 `TAPEAPI_COMMIT` 改成你读过的本仓库提交号（40 位）：检查运行的就是那份代码。

它每天做两件事：按名字跑 `tapeapi-doctor`（2.0 的默认解析，TAP-10 / TAP-11：未激活即失败）；用价目转换器的 `--check` 对照你 new-api 的
公开价目与已发布的价目表。结果：

| 结果 | 何时 | 告警 |
|---|---|---|
| 正常 | 无事可做（价目提示等只列出） | 无；已开的告警 issue 自动关闭 |
| 预警 | 委托或激活 30 天内到期；链上月费 `monthlyFee()` 不再是 0 | 在你的仓库开 issue（或追加评论），GitHub 给你发邮件 |
| 需要处理 | 有检查失败、未激活、14 天内到期、价目漂移 | 同上，且任务变红 |
| 未定 | 读不到链、网络或你的价目 | 不告警，下次再跑 |

激活的到期日与月费取自 doctor `--json` 的结构化字段（`paidUntilSeconds`、`monthlyFeeWei`，SDK 2.2 起）；更早的 doctor 没有这两个字段时，到期日从说明文字里读，月费不检查。
每个问题都附下一条命令（续期、付激活费、重新转换并先发布价目表）。它只读公开数据：**绝不要**给它 `SIGNER_KEY`、new-api 管理员或用户令牌、
钱包密钥。告警只发到你自己的仓库。私有仓库的 Actions 用的是你账号的额度。

### 局限

回执证明谁签了哪些字节、声称了多少用量与价格，**不证明实际运行的是哪个模型**。每日检查只是提醒，规则对所有服务一样，不会为任何一家改变。

## English

For relays that **already run new-api**: add the signing sidecar next to what you have, on a hostname of its own, and
check it every day. **You do every step, on your own machines and accounts**: your server, your Cloudflare, your GitHub,
your wallet. TapeAPI does not host the sidecar, log in to any account of yours, hold any key of yours, or watch your
service for you.

### Two hostnames

```
api.example.com   ──> new-api:3000                     as today, unchanged; no receipts
tape.example.com  ──> sidecar ──> new-api:3000/v1      the same API, a signed receipt per answer; the one in the on-chain manifest (PUBLIC_URL)
```

### What the sidecar answers to `GET /` (checked in this repository's `server.mjs`)

- `OPERATOR_SITE_URL` unset: exactly as before. Configured, `GET /` (and `HEAD /`, and any unknown path) answers `404`
  `{"ok":false,"error":{"code":"NOT_FOUND","message":"no such route"}}`; in setup mode `503` (`DELEGATION_INVALID`, saying
  what is missing).
- `OPERATOR_SITE_URL=https://www.example.com`: `GET /` and `HEAD /` only answer `302` to that address (in the URL standard's form: a bare domain gets a
  trailing `/`), **nothing ever added** (no referral code or any parameter), with `cache-control: no-store` and `referrer-policy: no-referrer`, in setup
  mode too. Every other path is unchanged.
- It must be https (http only for 127.0.0.1 / localhost), with no query, fragment or credentials, at most 200 characters,
  **not tapeapi.fun** (the holder console is not your site) and not the sidecar's own `PUBLIC_URL`. A wrong value is setup
  mode, naming `OPERATOR_SITE_URL`. The Worker (`examples/ai-proxy/worker.js`) follows the same rules.

### Option B: added to your existing new-api compose (your server)

Files: `docker-compose.sidecar.yml` (the sidecar service only), `tapeapi-sidecar.env.example` (its settings,
placeholders only), `add-sidecar.sh`.

```sh
git clone https://github.com/BruceLanLan/tapeapi.git && cd tapeapi/examples/new-api-sidecar
sh add-sidecar.sh --no-build --no-up /path/to/your/new-api   # copies three files next to your compose file, never overwriting
# edit tapeapi-sidecar.env there (PUBLIC_URL=https://tape.example.com, FORMATS, UPSTREAM_BASE_URL) and tapeapi-models.json
sh add-sidecar.sh /path/to/your/new-api                      # builds the image, starts the sidecar alone, prints its address
```

The script's header lists everything it does; your compose file and `.env` are not touched and new-api is not
restarted. Every later `docker compose` command takes both files, or set
`COMPOSE_FILE=docker-compose.yml:docker-compose.sidecar.yml` in your `.env`. Your reverse proxy adds one hostname
(`tape.example.com` → `127.0.0.1:8080`, streaming unbuffered; set `CLIENT_IP_HEADER`).

#### A key made on the server

With `SIGNER_KEY_GENERATE=1` and `SIGNER_KEY_FILE=/keys/signer.key` (set by the fragment), the sidecar makes its signing
key **inside the container** at its first start and keeps it in the volume `tapeapi-signer` (mode 0600, created
exclusively, never overwritten). The log, `/tapeapi/v1/health` and `add-sidecar.sh` show its **address only**; the key is
never printed or sent, and it is in no variable, so `docker compose config` does not show it. After the first start put
the address in `SIGNER_ADDRESS`: a lost volume then stops the sidecar in setup mode instead of making a key the
delegation does not name. Deleting the volume deletes the key (sign a new delegation, publish again).

**Today (important)**: the holder console signs a first delegation only for a key it generated itself in step 3 (it
requires the service to report exactly that key). A first delegation for a key made on the server needs a console path
where the holder types the address their own terminal printed and the console checks the service reports exactly it.
That path does not exist yet. Until it does, use the existing one: generate the key in console step 3, store it in a file
on the server (mode 600), point `SIGNER_KEY_FILE` at it, and leave `SIGNER_KEY_GENERATE` unset. Renewing (step 4,
"renew") is not affected: it re-signs for the signer already authorised on chain.

### Option A: a Cloudflare Worker (your Cloudflare account)

File: `wrangler.toml` (`main` is `../ai-proxy/worker.js`). The Worker on `tape.example.com` calls
`https://api.example.com/v1`, your existing new-api. **Check first** that the Worker can reach your new-api from
Cloudflare's network (a firewall or a bot check may refuse it). Fork this repository in your own GitHub account; in the
Cloudflare dashboard import the fork (Workers & Pages → Create → Import a repository), build command `npm ci`, deploy
command `npx --yes wrangler@4.141.0 deploy -c examples/new-api-sidecar/wrangler.toml` (the Worker's name must match
`name` in that file); add the custom domain `tape.example.com` and the variables; then holder console steps 3 to 5 as in
`docs/guides/provide.md` step 2, the step-3 key as the secret `SIGNER_KEY`. A Worker has no disk of its own, so a key
made on the server does not apply to option A.

**About a "Deploy to Cloudflare" button**: a button copies a repository (or one directory of it) into a new repository
of yours and deploys that. This Worker needs `../ai-proxy/`, `../cloudflare-worker/` and the `server/` workspace of this
repository, so one directory alone does not run; a button needs a repository of its own, which this repository does not
provide. Importing your fork, above, is the path that has been used. (The button's exact behaviour was not checked
locally.)

### A daily check in your own GitHub account

Files: `templates/tapeapi-daily-check.yml` (the workflow template) and `templates/daily-check.mjs` (the check). In a
repository of **your own** (private is fine): copy the template to `.github/workflows/tapeapi-daily-check.yml`; commit
your published `models.json` and `models.newapi-source.json` at its root; set the repository **variables** `TAPE_NAME`
and, optionally, `NEW_API_PRICING_URL` (no secret is needed); put the 40-hex commit of this repository you have read in
`TAPEAPI_COMMIT`.

Every day it runs `tapeapi-doctor` on your name with the default resolution of 2.0 (TAP-10 / TAP-11: an unactivated name
fails) and the price converter's `--check` against your new-api's public price list. The delegation or the activation
ending within 30 days, or an on-chain `monthlyFee()` that is no longer 0, opens an issue in your repository (GitHub emails you); a failed check, no activation, 14 days or
fewer, or a price drift also turns the run red; a run that could not read the chain or your site decides nothing. The activation's end and the fee come from the doctor's structured `--json` fields (`paidUntilSeconds`,
`monthlyFeeWei`, SDK 2.2 on); with an older doctor the end date is read from the detail text and the fee is not checked. Each
problem comes with its next command. It reads public data only: **never** give it your `SIGNER_KEY`, a new-api admin
or user token, or a wallet key. Alerts go to your own repository only; Actions minutes of a private repository come
from your account.

### Limits

A receipt proves who signed which bytes and the usage and price claimed, **not which model ran**. The daily check is a
reminder; the rules are the same for every service and change for none.
