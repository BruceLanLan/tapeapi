[English](../provide.md) | 中文

# 运行服务

本指南把你的代码，或你已经在运行的 API，变成任何人都能验证的 TapeAPI 服务。内容包括基本概念、本地运行、上线（从手机
或从服务器）、续期和运维。

## 上线服务需要的五样东西

| 东西 | 是什么 | 由谁制作 |
|---|---|---|
| **电路** | 在 TapeOut 处理器上铸造的 NFT。谁持有它，谁就拥有该服务。 | 你，在 [tapeout.net](https://tapeout.net) 上。 |
| **容器** | 电路的 ERC-6551 账户：服务的身份与地址。它必须先**开通**（0.012 BNB），其站点才接受文件。 | 你，在电路页面上。 |
| **签名密钥** | 你的服务器用来为每个回答签名的热钥。它不是你的钱包，也不持有资金。 | 为你生成（控制台）或由你自己生成。 |
| **委托** | 电路持有者的一个 EIP-712 签名：“这把签名密钥代表我的容器发言，直到某个日期”。不涉及资金转移。 | 持有者的钱包。 |
| **清单** | 容器站点中的 `.well-known/tapeapi.json`：端点、方法、价格、签名密钥和委托。 | 由持有者写上链（一笔交易）。 |

容器地址由电路决定，因此清单是你唯一需要重新发布的东西：无论是添加方法、更改端点，还是续期委托。

## 1. 编写服务并在本地运行

`createProvider` 替你处理协议：请求解析、签名信封、错误、限流，以及付费方法的凭证检查和计量。你只需写普通函数：

```js
import { readFile } from 'node:fs/promises'
import { createProvider } from '@tapeapi/server'

const provider = createProvider({
  manifest: JSON.parse(await readFile('manifest.json', 'utf8')),
  signerKey: process.env.SIGNER_KEY,
  rpcUrls: ['https://bsc-dataseed.bnbchain.org', 'https://bsc-dataseed1.defibit.io', 'https://bsc-dataseed1.ninicoin.io'],
  quorum: 2,
  methods: {
    blockNumber: async (_params, ctx) => ({ blockNumber: ctx.block }),
    quote: async ({ symbol }) => {
      if (!/^[A-Z]{2,10}$/.test(symbol)) throw Object.assign(new Error('bad symbol'), { code: 'BAD_REQUEST' })
      return fetch(`https://your.api/quote/${symbol}`).then((r) => r.json())
    },
  },
})
await provider.listen(8787)                     // Node
// 在 Cloudflare Workers 上：export default { fetch: (request) => provider.handleRequest(request) }
```

从一个能运行的示例开始，而不是从空白文件开始：

- [`examples/reader-service/`](../../../examples/reader-service/)：最小的完整服务，附带委托脚本。
- [`examples/web2-adapter/`](../../../examples/web2-adapter/)：一个配置文件就能把现有的 REST 端点变成方法；上游 API
  密钥保存在环境变量中。
- [`examples/cloudflare-worker/`](../../../examples/cloudflare-worker/)：同样的服务运行在 Cloudflare Workers 上，可以
  从手机部署。

没有委托时，服务以开发模式运行：客户端使用 `createTapeAPI({ dev: true })` 连接。用黑盒一致性测试套件对照协议检查它：

```bash
node conformance/run.mjs --url http://127.0.0.1:8787
```

## 2. 从手机上线（Cloudflare + 持有者控制台）

这条路径不需要服务器，也不需要命令行。

1. **电路与容器。** 在 [tapeout.net](https://tapeout.net) 上：创建一个处理器，Tape Out 一个电路，开通其容器
   （0.012 BNB）。容器的 `.tape` 名称本身即可使用，无需绑定名称。
2. **部署服务。** 在 Cloudflare 控制台中：Workers & Pages → Create → Workers → Import a repository → 选择你 fork 的
   本仓库。构建命令 `npm ci`，部署命令 `npm run deploy:provider`。控制台中 Worker 的名称必须与你 fork 里
   `examples/cloudflare-worker/wrangler.toml` 的 `name` 一致（`my-tapeapi-service`；想换名字就两处一起改）。Worker 以设置
   模式启动，只响应健康检查。
3. **给它你自己的主机名。** 端点会写进链上清单，所以请使用你控制的主机名，例如 `api.yourdomain.com`：在控制台中，
   Worker → Settings → Domains & Routes → Add → Custom domain。然后添加变量 `PUBLIC_URL` = `https://<你的主机名>`
   （Settings → Variables and Secrets）。设置之前，设置模式会把 `PUBLIC_URL` 列为缺失。
4. **打开持有者控制台** [tapeapi.fun/console](https://tapeapi.fun/console/)，在钱包的内置浏览器中打开，并用持有该电路
   的钱包连接。把其中服务网址一栏的默认值 `https://api.tapeapi.fun` 换成 `https://<你的主机名>`，然后按控制台的第 4 到
   7 步操作：
   - **4** 读取你的电路，检查你是否为持有者，以及容器是否已开通；
   - **5** 在你的手机上生成签名密钥，并显示需要在 Cloudflare 中添加的变量（`SIGNER_KEY` 作为 secret；其余为公开变量）；
   - **6** 检查服务报告的正是同一把密钥，请求你的钱包签署委托，并检查该签名确实来自持有者；
   - **7** 根据你读取和签署的内容构建清单，要求服务所持副本与之逐字段一致，向你展示清单，并用一笔交易把它写上链。

控制台的这四步请在同一个钱包应用中完成；页面会把进度保存在该浏览器中。**切勿截图签名密钥，也不要把它发送给任何人。**

`npm run deploy:public` 部署的是本项目自己的公共服务（`api.tapeapi.fun`，来自
[`examples/public-api/`](../../../examples/public-api/)），不是给 fork 用的：请用 `npm run deploy:provider`。

## 3. 从服务器上线

1. 生成一把签名密钥，并保存在你的密钥存储中。
2. 让持有者签署委托。私钥永远不需要离开钱包：
   ```bash
   node examples/reader-service/sign-delegation.mjs --container 0x<container> --signer 0x<signing key address> --expires <unix time>
   # sign the printed typed data with the holder's wallet (eth_signTypedData_v4; a Safe signs via EIP-1271), then
   node examples/reader-service/sign-delegation.mjs --container 0x<container> --signer 0x<address> --expires <unix time> --sig 0x<signature>
   ```
   （先用持有者的钱包签署打印出的类型化数据：`eth_signTypedData_v4`；Safe 通过 EIP-1271 签名，然后运行第二条命令。）
3. 通过 HTTPS 运行服务，并设置 `SIGNER_KEY`、`CIRCUITS`、`TOKEN_ID`、`CONTAINER`、`DELEGATION_EXPIRES`、
   `DELEGATION_SIG` 和 `PUBLIC_URL`。上线的清单必须声明一个 `https://` 端点。
4. 发布清单：`api.tx.publishManifest({ container, manifest })` 返回供持有者钱包使用的 `SiteRegistry.putFile` 交易。
   键为 `.well-known/tapeapi.json`，不带前导斜杠。

像任何客户端那样检查它：

```js
const svc = await createTapeAPI({ rpcUrls: [/* ... */], quorum: 2 }).resolve('0x<container>')
```

## 4. 续期

委托默认有效 90 天。到期之前：签署一份新的委托（控制台第 6 步），更新 `DELEGATION_EXPIRES` 和 `DELEGATION_SIG`，
**并重新发布清单**（控制台第 7 步），因为客户端是从链上清单中读取委托的。签名密钥可以保持不变。委托无法撤销：旧委托
在其自身到期之前一直有效，因此一旦签名密钥泄露，请立即轮换并重新发布。

## 5. 付费方法

在方法上设置 `priceBEM`，并在 `payment` 中指定一个托管合约。运行时会验证每张凭证、按消费者计量，并拒绝低于价格的
任何凭证。同一个付费服务的所有端点必须共享同一个原子计量存储（在 Cloudflare 上为 D1，见
[`examples/cloudflare-worker/`](../../../examples/cloudflare-worker/)），否则同一张凭证可能被服务两次。结算者会把凭证
分批提交给托管合约。

> 托管合约尚未在主网上部署。付费方法目前可以针对示例运行。

## 6. 运维

[`docs/OPERATING.md`](../../OPERATING.md) 涵盖密钥、监控、RPC 选择、限流（默认每个 IP 每分钟 600 次免费调用）和中继
容量。有两条规则值得重申：

- 至少使用三个 RPC 节点并设置 `quorum: 2`：一个节点宕机或拒绝某个方法时，仍然能凑够法定人数。
- 签名密钥只保存在服务运行的地方。任何能修改服务代码的人都能读取它。
