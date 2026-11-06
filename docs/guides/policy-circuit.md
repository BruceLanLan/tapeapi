# Policy circuits (experimental)

A service that is asked to serve an agent first and be paid later cannot see the limits the agent's wallet keeps in a
back end. A **policy circuit** is a spending rule written as a small `tapnet/1` circuit, fixed byte for byte by its
hash, that the agent's principal **binds** to a mandate, an escrow session or an account by an EIP-712 signature. A
counterparty handed the binding re-runs the circuit over the request in front of it and sees for itself whether the
request is inside the rule. The experimental package `@tapeapi/policy-circuit` (version 0.1.0, a package of its own, not
part of the SDK) does this, following the Policy Circuit Gate TAP draft.

> **What this is not.** It is an **off-chain check**, and it constrains **only the parties that check it**: the agent's
> wallet may ignore it and can spend outside the rule toward anyone who does not check. It is **not a signing
> guardrail**, and a binding is not a guarantee that an agent cannot overspend. A limit over a period counts only the
> requests one gatekeeper saw. The draft is a pull request (TAPs #84, a conditional draft), submitted, now a draft PR,
> **not merged**; of the drafts it leans on, mandates of TAP-18 (from #47) are merged as a Draft (merging is not
> adoption) and the escrow drafts (#59, #60) are submitted (in review); the escrow contract is not audited and not deployed. **Nothing is deployed** for policy circuits (no gatekeeper contract, no netlist-NFT contract with the
> Eval extension), and nothing in the package sends a transaction. Everything here may change or go away in any release: the package is
> **outside the compatibility promise**.

## 1. The pieces

| Piece | What it is |
|---|---|
| Policy file | A `tapnet/1` netlist (NAND and LATCH records only) with 128 input pins and 8 output pins, at most 49,152 bytes. Its identity is its netlist hash, SHA-256 of the file. With LATCH records it is **stateful** and keeps state across the requests one gatekeeper presents. |
| Tables | `{ assets, counterparties }`: for each asset address the rule names, its class (1-255) and its own unit (`{ class, unit }`, the unit a decimal string: base units of that asset per amount unit); for each counterparty address, its class. Their hash is signed, so a change in one asset's unit is another binding. |
| Request word | 128 bits built from `{ amount, asset, counterparty, kind, ts }` and the tables: the amount in the request's own asset's unit (rounded **up**, saturated with an overflow bit; an asset the tables do not list always sets the overflow bit), the two classes, the kind (pay, fund, call, transfer, other), the UTC day, hour and weekday. A verifier always rebuilds it and never takes a word from the requester. |
| Result | One byte: exactly `0x01` allows; anything else denies with a reason code (an allow bit with a reason is an invalid result, denied). |
| Binding | `PolicyBinding(netlistHash, subjectKind, subject, tablesHash, notBefore, expires, issued)`, signed in TAP-11's EIP-712 domain (name `TapeAPI`, the hub, the subject's chain) by the **binder** the subject kind names. It can be revoked by a `PolicyBindingRevocation` from the same signer. |

The subject kinds, and what a check can report at best (fixed in the code; no option changes it):

| Kind | Subject | Binder | Best report |
|---|---|---|---|
| 1 `mandate` | The mandate hash of the TAP-18 draft (from #47; the SDK's `mandateHashOf`; checked equal to that draft's vectors) | The current holder of the mandate's principal | `conditional` |
| 2 `escrow-session` | `keccak256(escrow ‖ consumer ‖ provider ‖ key)` of a #59 / #60 escrow channel | The channel's consumer (its holder, when the consumer is a contract) | `conditional` |
| 3 `account` | The container address of a TapeOut circuit | The holder of that circuit, never the account itself (`binding-self-signed`) | `true`: the signer had the authority to bind the account (not that anyone enforces it) |
| 4 `label` | `keccak256(label)` | Anyone | `false`: display only, binds nobody |

`conditional` means: every check came out right, but the binder rule rests on drafts that can still change; it binds only
the parties that check it. `enforceable` reports whether the signer had the authority to bind the subject, never that a
gatekeeper, wallet, escrow or contract will honour or enforce the binding. Without the policy file at hand there is no verdict (`enforceable` is never `true` or
`conditional`), and without a checked binder `enforceable` is `null`.

## 2. Check a binding

```js
import { checkPolicyBinding, verifyPolicyBinding, policyBinderFromApi } from '@tapeapi/policy-circuit'

// the binder already known (an ECDSA signer):
const r = checkPolicyBinding(56, binding, sig, tables, { now, policyFile, binder: holder, revocations })
r.problems      // the draft's problem names, in its order (binding-expired, tables-hash-mismatch, ...)
r.enforceable   // true | false | null | 'conditional'
r.display.en    // e.g. "conditional: the binder rule rests on drafts that can still change; binds only the parties that check it"

// the binder read from chain: the holder at a TAP-10 pinned block, and EIP-1271 at that block for a contract holder
const reader = policyBinderFromApi(api, { rpc, chainId: 56 })
const v = await verifyPolicyBinding(56, binding, sig, tables, { now, policyFile, binder: reader })
```

A revocation's signer is **recovered from its signature**; an entry without one is ignored. A contract binder (a Safe
holding the circuit, for example) is checked under EIP-1271 only through the reader: without a reader, or when a read
fails, the result says `binderChecked: false` and `enforceable: null`, never a pass. When you have the mandate or the
session, pass it (`mandate`, `session`): the binding must name it, and a binding window that does not fit inside it is
`binding-outlives-subject`. A gatekeeper of an escrow-session binding must be given the session (section 4).

The binder signs in its own console: `policyBindingTypedData(chainId, { netlistHash, subjectKind, subject, tables })`
gives the EIP-712 payload, with a 7-day window by default. The package signs nothing, and a runtime that reads text from
other parties (an agent) must not sign a binding or a revocation.

## 3. A gatekeeper in your service

```js
import { createPolicyGate, policyTraceFileStore } from '@tapeapi/policy-circuit'
import * as fs from 'node:fs'

const gate = await createPolicyGate({
  chainId: 56, binding, sig, tables,
  fetchPolicyFile: async (netlistHash) => fileFor(netlistHash),   // or policyFile
  binder: reader,                                                 // or the holder's address
  revocations: () => currentRevocations(),                        // read again before every decision
  store: policyTraceFileStore('./policy-trace.jsonl', fs),        // append-only, mode 600, with a lock
})
await gate.startTrace({ reason: 'first use of this binding' })   // a stateful policy needs an explicit start
const v = await gate.admit({ amount: '1000000000000000', asset, counterparty, kind: 1 })
if (v.verdict === 'allow') { /* serve or settle */ }
```

On a gate whose binding did not check out, `startTrace` and every `admit` return the denial instead (`gate.status()` says why).
The gatekeeper assigns `ts` from its own clock and advances the state one beat per request, allowed or denied. It
fails closed in every case of the draft's failure table:

| Situation | `admit` |
|---|---|
| Policy file not obtainable, hash differs, file invalid or wrong pins | denies (`policy-file-unavailable`, `policy-hash-mismatch`, `policy-invalid-file`, `policy-bad-pins`) |
| Binding not yet valid, expired (checked before every decision), revoked, unsigned, wrong signer, self-signed | denies with the problem |
| Tables changed after signing | denies (`tables-hash-mismatch`) |
| Binder not checked, or a label binding | denies |
| The circuit changed hands after the binding was signed | denies at the next decision (`not-signed-by-binder`): the binder is read again before every decision, and a read that fails denies (`binder-not-checked`) |
| An invalid result byte | denies, flagged `invalidResult` |
| Revocations cannot be read | denies (`revocations-unavailable`) |
| Stateful policy, no trace in the store, a broken line, a recorded verdict that does not replay, a write that fails | denies (`trace-unavailable`); a restart is only `startTrace({ reason })`, and it is written into the trace |
| Two live bindings of one signer and subject with the same `issued` | denies (`binding-ambiguous`); otherwise the later `issued` is used |

The state is never stored on its own: it is rebuilt from the trace, so a restarted process (or a second one on the same
file) continues where the trace stands. `gate.trace()` gives the entries in the form `replayPolicyTrace` takes, so the
other side can re-check every verdict.

## 4. Escrow sessions, and why x402 channels are not kind 2

For a kind-2 binding the gatekeeper takes the voucher's `cumulative` instead of an amount: the amount presented to the
policy is the increase over the last **allowed** cumulative, and a lower cumulative is refused
(`trace-cumulative-decreases`). A voucher the gatekeeper denied can still be settled by anyone, since the escrow does not
read the gate; the gate then lags the channel, which overstates the next delta and errs toward denial.

Kind 2 names a channel of the #59 / #60 escrow interface only. TapeAPI's experimental x402 batch-settlement backend also
has a session key, but it is another contract, another voucher type and has no session expiry, so it is not a kind-2
subject: `policySubject.escrowSession` and `createPolicyGate` refuse one (`INVALID_ARGUMENT`, `data.reason`
`policy-subject-x402`, a TapeAPI name, not one of the draft's problems). For such a channel use an account binding
(kind 3) or a label (kind 4, display only). A kind-2 subject is only a hash of the four addresses, so the refusal needs
the session: `createPolicyGate` with a kind-2 binding and no `session` throws `INVALID_ARGUMENT` (`data.reason`
`policy-session-required`).

## 5. Not the local budget

The SDK's local budget (`--policy`, `createBudget`) is a convenience in your own process that nobody else can rely on; a
policy circuit is a rule a counterparty can re-run, and it too binds only those who check it. Neither replaces the
other, and there is no compiler from one to the other in this version. What a budget rule would become:

| Budget rule | In the request word | |
|---|---|---|
| `service` (a container address) | the counterparty class | can be written as a circuit |
| `period: call`, `maxAmount` | the amount in units (rounded up) | can be written, with a unit chosen per asset |
| `period: day`, `maxAmount` / `maxCalls` | the day index and latches in the circuit | can be written (like the draft's `daily-cap` example, at most 65,535 units a day) |
| `currency: USD` (a price a receipt claims) | the asset class needs an address | cannot: USD has no asset address |
| a token currency | the asset class | can be written (keyed by the token contract) |
| `model`, `maxPromptTokens`, `maxCompletionTokens` | nothing | cannot |
| `period: month` / `total` | only the day index | not in this version |
| counting the worst case first and correcting by the receipt; released lines | a trace only moves forward | cannot: a circuit can only count the worst case |

## 6. Binding windows

A policy binding proposed by `policyBindingTypedData` lasts 7 days by default; a tool must not propose more than 30 by
default (a longer one is the binder's own choice, flagged `longWindow`). The windows of mandates (TAP-18, from #47) and of TAP-11
delegations (#83 W-1, and what TapeAPI proposes today) are in one table, in the
[Agent Passport guide](passport.md#windows-side-by-side).

The package decides nothing for another draft. A binding can be revoked only by its signer: a holder who cannot sign (a
frozen key, a holder that changed) cannot revoke before the binding expires, so keep windows short. When the circuit
behind an account changes hands, earlier bindings fail the binder check against the new holder.

## 7. Status

- Draft: TAPs pull request #84 (Policy Circuit Gate), submitted, now a draft PR, conditional, not merged; the package
  follows its head `0b73174`. Against the earlier head `7827c07`, the tables changed (a class and a unit per asset in place
  of the single `amountUnit`, so every tables hash and binding hash changed), and an asset the tables do not list now
  overflows; the earlier tables form is `tables-malformed`.
- The tests replay all 188 cases of the draft's vectors (a copy pinned by SHA-256, kept with the tests and not in the
  package), and compare the evaluator with the draft's Python TAP-02 reference on 10,000 random beats when `python3` is
  present.
- Not in this version: a budget-to-circuit compiler, a hook in `@tapeapi/server`, the on-chain call convention
  (`evalFile` / `stepFile`), Circuit Jobs. Nothing deployed, no transaction.

The package README is [policy-circuit/README.md](../../policy-circuit/README.md).
