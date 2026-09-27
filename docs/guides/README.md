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
| [Private channels](channels.md) | Apps, agents and services that talk to each other | Publish channel keys, open an encrypted channel, choose a relay or the chain as the carrier. |
| [MCP](mcp.md) | Anyone using Claude, Cursor or another MCP client, and MCP server authors | Add the public service as MCP tools by URL, run the local command that verifies every answer and pins the tool list, or tape out your own MCP server. |
| [AI agents](agents.md) | Anyone giving tools to an in-browser agent | Expose a service as WebMCP tools whose answers are always signature-checked. |
| [FAQ and troubleshooting](faq.md) | Everyone | Error codes, common mistakes, and what the reader's warnings mean. |

Before you start: Node.js 20 or later, and

```bash
git clone https://github.com/BruceLanLan/tapeapi.git && cd tapeapi && npm install
```

The protocol itself is specified in [`spec/`](../../spec/) (TAP-20 to TAP-27). The guides link to the relevant section
wherever a rule matters.
