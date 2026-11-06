# @tapeapi/passport

**Experimental: a read-only resolver for Agent Passports, following an open draft.** A passport links an ERC-8004 agent
identity (the identity registry deployed on BNB Smart Chain) to a TapeOut circuit whose container hosts the agent's
service: it holds when one wallet, the holder, owns both tokens, the identity carries the key `tap.passport` naming the
circuit, the container's site holds a registration file listing exactly that identity, no site operator left by an
earlier holder is active, and the registry's agent wallet equals the holder. This package reads the chain (then the
site files) at one pinned block under strict agreement and reports one state word (CONFIRMED, BROKEN, AMBIGUOUS,
wallet-unset, stale-agent-wallet, UNAVAILABLE) with one named reason and every warning.

It interoperates by reading ERC-8004's deployed public registry. It is not an extension of ERC-8004 and is not endorsed
by its authors or by anyone operating those registries.

This package is **outside any compatibility promise**: it may change or go away in any release. Boundaries, stated as
they are on 2026-10-28:

- **The draft is an open pull request**: TapeOutProtocol/TAPs [#83](https://github.com/TapeOutProtocol/TAPs/pull/83) at
  head `cae25e6df54ad2e2e38e185304de55f92792966d`, not merged (submitted, in review). Its text and its vectors can change; every result carries
  the head it was resolved under (`result.draft`), and this version's tests replay the draft's 147 vectors at SHA-256
  `7720772c05d60062f48daa7c1d2ab6f45affc3d05425126d9de9b00a4ff8fca4`. When the head moves, the vectors are re-run and a
  new version follows; nothing here claims conformance to any later text. The draft has been updated since: its head is
  now `cbf4e03`. This package implements the text at `cae25e6`, every result carries the head it was read against, and a
  package that follows the new text is planned.
- **Nothing on mainnet is known to resolve to CONFIRMED yet.** The two real reads among the vectors (agent #1, circuit
  #4246@0) are BROKEN, and the draft author's own small mainnet run has not been done; until then a CONFIRMED result has
  been seen on synthetic chains and fakes only.
- **The registries are upgradeable.** Both ERC-8004 registries are UUPS proxies; their owner, read on 2026-10-28, is a
  proxy that answers `getThreshold()` 3 with five `getOwners()`, i.e. shaped like a 3-of-5 Safe. The accepted
  implementations are pinned: after an upgrade every result is UNAVAILABLE (`registry-changed`) until a new version
  accepts the new implementation.
- **Gifted identities and circuits are real.** Anyone can register an identity with any URI and metadata and transfer it
  to any wallet without consent. P-9, P-10 and P-11 keep such tokens from resolving as a passport; this package never
  lists identities by owner. Other tools that do will still show the stranger's text next to the victim's address.
- **Site operators and holder epochs need log history.** P-8 and §7 read `eth_getLogs`, which public nodes refuse over
  long ranges. Without log-capable nodes (the default) both are warnings, `operators-not-checked` and
  `transfer-history-unavailable`, and a CONFIRMED result says "site operators not checked; holder history not checked".
  An unobtainable history is never treated as an empty one.
- **EIP-712-only wallets.** A holder whose wallet signs typed data only can set its agent wallet (`setAgentWallet` is
  EIP-712) but cannot derive a TapeSend sealed inbox (that needs `personal_sign`); that is not a failure of the passport.
- A passport says only that one wallet holds both tokens and that the holder published the link. It does not say which
  code the agent runs, nor that it is honest or safe. It is not a credential and confers no right to any income or asset.
  A receipt proves only what its signer says. A passport publicly and permanently links a wallet, an identity, a
  container, its site and reviews.

## Install

Not on npm: install from the GitHub release, the SDK first and from the same release (this package depends on
`@tapeapi/sdk`, which npm would otherwise look for in the registry, where neither package is):

```bash
npm install https://github.com/BruceLanLan/tapeapi/releases/download/v3.0.0/tapeapi-sdk-3.0.0.tgz
npm install https://github.com/BruceLanLan/tapeapi/releases/download/v3.0.0/tapeapi-passport-0.1.0.tgz
```

Experimental and outside the compatibility promise. It has a version of its own (0.1.0); the release's tag is the
SDK's version. Built from https://github.com/BruceLanLan/tapeapi (folder `passport/`).

ES modules; Node 22+, and browser-plain (no `node:` import, `Buffer` or `process`). TypeScript declarations are
included. The draft's vectors are a test fixture only and are not in the package.

## Use

```js
import { resolvePassport } from '@tapeapi/passport'

const r = await resolvePassport({ name: '4246.0.tape' })      // or { agentId: '1001' }, { circuit: { processor, tokenId } }
console.log(r.state, r.reasons, r.warnings)                  // one state word, one reason, every warning
console.log(r.display.en)                                    // the draft's sentence (D-1 to D-6); r.display.zh in Chinese
```

- `resolvePassport(input, { api | rpc | rpcUrls, logs, maxProcessorScan, recordSnapshot })`: read-only. With `api` (a
  `createTapeAPI()` client of chain 56) it borrows that client's nodes and its processor table
  (`api.chain.processorNumber`, experimental in the SDK); the number it gives is checked by a strict `cpuAt` read. Without
  a table, at most 64 `cpuAt` reads, then UNAVAILABLE. Nodes, timeouts and disagreements give UNAVAILABLE, never BROKEN;
  only argument errors throw (`INVALID_ARGUMENT`).
- `logs: { urls, fromBlock, chunk, maxRequests }`: log-capable nodes of at least two operators for P-8 and §7. The scan
  runs from `fromBlock` (default 0) to the pinned block in chunks (default 5,000 blocks) within a request budget
  (default 64); a refused chunk, nodes without the pinned block, or a scan over budget make the history "not obtained".
  Give a `fromBlock` before the registries and the factory were deployed; a later one would miss events.
- `resolveFromSnapshot(snapshot)`: the same rules over a recorded `tap-agent-passport-snapshot/1` (the draft's vectors, or
  `recordSnapshot: true` of a live resolution), offline.
- `buildRegistrationFile`, `checkRegistrationFile`, `preparePassportRegistration`: the §5 file, written as canonical JSON
  from chain reads, and its read-only preparation (`tapeapi init --passport`). Nothing is sent: the holder stores the file
  with `putFile` and registers the identity from their own wallet, at their own cost.
- `agentCardFromPassport`: an A2A 1.0 card (Appendix B) for a CONFIRMED passport only. Display only: it never raises a
  state and is never a source of signers. A manifest has no marker for A2A endpoints, so the caller names them
  (`a2aEndpoints`, a subset of `endpoints.live`).
- `@tapeapi/passport/feedback`: §10, reviews written as ERC-8004 feedback and their summary. **Optional and
  conditional** on the review draft TAPs #54 at `703b2a9`, which is not merged; nobody has written such feedback yet.
- `checkDelegationProposal` (W-1, W-2) and `checkRuntimeCall` (W-3). Note: since 3.0 the holder console (the one
  the SDK's `tapeapi init` points to) proposes a 30-day delegation, W-1's default limit (not its 7-day advice); the
  holder can choose any number of days from 1 to 366.

The guide is [Agent Passport (experimental)](https://github.com/BruceLanLan/tapeapi/blob/main/docs/guides/passport.md).
On the command line: `tapeapi passport <agentId | name | processor#ID>`, `tapeapi-doctor --passport`,
`tapeapi connect --passport`, `tapeapi init --passport`.

## 中文

**实验性：Agent Passport 的只读解析，依据一份未合并的草案。** 护照把一个 ERC-8004 agent 身份（BNB 链上已部署的身份注册表）与一枚
TapeOut 电路关联起来：同一个钱包（持有人）持有两枚代币、身份带着指向这枚电路的 `tap.passport` 键、容器站点里的登记文件只列出这一个身份、
没有早先持有人留下的有效站点操作员、注册表的 agent 钱包等于持有人。本包在一个钉块上按严格共识先读链、再读站点文件，给出一个状态词、
一个具名原因与全部警告。它读取 ERC-8004 已部署的公开注册表来互通；它不是 ERC-8004 的扩展，也没有得到其作者或注册表运营者的背书。

不受任何兼容承诺约束。截至 2026-10-28 的边界：草案是未合并的 PR #83（头 `cae25e6`，已提交、评审中），草案此后已有更新（现为 `cbf4e03`），本包实现的是 `cae25e6` 时的文字，每个结果都带着它所读的头，跟进新文字的包已列入计划；主网上目前还不知道有任何护照解析为
CONFIRMED（草案作者本人的主网小额实跑尚未进行）；两个注册表都可升级（UUPS，owner 形如 3-of-5 Safe），实现变了即 UNAVAILABLE；赠送的身份与电路真实存在，本包从不按所有者列出身份；
没有能查日志的节点时，站点操作员与持有人历史只给警告，绝不当作空历史；只能签 EIP-712 的钱包没有密封收件箱，这不是护照的故障。护照只说明
同一个钱包持有两枚代币、且持有人公布了这一关联，不说明 agent 运行什么代码、是否诚实或安全；回执只证明签名方所说的内容。护照会把钱包、
身份、容器、站点与评价公开且永久地关联在一起。3.0 起操作台（`tapeapi init` 指向的那个）提议 30 天委托，
等于草案 W-1 允许的 30 天默认上限（没有照它的建议默认 7 天）；持有人可选 1 到 366 天。
