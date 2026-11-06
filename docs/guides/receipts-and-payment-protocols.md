# Receipts and payment protocols (experimental)

Where a TapeAPI usage receipt sits next to x402, Google's AP2, ERC-8004, ERC-8183 and the IETF drafts on attestation
receipts, and how a bounded-agent mandate lines up with an AP2 Payment Mandate. **This page is an experimental
document**: a factual comparison, written from the primary sources listed in [Sources](#sources) as they read on
2026-10-21; the x402 and AP2 files were checked again on 2026-10-27, and every statement below says which reading it
comes from where they differ. It may change in any minor release. It describes no integration: there is no adapter, no payment bridge and
nothing here pays. Where a claim could not be checked in a primary source, it says **unverified**.

> **A receipt proves what the signer said, not which model ran.** A TapeAPI receipt binds a service's key to the exact
> request bytes, to the answer (its exact bytes; for a stream, the data of its events) and to the usage and price the
> service claims. None of the formats on this page, ours
> included, proves which model produced an answer; the attestation drafts in §5 are the ones that try, and only under
> stated assumptions about the hardware.

## 1. What a TapeAPI usage receipt signs

A service whose manifest has an `ai` price table puts a signing sidecar in front of an AI API ([TAPI-21
§3.5](../../spec/TAPI-21.md), [AI providers](ai-providers.md)). For every answer it signs one envelope:

- `params.requestSha256`: SHA-256 of the request body bytes exactly as the client sent them;
- `result.responseSha256`: SHA-256 of the answer bytes the client received (for a stream, of its event data, by a
  fixed parsing rule);
- `result.model`, `result.usage`, `result.status`, `result.complete`, `result.stream`;
- `result.prices`: the amounts computed from the manifest's price table for that usage, which a client can recompute.

The signer is the manifest's `signer`, a key the circuit's **holder** delegates in a signature the client reads from
chain ([TAPI-20](../../spec/TAPI-20.md)). The client checks the signature, the hashes of the bytes it holds, and the
arithmetic of the prices.

What it does not say: which model ran upstream, that the upstream's usage figures are honest, or that anything was
paid. Paying is a separate matter (TAPI-22 vouchers, whose escrow contract is not audited and not deployed). What the
signature adds is accountability: the service cannot disown a receipt, and a buyer can set receipts against a bill
([Reconcile your receipts](reconcile.md)).

TapeAPI's one stronger form is [TAPI-23](../../spec/TAPI-23.md), the attested read: a client asks at least two
independent providers for a read-only chain call and refuses any disagreement. That works because a chain read is
deterministic; an AI answer is not, so there is no quorum rule for receipts.

## 2. x402

x402 is a protocol for HTTP 402 payments. Its specification lives in the repository `x402-foundation/x402`
(`coinbase/x402` is a fork of it, as GitHub reports); the core document is `specs/x402-specification-v2.md`
("Protocol Version: 2").

- **Schemes.** `specs/schemes/` has four (at the commit read on 2026-10-21, and still on 2026-10-27): `exact`, `upto`,
  `batch-settlement` and `auth-capture`. In
  `batch-settlement` the client's payment commitment is accepted at request time and value moves later ("settlement
  stores it rather than executing a transfer"); the settlement result carries a commitment identifier, and the server
  may charge less than the committed maximum, reported in `PAYMENT-RESPONSE`. `upto` authorises up to a maximum for one
  request, settled once. The `batch-settlement` sentences describe the abstract scheme file
  (`scheme_batch_settlement.md`, last changed 2026-05-05). On 2026-10-27 its directory also holds network bindings for
  EVM, SVM and Cloudflare (`scheme_batch_settlement_evm.md`, `_svm.md`, `_cloudflare.md`; the directory last changed
  2026-10-26), which say how a commitment is formed and redeemed on each network; this page does not summarise them.
- **Settlement response.** `SettlementResponse` has `success`, `errorReason`, `payer`, `transaction`, `network`,
  `amount` and `extensions` (at the commit read on 2026-10-21). A change of 2026-10-26 adds an optional `errorMessage`
  (a human-readable explanation of `errorReason`); on 2026-10-27 the schema still has no hash of the request or of the
  response.
- **Signed receipts.** The optional "Offer and Receipt" extension (`specs/extensions/extension-offer-and-receipt.md`)
  lets the resource server sign a receipt, returned "only on success", confirming that payment was received and
  service was delivered. Its signed payload has exactly `version`, `network`, `resourceUrl`, `payer`, `issuedAt` and an
  optional `transaction`, signed as EIP-712 (domain `"x402 receipt"`, `chainId` 1) or as JWS. It is "privacy-minimal"
  by default. The extension says its wire shape is "not considered stable". (Last changed 2026-07-23; unchanged on
  2026-10-27.)

**Verified:** batch settlement exists as a scheme, and the x402 receipt's signed fields contain no request hash and no
response hash. (The two are separate parts of x402: batch settlement is a scheme, the receipt an extension.)

**Where the TapeAPI receipt sits.** An x402 receipt says "this payer paid for this resource URL at this time". A
TapeAPI receipt says "this service's key answered these request bytes with this answer, and claims this usage
and price". The two answer different questions and could sit side by side; neither is a replacement for the other.
TapeAPI does not speak x402 and this page proposes no bridge. (The one x402 part TapeAPI touches is elsewhere and is not
about receipts: an experimental backend, in no release, that can hold a bounded agent's funds in x402 batch-settlement
channels on deployed contracts we did not write, for plain-EOA payers only; it implements neither the HTTP 402 exchange
nor the receipt extension, and it changes nothing a TapeAPI receipt signs: see
[x402 batch-settlement channels](container-agents.md#experimental-x402-batch-settlement-channels-as-the-enforcement-experimental).)

## 3. AP2

AP2 is Google's Agent Payments Protocol, in the repository `google-agentic-commerce/AP2`. Its latest tag is `v0.2.0`
(2026-04-28; still the latest tag on 2026-10-27; `docs/ap2/specification.md`, "Agentic Payment Protocol (v0.2)").

- **Mandates.** v0.2 defines two: the **Checkout Mandate** (what is bought, bound to a merchant-signed checkout JWT by
  a hash) and the **Payment Mandate** (the payment for that checkout). Each is **open** (signed by the user, with
  constraints, for an agent to complete) or **closed** (complete, for one transaction). They are SD-JWT credentials; an
  open mandate MUST carry a `cnf` claim naming the agent's proof-of-possession key (RFC 7800).
- **Constraints of an open Payment Mandate:** `payment.agent_recurrence`, `payment.allowed_payees`, allowed payment
  instrument, allowed PISP, `payment.amount_range`, `payment.budget` (a total, tracked by the verifier across closed
  mandates), `payment.reference` (ties it to a checkout mandate) and `payment.execution_date`. Unknown constraints "MUST
  be treated as failing evaluation", and new constraint types MAY be defined with a collision-resistant name.
- **Receipts.** A Checkout Receipt and a Payment Receipt are returned after processing. The Payment Receipt schema
  (`code/sdk/schemas/ap2/payment_receipt.json`) has `status`, `iss`, `iat`, `reference` (the hash of the closed
  mandate), `payment_id` and confirmation ids: it binds a payment to a mandate, not to the content of any answer.
- **Earlier names.** v0.1 (tag `v0.1.0`, 2025-09-16) had an Intent Mandate, a Cart Mandate and a Payment Mandate.
  v0.2 replaces the first two with the open and closed Checkout Mandate.
- We found no revocation mechanism in the v0.2 documents we read. **Unverified** beyond those documents.

## 4. A bounded-agent mandate and an AP2 Payment Mandate: the direction

TapeAPI's container-agent `Mandate` ([Container agents](container-agents.md), TAP-18 (#47) for phase 0 and the draft #60 for
phase 1) is an EIP-712 message the circuit's holder signs: `principal`, `agent`, `agentKey`, `mode`, `taskHash`,
`scope[] { provider, token, cap }`, `feeToken`, `feeCap`, `notBefore`, `expires`, `nonce`, `subdelegate`, with a
separate `MandateRevocation`. The table maps fields, **not enforcement**; it is a direction only, with no adapter code
and no payment bridging.

| Mandate (TapeAPI) | Closest AP2 v0.2 item | Difference |
|---|---|---|
| `principal` signs | The user signs the open mandate on a Trusted Surface | EIP-712 with secp256k1, against SD-JWT (the AP2 examples use a P-256 key) |
| `agentKey` | `cnf` of the open mandate | Same role: the key that later proves the agent acts under the mandate |
| `scope[].provider` | `payment.allowed_payees` | A TapeOut container address, against a list of merchants |
| `scope[].cap`, `scope[].token` | `payment.budget`, `payment.amount_range` | A token's base units (uint256), against an ISO 4217 currency and an amount |
| `notBefore`, `expires` | `payment.execution_date`, `exp` | Ours are Unix seconds; AP2's `exp` is Unix seconds, its `execution_date` window ISO 8601 |
| `taskHash` | `payment.reference` (loosely) | AP2 ties the payment to a checkout; ours ties the mandate to a task text |
| `mode`, `feeToken`, `feeCap` | none found | |
| `subdelegate` | the open-to-closed chain | Whether AP2 lets an agent delegate further: **unverified** |
| `MandateRevocation` | none found | |

**Enforcement differs.** In phase 0 a mandate's caps must stay zero and it enforces no spending at all. In phase 1
(bounded agents) the bound is the balance of an escrow channel the holder funds, on the TAPI-22 escrow contract, which
is **not audited and not deployed** on any chain, so it does not work on mainnet. In AP2 the bound is the verifiers'
deterministic evaluation of the constraints (credential provider, merchant, payment processor).

**What a later step could be** (not decided, not built): a page or file that shows a signed mandate's facts next to
their AP2 names, so that a reader who knows AP2 can read ours; and, if anyone asks for it, a TapeAPI constraint type
under AP2's rule for new types. Issuing AP2 mandates, accepting them, or moving money between the two is out of scope.

## 5. ERC-8004, ERC-8183 and attestation receipts

**ERC-8004 "Trustless Agents"** (Draft, created 2025-08-13; requires EIP-155, EIP-712, EIP-721, EIP-1271): an
identity registry (ERC-721), a reputation registry (`giveFeedback` with `agentId`, `value`, `valueDecimals`, `tag1`,
`tag2`, `endpoint`, `feedbackURI`, `feedbackHash`; the off-chain feedback file may carry a `proofOfPayment`, which the
text says can be used for x402) and a validation registry (`validationRequest`, `validationResponse`, a score from 0
to 100) for validators such as TEE attestation, zkML or re-execution. A TapeAPI receipt could be the file a feedback
entry points at; registering anything there costs gas, and nothing is planned.

**ERC-8183 "Agentic Commerce"** (Draft, created 2026-02-25; requires EIP-20): a job with an escrowed ERC-20 budget, a
client, a provider and an evaluator who alone completes or rejects it. `submit` takes a `bytes32 deliverable` (a
reference such as a hash), and `complete` / `reject` take an optional `bytes32 reason` (for example an attestation
hash). The contract does not check the deliverable. A receipt's hash fits either slot; nothing is planned. An open TAP
draft, Circuit Jobs, would make a contract the evaluator of such a job, settled by a dispute game; TapeAPI ships no
code for it ([Circuit Jobs](circuit-jobs.md)).

The EIP pages show no date of last change; these two summaries were read on 2026-10-21 and are not checked against the
ERC repository's history.

**IETF.** The RATS architecture ([RFC 9334](https://datatracker.ietf.org/doc/rfc9334/), January 2023, Informational)
separates an attester's Evidence from a verifier's Attestation Results;
[draft-ietf-rats-ear-04](https://datatracker.ietf.org/doc/draft-ietf-rats-ear/) (2026-05-26, a RATS working-group
draft) encodes those results. Two individual drafts (not working-group documents) define receipts for AI inference:

- [draft-tsyrulnikov-rats-attested-inference-receipt-02](https://datatracker.ietf.org/doc/draft-tsyrulnikov-rats-attested-inference-receipt/)
  (2026-07-05, Informational): a COSE_Sign1 receipt (CWT claims, profiled as an EAT, Ed25519) from a workload inside a TEE, binding `model_hash`, `request_hash`,
  `response_hash` and a hash of the platform's attestation document. It says that `model_hash` alone does not prove
  the model ran, and that TEE provenance holds only if four trust assumptions hold (the hardware, an honest workload,
  a key bound to the attested workload, a verifier that can check the vendor's chain).
- [draft-chueayen-attestation-receipts-03](https://www.ietf.org/archive/id/draft-chueayen-attestation-receipts-03.html)
  (2026-09-20, Informational): an Ed25519-signed JSON receipt of an inference decision with a request hash, a model
  identifier and an outcome, and no response hash. It calls itself application-layer evidence and lists "that the
  claimed model ran" as not established by the format alone.

The SCITT architecture ([RFC 9943](https://datatracker.ietf.org/doc/rfc9943/), June 2026) and
COSE Receipts ([RFC 9942](https://datatracker.ietf.org/doc/rfc9942/), June 2026) make the same point from another side:
a receipt there proves that a statement was registered in a transparency log, and "registering a Statement only
proves it was produced by an Issuer".

A TapeAPI receipt is application-layer evidence of the same kind: a signed statement by the service, with both bytes
hashed and the price recomputable, and no hardware evidence. Saying which model ran would take a TEE and trust in its
vendor; TapeAPI does not do that.

## 6. Side by side

| | Signed by | Request bytes | Response bytes | Usage and price | Payment | Which model ran |
|---|---|---|---|---|---|---|
| TapeAPI receipt (TAPI-21 §3.5) | The service's key, delegated by the holder on chain | SHA-256 | SHA-256 (a stream: of its event data) | Yes, recomputable | No | Not proved |
| x402 receipt (extension) | The resource server | No | No | No (the amount via `transaction`, optional) | Yes, on success | Not addressed |
| x402 `SettlementResponse` | No signature in the core schema | No | No | `amount`, optional | Yes | Not addressed |
| AP2 Payment Receipt | The issuer (`iss`) | No | No | No | Yes, bound to the closed mandate | Not addressed |
| ERC-8004 feedback | The reviewer's transaction | No | No | No | `proofOfPayment`, optional | Not addressed |
| ERC-8183 job | The evaluator's transaction | No | A `bytes32` reference | No | The escrowed budget | Not addressed |
| Attested inference receipt (draft) | A key bound to a TEE workload | Hash | Hash | No | No | Only under its four assumptions |
| Chueayen receipt (draft) | The issuer (Ed25519) | Hash | No | A cost estimate | No | Not established |

## Sources

Read on 2026-10-21, read-only. Repository files were read through the GitHub API.

- x402: `x402-foundation/x402` at `faa1c694c6` (2026-10-15): `specs/x402-specification-v2.md` (last changed
  2026-08-31), `specs/schemes/batch-settlement/scheme_batch_settlement.md` (2026-05-05),
  `specs/schemes/upto/scheme_upto.md`, `specs/extensions/extension-offer-and-receipt.md` (last changed 2026-07-23,
  commit `69652a6979`). <https://github.com/x402-foundation/x402>
- Checked again on 2026-10-27, read-only, through the GitHub API: x402 at `6b578ecc83` (2026-10-27):
  `specs/x402-specification-v2.md` last changed 2026-10-26 (`51a0664c2b`: an optional `errorMessage` in the settlement
  response and `invalidMessage` in the verify response); `specs/schemes/` still `auth-capture`, `batch-settlement`,
  `exact`, `upto`; `specs/schemes/batch-settlement/` holds `scheme_batch_settlement.md` (still 2026-05-05) and the
  `_cloudflare`, `_evm` and `_svm` bindings; `extension-offer-and-receipt.md` unchanged. AP2: tags `v0.2.0` and
  `v0.1.0`, no later one.
- AP2: `google-agentic-commerce/AP2`, tag `v0.2.0` (2026-04-28) and `v0.1.0` (2025-09-16): `docs/ap2/specification.md`,
  `payment_mandate.md`, `checkout_mandate.md`, `agent_authorization.md`, `code/sdk/schemas/ap2/payment_receipt.json`,
  `payment_mandate.json`; v0.1 `docs/specification.md`. <https://github.com/google-agentic-commerce/AP2>
- ERC-8004: <https://eips.ethereum.org/EIPS/eip-8004>. ERC-8183: <https://eips.ethereum.org/EIPS/eip-8183>.
- IETF: RFC 9334, draft-ietf-rats-ear-04, draft-tsyrulnikov-rats-attested-inference-receipt-02,
  draft-chueayen-attestation-receipts-03, RFC 9942, RFC 9943 (links in §5).

**Unverified or left out:** the dates and membership of the x402 Foundation (sources disagree); any hand-over of AP2 to
another body; anything in the x402 schemes beyond the files listed; the AP2 Checkout Receipt schema; whether either
IETF individual draft will be taken up by a working group.
