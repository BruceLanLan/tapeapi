# @tapeapi/policy-circuit

**Experimental, version 0.1.0.** `@tapeapi/policy-circuit` re-runs a spending rule written as a `tapnet/1` circuit,
following the Policy Circuit Gate TAP draft (TAPs pull request #84, now a draft PR, not merged; this package follows its head
`0b73174`). A counterparty that checks a binding can see for itself whether a request is inside the rule its principal
signed. It constrains only the parties that check it: the agent's wallet may ignore it. Bindings to a mandate (TAP-18, from #47,
merged as a Draft; merging is not adoption) or an escrow session (#59, #60, submitted, in review) are reported as
`conditional` in this version, never as enforceable; their binder rules rest on drafts that can still change, and the
escrow contract is not audited and not deployed. `enforceable` reports whether the signer had the authority to bind the
subject; it never says that anyone enforces the binding. Nothing in this package sends a transaction.

This package is **outside the compatibility promise**: it may change or go away in any release, and the Stable promise
of `@tapeapi/sdk` and `@tapeapi/server` does not cover it.

`@tapeapi/policy-circuit`（实验性）按 Policy Circuit Gate TAP 草稿（TAPs pull request #84，目前是 draft PR，未合并）重跑一份写成 `tapnet/1`
电路的支出规则。去核查绑定的一方可以自己看出某个请求是否在委托人签下的规则之内。它只约束去核查它的一方：代理的钱包可以不理会它。
绑定在授权书（TAP-18，来自 #47，已合并为 Draft，合并不等于被采纳）或托管会话（#59、#60，已提交，评审中）上的结果，本版一律报告为"有条件"（`conditional`），从不报告为可强制执行；它们的绑定者规则依托的草稿仍可能改动，
托管合约未经审计、未部署。`enforceable` 只表示签名者有没有权力约束该主体，不表示有谁在强制执行。本包不发送任何交易。本包**不受兼容承诺约束**：可能在任何一次发布中改变或撤下，
`@tapeapi/sdk` 与 `@tapeapi/server` 的稳定承诺不覆盖它。

Boundaries:

- An off-chain check. It is not a signing guardrail: it does not stop a wallet from signing anything, and a binding is
  not a guarantee that an agent cannot spend outside the rule.
- A limit over a period (a daily cap) counts only the requests one gatekeeper saw, not the agent's requests everywhere.
- Nothing is deployed: no gatekeeper contract, no netlist-NFT contract with the Eval extension. The on-chain call
  convention of the draft (`evalFile` / `stepFile`) is not implemented here.
- A label binding (kind 4) is display only and binds nobody.
- Kind 2 (escrow session) names a channel of the #59 / #60 escrow interface only. An x402 batch-settlement channel is
  refused as a kind-2 subject (`policy-subject-x402`); use an account or a label binding for it.
- It is not the local budget. The SDK's `--policy` file and `createBudget` are a convenience in your own process that
  nobody else can rely on; a policy circuit is a rule a counterparty can re-run, and it too binds only those who check it.
- This package signs nothing: it gives the binder's console the typed data. A runtime that reads text from other parties
  (an agent) must not sign a binding or a revocation.

## Install

Not on npm: install from the GitHub release, the SDK first and from the same release (this package depends on
`@tapeapi/sdk`, which npm would otherwise look for in the registry, where neither package is):

```bash
npm install https://github.com/BruceLanLan/tapeapi/releases/download/v3.0.0/tapeapi-sdk-3.0.0.tgz
npm install https://github.com/BruceLanLan/tapeapi/releases/download/v3.0.0/tapeapi-policy-circuit-0.1.0.tgz
```

Experimental and outside the compatibility promise. It has a version of its own (0.1.0); the release's tag is the
SDK's version. Built from https://github.com/BruceLanLan/tapeapi (folder `policy-circuit/`).

ES modules; Node 22+. The checks and the evaluator are browser-plain (no `node:` import, `Buffer` or `process`); the
file trace store takes `node:fs` from the caller. TypeScript declarations are included.

## Use

```js
import { loadPolicyCircuit, evaluatePolicyRequest, checkPolicyBinding, createPolicyGate, policyBinderFromApi } from '@tapeapi/policy-circuit'

// a service, before it serves or settles: fails closed in every case of the draft's failure table
const gate = await createPolicyGate({ chainId: 56, binding, sig, tables, policyFile, binder, revocations: () => current() })
const v = await gate.admit({ amount: '1000000000000000', asset, counterparty, kind: 1 })
if (v.verdict === 'allow') { /* serve */ }
```

Amounts and anything above 2^53 travel as decimal strings: an unsafe JS number is refused, never rounded.

The tables give each listed asset its own class and unit (`assets[address] = { class, unit }`, the unit a decimal string), so a limit of
`n` units means the same amount in every asset; a request in an asset the tables do not list always overflows (reason 6,
`amount-overflow`), whatever its amount. The earlier single `amountUnit` form is `tables-malformed`.

The gate reads the binder again before every decision (one more read each time, such as a `siteStatus`), so when the
circuit changes hands the earlier holder's bindings stop at the next decision, and a read that fails is a denial. A gate
for an escrow-session binding (kind 2) needs `session`; without it `createPolicyGate` throws `INVALID_ARGUMENT`
(`policy-session-required`), since the subject alone cannot show that the channel is not an x402 one.

The guide is [Policy circuits](https://github.com/BruceLanLan/tapeapi/blob/main/docs/guides/policy-circuit.md). The
tests replay all 188 cases of the draft's vectors (a copy pinned by SHA-256, not shipped in the package) and compare
the evaluator with the draft's Python TAP-02 reference.

It is a package of its own, never part of `@tapeapi/sdk`, so that the SDK carries none of it.

MIT licensed.
