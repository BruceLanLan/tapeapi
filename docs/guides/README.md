# Guides

Task-oriented guides. Each one starts from a clean checkout and ends with something that works.
面向任务的指引，每篇都从一个干净的仓库开始，到一个能跑的结果结束。中文版在 [`zh-CN/`](zh-CN/)。
The same guides, with search, are at [tapeapi.fun/docs](https://tapeapi.fun/docs/). 网页版（可搜索）：[tapeapi.fun/docs](https://tapeapi.fun/docs/)。

| Guide | For | You will |
|---|---|---|
| [Introduction](introduction.md) | Everyone new to TapeAPI | Learn what it is, how it works, the on-chain addresses and which guide to read next. |
| [Public API](public-api.md) | Anyone who wants chain data or a relay now | Call the free public service (8 signed reads of BNB Chain and TapeOut, 7 of them block-pinned) and use the free public relay. |
| [Call a service](consume.md) | App and backend developers | Resolve a service on chain, call it, verify the answer, pay for calls, require agreement between providers. |
| [Run a service](provide.md) | API providers | Turn functions or an existing REST API into signed methods, go live from a phone or a server, renew, operate. |
| [For AI API providers](ai-providers.md) | AI relays (new-api), gateways, aggregators and teams serving their own models | Put a signing sidecar in front of your AI API: an on-chain identity, a price list pinned on chain and a signed usage receipt for every call, with no change for your users; the new-api package, Node and Cloudflare Worker options. |
| [A billing layer in front of the sidecar](billing-layer.md) (experimental) | Operators with their own accounts and balances in front of a sidecar | Fit a billing layer to the sidecar: topology, matching FORMATS, charging from receipts, sizing holds and their limits, model names, user-facing wording, and upgrading a sidecar from 2.0 to 2.4. |
| [Private channels](channels.md) | Apps, agents and services that talk to each other | Publish channel keys, open an encrypted channel, choose a relay or the chain as the carrier. |
| [Group chat](groups.md) | Apps adding group chat for up to 32 containers (up to 128 in the experimental format 2) | Create a group and deliver the epoch message and every invite in one call, find invites as a member, save state, and work through a troubleshooting checklist. |
| [MCP](mcp.md) | Anyone using Claude, Cursor or another MCP client, and MCP server authors | Add the public service as MCP tools by URL, run the local command that verifies every answer and pins the tool list, or tape out your own MCP server. |
| [AI agents](agents.md) | Anyone giving tools to an in-browser agent | Expose a service as WebMCP tools whose answers are always signature-checked. |
| [Container agents](container-agents.md) (experimental) | Containers that hire another container for a task | Sign a mandate that authorises no money, check a task thread and its evidence, check a plain-transfer payment, revoke; phase 0, nothing enforced on chain. |
| [Reconcile your receipts](reconcile.md) (experimental) | Buyers of AI calls, agents spending under a mandate, and operators exporting a ledger | Set your receipts against a bill, the requests you sent, a mandate's caps and your own limits: facts with their lines, read from local files only. |
| [Interop between apps and containers](interop.md) (experimental) | Apps and containers that call each other | Run two local demos: containers calling each other with the existing API, and the visitor grant prototype (a wallet lets app A call a few methods of service B for a short time; no payment, no TAP). |
| [Agent Passport](passport.md) (experimental) | Agents that offer services, and anyone checking one | Check, read-only, whether an ERC-8004 agent identity and a TapeOut circuit belong to the same holder, as the draft TAPs #83 says (submitted, in review, not merged; the package follows its text at `cae25e6`, and the draft has moved since; nothing on mainnet resolves to CONFIRMED yet), and write the registration file for your own. |
| [Policy circuits](policy-circuit.md) (experimental) | Services that want to check an agent's spending rule themselves | Re-run a rule written as a `tapnet/1` circuit, check its signed binding and gate requests with it, failing closed; an off-chain check that binds only the parties that check it (TAPs #84, submitted, now a draft PR, not merged; nothing deployed). |
| [Circuit Jobs](circuit-jobs.md) (a draft, documentation only) | Anyone weighing an agent job settled by a dispute game | What the draft TAPs #85 (submitted, now a draft PR) describes (an ERC-8183 job settled by the #74 game), why TapeAPI ships no code for it, and how it relates to receipts, the passport and policy circuits. |
| [FAQ and troubleshooting](faq.md) | Everyone | Error codes, common mistakes, and what the reader's warnings mean. |
| [Reference](reference.md) | Everyone who wants the datasheet detail | What 2.0 changed, the experimental features (escrow not audited, not deployed, not on mainnet; local chains and tests only; nothing charged today), privacy, the agreement truth table, absolute maximum ratings, the cost of operation, the roadmap, the specification index and the security note. |
| [Upgrading to 1.0](upgrade-1.0.md) | Everyone with 0.x code | See what 1.0 promises (Stable, Experimental, Internal), what changed from 0.x and what to write instead, and the full error-code table. |
| [Upgrading to 2.0](upgrade-2.0.md) | Everyone with 1.x code | Conformance as the default, the new channel and group labels, the error fields and codes that moved, and what to write instead. |
| [Upgrading to 3.0](upgrade-3.0.md) | Everyone with 2.x code | Who needs to do anything, the five breaking changes and the option that keeps each 2.x behaviour, what does not change, and the support windows. |

Before you start: Node.js 22 or later, and

```bash
git clone https://github.com/BruceLanLan/tapeapi.git && cd tapeapi && npm install
```

The protocol itself is specified in [`spec/`](../../spec/) (TAPI-20 to TAPI-27). The guides link to the relevant section
wherever a rule matters.
