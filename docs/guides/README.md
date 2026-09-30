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
| [Private channels](channels.md) | Apps, agents and services that talk to each other | Publish channel keys, open an encrypted channel, choose a relay or the chain as the carrier. |
| [Group chat](groups.md) | Apps adding group chat for up to 32 containers (up to 128 in the experimental format 2) | Create a group and deliver the epoch message and every invite in one call, find invites as a member, save state, and work through a troubleshooting checklist. |
| [MCP](mcp.md) | Anyone using Claude, Cursor or another MCP client, and MCP server authors | Add the public service as MCP tools by URL, run the local command that verifies every answer and pins the tool list, or tape out your own MCP server. |
| [AI agents](agents.md) | Anyone giving tools to an in-browser agent | Expose a service as WebMCP tools whose answers are always signature-checked. |
| [FAQ and troubleshooting](faq.md) | Everyone | Error codes, common mistakes, and what the reader's warnings mean. |
| [Upgrading to 1.0](upgrade-1.0.md) | Everyone with 0.x code | See what 1.0 promises (Stable, Experimental, Internal), what changed from 0.x and what to write instead, and the full error-code table. |

Before you start: Node.js 20 or later, and

```bash
git clone https://github.com/BruceLanLan/tapeapi.git && cd tapeapi && npm install
```

The protocol itself is specified in [`spec/`](../../spec/) (TAPI-20 to TAPI-27). The guides link to the relevant section
wherever a rule matters.
