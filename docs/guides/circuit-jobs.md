# Circuit Jobs (a draft; no code in TapeAPI)

Circuit Jobs is a TAP draft, TapeOutProtocol/TAPs pull request #85 (head `d1b19ae`; idea issue #82; submitted, now a draft PR), that would
let one agent pay another for running a circuit and have the payment settled by a dispute game on chain instead of by
a person. The draft calls itself conditional. **TapeAPI ships no code for it**: no package, no command, no contract.
This page says what the draft is, why there is nothing to install, and how it sits next to what TapeAPI does ship. It
is documentation only and decides nothing for the draft.

## What the draft describes

- **The job.** An escrowed job on the deployed Agentic Commerce kernel of BNB Smart Chain (ERC-8183): a client funds a
  budget, a provider submits a deliverable, and one evaluator account fixed at creation completes the job (the provider
  is paid) or rejects it (the client is refunded). The draft says it is written to interoperate with that deployed
  kernel and is not an official extension of ERC-8183.
- **The evaluator.** A contract, `TapCircuitEvaluator`, that is both the evaluator and the hook of the job and has no
  discretion, no custody and no owner. The task is a deterministic run of a `tapnet/2` netlist, fixed as a job spec
  before the job is funded. The deliverable is a claim id (`bytes32(claimId)`) in the verifiable-execution game of
  another draft under review, *Large Netlists and Verifiable Execution* (pull request #74). The evaluator completes the
  job when the game reports the claim accepted, rejects it when the game reports it rejected, and does nothing
  otherwise. Ten rules (J-1 to J-10) cover binding before funding, expiry and challenge windows, gas, re-entry and the
  pinned kernel.
- **Scope.** Only deterministic runs. Text generation, retrieval, human judgement and any notion of quality are out of
  scope. Settlement takes days under any realistic game parameters, so it is meant for batch results that third
  parties will read, not for interactive calls.

## Why TapeAPI ships no code for it

Each reason is in the draft's own text or in the record of its assets:

- **The Solidity reference is not a deployment.** At `d1b19ae` the draft's assets include a Solidity reference (a
  Foundry project with the evaluator contract, run against the deployed kernel on a local fork), besides the Python model
  and vectors. The draft marks it **not audited and not deployed**, and its tests use a stand-in game (`MockGame`); an
  adapter for the game of #74 is not written. TapeAPI does not run, ship or vouch for it.
- **Nothing is deployed.** Its Deployments section says nothing under it is deployed, on any chain. The game it reads
  is specified in #74, itself a submitted draft (in review), and no deployment of such a game is listed. One
  precondition is still open in the draft (Pre-1: whether the game's `maxSettlementSeconds` is a real upper bound).
- **The kernel is upgradeable.** The facts the draft relies on were measured on a local fork at block 129,352,831, and
  the items left open then were measured again on 2026-10-29 at block 130,339,400 (M-5); they hold for the
  implementation of those blocks; the kernel's proxy can be upgraded by its owner (a 2-of-3 Safe when it
  was read). The draft forbids presenting any implementation as conforming until those facts are measured again and
  recorded, and asks tools to show earlier evaluators as unverified. A TapeAPI tool for job specs would have nothing to
  check against, and would read as a statement about one kernel implementation.
- **No demand evidence.** The author's overview of these agent drafts lists, among its known limits, that there is no
  demand evidence for circuit jobs.

The draft now has a Solidity reference at a fixed commit and a recorded re-measurement, but both are about a stand-in game
and a local fork. If the rest changes (#74 merged, a deployment measured again for the implementation in use, and people
asking for it), TapeAPI can look again. Nothing is promised here.

## How it relates to what TapeAPI ships

- **Receipts.** A TapeAPI receipt (TAPI-21 §3.5) is a service's signed statement about request and answer bytes. In a
  circuit job the deliverable is a claim id in the game, not a TapeAPI receipt, and the evaluator reads only the game's
  state. A receipt's hash fits the kernel's `bytes32` slots like any other reference, but nothing in TapeAPI writes one
  there. See [Receipts and payment protocols](receipts-and-payment-protocols.md), section 5.
- **Agent Passport.** [Agent Passport](passport.md) checks, read-only, whether an ERC-8004 identity and a TapeOut
  circuit belong to the same holder. Circuit Jobs writes to no identity, reputation or validation registry and reads no
  passport; an agent that offers a circuit as a service could have both, independently.
- **Policy circuits.** [Policy circuits](policy-circuit.md) re-run a `tapnet/1` spending rule off chain, checked by the
  party that wants to; a circuit job settles a `tapnet/2` run on chain through a game. Both use TapeOut circuits, for
  different purposes. No policy-binding subject kind names an ERC-8183 job.
- **Money.** TapeAPI holds no one's budget and sends no transaction for anyone here. The escrow that TapeAPI's own paid
  calls rely on is a different contract, and it is still not audited and not deployed.

## Status

- Draft: TAPs pull request #85 at head `d1b19ae`, submitted, now a draft PR, conditional, not merged; it builds on #74, also submitted (in review) and not merged.
- In TapeAPI: this page only. No package, no export, no command, no example.
