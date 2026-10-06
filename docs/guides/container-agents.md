# Container agents (experimental)

A container agent is one TapeOut container doing a task for another: container + agent = container agent. The holder
of the first container signs a mandate naming the second, the agent signs what it delivers, and anyone can check the
whole exchange against the chain. (Looking for tools that an AI model in a browser can call? That is a different
feature: [AI agents](agents.md).)

## What it is, and what it is not

Version 1.7 ships **phase 0**, through the subpath `@tapeapi/sdk/agent`:

- **A mandate is a signed statement, not a gate.** The holder of the principal container signs, in EIP-712: which agent
  container, which task (by hash), which services the agent may call, from when until when. Nothing on chain enforces
  any of it. Every check result says `enforcement: 'none'`.
- **It authorises no money.** Because nothing enforces a limit, a mandate that names any amount or asset is refused:
  every `cap` and `feeCap` must be `0`, every `token` and `feeToken` the zero address, and `subdelegate` must be
  `false` (problem `phase0-no-funds` or `subdelegate-not-allowed`). The SDK's own wallet payload and local signing
  refuse to build such a mandate in the first place.
- **Payment, if any, is a plain transfer.** The SDK builds the unsigned transfer to the agent's container and checks
  it afterwards from the chain, read only. It never signs, sends, pays gas or holds funds.
- **Enforced limits are a later phase.** Caps that an agent cannot exceed need contracts that are not deployed (see
  [What comes next](#what-comes-next)).
- **Experimental.** The whole subpath is Experimental under [what 1.0 promises](upgrade-1.0.md): it may change in a 1.x
  minor release, and it is outside the 1.x compatibility promise. The formats follow two public discussions in
  TapeOutProtocol/TAPs, the Ideas [#40](https://github.com/TapeOutProtocol/TAPs/issues/40) (the mandate) and
  [#41](https://github.com/TapeOutProtocol/TAPs/issues/41) (the task protocol and agent listings), and may change with
  them. Neither has a TAP number.

## Who signs what

| Role | What it is | Who signs |
|---|---|---|
| Principal | The container that hires | The **current holder** of its circuit (an ECDSA key, or a contract holder through EIP-1271). A signer delegated in a manifest cannot sign for it. |
| Agent | The container that does the task, with a TAP-11 manifest | The signer its manifest publishes: every agent message is a signed response of one of its methods. |
| agentKey | A fresh address the agent makes for one order | Nobody, in phase 0: the mandate binds it, nothing uses it. |
| Provider | A service the agent calls for the task | Its own manifest signer, in the receipts the agent collects. |

The holder signs four EIP-712 types in the TAP-11 delegation domain (name `TapeAPI`, version `1`, the chain's id, the
DeWEB hub as `verifyingContract`): `TaskOffer`, `Mandate`, `TaskVerdict` and `MandateRevocation`. The type name is part
of every hash, so a signature over one type is never a signature over another, nor over a delegation. The digest the
holder signs is also the message's identity: `offerHash`, `mandateHash`, `verdictHash`. Test vectors are in
[`spec/vectors/container-agent.json`](../../spec/vectors/container-agent.json), and the full type declarations in
[`sdk/types/agent.d.ts`](../../sdk/types/agent.d.ts).

## The task thread

A task is a thread of messages, each `{ "v": 0, "kind": "tape.agent/<kind>", ... }`, in the order they were received:

```text
principal (its holder signs)                          agent (its manifest signer signs)

1. offer        TaskOffer + the task text   ------->
                                            <-------  2. accept    offerHash, a fresh agentKey
3. mandate      Mandate naming that agentKey ------->
                                                         the agent calls only the services in scope
                                            <-------  4. deliver   deliverableHash, hash-only receipts
5. acceptance   TaskVerdict: 1 accept, 2 reject ---->
6. revocation   MandateRevocation, at any time (or a list on the principal's site)
```

The states are `Offered`, `Accepted`, `Active`, `Delivered` and `Settled`, with the exits `Expired`, `Rejected` and
`Cancelled`. A few rules worth knowing before you build on it:

- The task text must hash to `offer.taskHash` (canonical JSON, then keccak256: `taskHashOf(task)`).
- The mandate must name the principal, task, mode and nonce of the offer (`mandate.nonce` equals `offer.nonce`, so one
  mandate cannot serve two threads), and the `agentKey` the agent announced in its accept.
- `notBefore` and `expires` are at most 30 days apart.
- The offer's `fee` is only a price statement; it authorises no payment, and the SDK says so in a console warning when
  it is not zero.
- A delivery after the offer's `deadline` is recorded and reported (`deliver-after-deadline`). After a rejection the
  agent may deliver again while the mandate is valid. There is no arbiter: a delivery left without a verdict past its
  own `exp` stays `Delivered` and is marked `unaccepted: true`.
- Payment is not a state. It is a fact on the chain, checked separately.
- A revocation, whether a message in the thread (wherever it sits) or the list on the principal's site, affects only
  what is signed after it. It sets the thread's revocation time; an agent message signed after that time is refused
  (`message-after-revocation`); a verdict is allowed whenever it was signed, so a delivery made before the revocation
  can still be accepted or rejected; and only the final check turns a thread still `Offered`, `Accepted` or `Active`
  into `Cancelled` (before `Expired`). The same revocation gives the same result by either path. In a thread,
  `mandate-revoked` is not reported.
- `quote`, `progress`, `reject`, `cancel` and `dispute` are names from Idea #41 that this version does not implement: a
  thread that carries one is refused (`kind-not-implemented`).

How the messages travel is up to the two parties. In the example below, each agent message is the signed answer of one
of the agent's methods (`task_offer`, `task_mandate`, `task_deliver`, `task_status`).

## Run it in three minutes

The example in [`examples/agent-service/`](../../examples/agent-service/) runs a whole job offline: a principal
container, an agent container and two provider containers on the SDK's fake chain, inside one process. No network, no
cost, no wallet. From a clean checkout (`npm install` once):

```bash
node examples/agent-service/hire.mjs                 # offer, accept, mandate, delivery, thread check, verdict
node examples/agent-service/hire.mjs --same-holder   # the same job, but both containers have one holder
node examples/agent-service/hire.mjs --pay           # also builds the payment as unsigned transactions
```

An excerpt of a run of the first command (the full output also prints every field of the three payloads a wallet
would be asked to sign; here and below, 32-byte hashes are shortened with `…`):

```text
2. accept: agentKey 0x777C98D739d42C482B9F96E1F1B251f8bD95473F (made for this order), valid until 1791003600
3. mandate: what a wallet would be asked to sign (a statement, not a gate: enforcement none)
   typed data Mandate (domain TapeAPI 1, chain 56, hub 0x1010101010101010101010101010101010101010)
     ...
     scope: [{"provider":"0x5e5E5e5e5E5e5E5E5e5E5E5e5e5E5E5E5e5E5E5e","token":"0x0000000000000000000000000000000000000000","cap":"0"}]
     feeToken: 0x0000000000000000000000000000000000000000
     feeCap: 0
     ...
   console notice (not sent to the wallet): phase 0: this mandate authorises no amount and no asset; it is only a verifiable record that you asked this agent to act for your container on this task
   the agent verified the mandate and started: state working
4. delivery: 1 upstream receipt(s), deliverable hash matches; deliverable (data): {"kind":"chain.block-height","chain":"bsc","blockNumber":62000000,...}
5. thread: state Delivered  ok true  enforcement none  selfHire false
   ...
   thread: state Settled  ok true  enforcement none  selfHire false
     verdict accepted (verdictHash 0xafdd669c…7d7521)
```

The script exits with 0 when the thread ends `Settled`. Everything in it is a fixture of the fake chain: the hub
`0x1010…` and the containers exist nowhere else (the real hub is in the [introduction](introduction.md#on-chain-addresses)),
and the fake chain has its own fixed clock. The `agentKey` is made fresh for every order, so it and the hashes that
depend on it differ on every run.

With `--same-holder`, the thread still verifies, and the check says who is behind it:

```text
5. thread: state Delivered  ok true  enforcement none  selfHire true (same-holder)
```

A self-hire is flagged, never hidden and never refused: the protocol cannot prevent it. Reputation rules should leave
such threads out.

The keys `hire.mjs` signs with are the fake chain's test fixtures. Never use them on a real chain, and never put a real
wallet's key into the example: a real principal signs the same payloads in a wallet, as below.

## In your own code

Install the SDK as in [Call a service](consume.md); the agent functions come from the subpath `@tapeapi/sdk/agent`.
Every check reads the chain, so the client needs nodes of at least two independent operators (decisive reads are made
under strict agreement); a single-node client is refused.

Since 1.8 every read of one check (`verifyMandate`, `verifyTaskThread`, `verifyEvidence`, `readRevocations`,
`identityOf`) is made at one pinned block, chosen as TAP-10 §5.3 says (the second-highest operator head minus 2): the
principal's identity and holder, a contract holder's EIP-1271 answer, the site store and payment contract
implementations, and the revocation list. A node too far behind (`stale-block`) or nodes on another chain
(`wrong-chain`) make the check throw; they are never reported as a problem of a message. The principal is resolved as
TAP-10 §4.3 says: `token()`, the factory's `isCPU`, the processor number, the container opener's `accountOf`, then
`ownerOf` for the holder.

The agent and the providers are resolved by the client's `resolve` (or the kit's `resolve` option). The draft TAP asks
for TAP-11 §2, which `createTapeAPI({ conform: 'tap10' })` implements (one pinned block per resolution, `ownerOf` and
EIP-1271 under strict agreement); a default client resolves them as TapeAPI 1.x does. For a verifier that should follow
the draft, give the kit a conformance-mode client for resolution:

```js
const strict = createTapeAPI({ rpcUrls, quorum: 2, conform: 'tap10' })
const kit = createAgentKit(api, { resolve: (container) => strict.resolve(container) })
```

### Sign a mandate

The holder signs in a wallet. Your console builds the payload, shows what the wallet cannot, and sends the wallet only
the payload:

```js
import { createTapeAPI } from '@tapeapi/sdk'
import { createAgentKit, MODE_PAY, taskHashOf, mandateTypedData, forWallet } from '@tapeapi/sdk/agent'

const api = createTapeAPI({
  rpcUrls: ['https://bsc-dataseed.bnbchain.org', 'https://bsc-mainnet.public.blastapi.io', 'https://rpc-bsc.48.club'],
  quorum: 2,
})
const kit = createAgentKit(api)
const { chainId, hub } = kit                         // what this console is configured for

const ZERO = '0x0000000000000000000000000000000000000000'
const PRINCIPAL = '0x000000000000000000000000000000000000a001'   // your container
const AGENT = '0x000000000000000000000000000000000000a002'       // the agent's container
const AGENT_KEY = '0x000000000000000000000000000000000000a003'   // the agentKey from the agent's accept
const PROVIDER = '0x000000000000000000000000000000000000a004'    // a service the agent may call

const now = Math.floor(Date.now() / 1000)
const task = { kind: 'chain.block-height', chain: 'bsc', spec: 'Read the BNB Smart Chain block height' }
const mandate = {
  principal: PRINCIPAL, agent: AGENT, agentKey: AGENT_KEY, mode: MODE_PAY, taskHash: taskHashOf(task),
  scope: [{ provider: PROVIDER, token: ZERO, cap: '0' }],   // phase 0: zero token, cap 0
  feeToken: ZERO, feeCap: '0',
  notBefore: now - 60, expires: now + 86_400,               // at most 30 days apart
  nonce: '1',                                               // the offer's nonce
  subdelegate: false,
}
const td = mandateTypedData(chainId, hub, mandate, { task })
const { payload, warnings, display } = forWallet(td, { chainId, hub })
console.log(Object.keys(payload))   // [ 'domain', 'types', 'primaryType', 'message' ]
console.log(warnings[0])            // phase 0: this mandate authorises no amount and no asset; ...
// In the holder's browser wallet:
// const sig = await ethereum.request({ method: 'eth_signTypedData_v4', params: [holderAddress, JSON.stringify(payload)] })
```

Replace the four addresses with real ones. `display` holds the task text (checked against `taskHash`) and the two
dates in words: show them next to the wallet prompt, because a wallet shows `taskHash` only as 32 bytes.

**Why `forWallet` needs `{ chainId, hub }`.** `forWallet` rebuilds the payload with the SDK and refuses anything that
differs from what the SDK builds (an extra type field, an edited domain shape), and it drops `warnings` and `display`,
which are for your console only and are neither hashed nor signed. But it can only rebuild from the domain it is given:
on its own it cannot notice a payload switched to another chain or another hub, where the signature could then be
replayed. So the console passes the chain and hub it is configured for, never values read from the payload, and a
missing or different one is refused:

```text
forWallet(td)                       -> AGENT_INVALID: forWallet: the holder's console must pass the chainId and hub it expects: forWallet(td, { chainId, hub })
forWallet(td, { chainId: 97, hub }) -> AGENT_INVALID: forWallet: the payload is for chain 56, the console expects 97
```

A mandate that names an amount does not get that far:

```text
mandateTypedData(chainId, hub, { ...mandate, feeCap: '1000' })
  -> AGENT_INVALID (data.reason 'phase0-no-funds'): mandateTypedData: phase 0 has no enforcement: every scope cap and feeCap must be 0 ...
```

This gate guards against mistakes, not against a malicious console: the digest can always be computed and signed
without this SDK. The holder's real defence is what the wallet shows: `feeToken` and every `token` the zero address,
every `cap` and `feeCap` `0`, `subdelegate` `false`.

`taskOfferTypedData`, `taskVerdictTypedData` and `mandateRevocationTypedData` work the same way and go through
`forWallet` too.

### Check a task thread

Either party, or anyone holding the messages, can check a thread:

```js
import { createAgentKit, plainText } from '@tapeapi/sdk/agent'

const kit = createAgentKit(api, { nonces: new Map() })
const check = await kit.verifyTaskThread(messages)   // the messages, in the order they were received
console.log(check.state, check.ok, check.enforcement, check.selfHire, check.selfHireReasons)
for (const p of check.problems) console.log(p.code, plainText(p.message))
```

On the thread `hire.mjs` produces, this prints `Settled true none false []`. Change one word of the task text and it
prints `null false none false []` followed by the problems, starting with
`task-hash-mismatch messages[0]: the task text does not hash to offer.taskHash`. (On the example's fake chain the kit
is also given the world's fixed clock: `createAgentKit(api, { clock })`.)

The result also carries the two parties (`principal`, `agent`: container address, the on-chain name read from the
chain's processor table (since 1.8 always found; 1.7 gave `null` for a processor outside the SDK's snapshot), and the
holder), each delivery with its evidence check, the verdict and any revocation. A name taken from the
agent's manifest appears only as `agent.displayName` with `untrusted: true`. Show any text a counterparty wrote with
`plainText`, which removes invisible and control characters.

Two stores decide what a kit can notice over time. `nonces` (a `Map`, or a store whose `setIfAbsent(key, value)`
returns the previous value in one step) is how nonce reuse is found: only whoever keeps it can see it. `revocationFloor`
(`{ get, set }`) remembers the newest revocation list seen per principal. Both default to memory; a service that runs
for long should keep them in storage that outlives the process.

An agent checks the mandate itself before it starts work, naming the key it announced and its own container:

```js
const v = await kit.verifyMandate(mandateMessage, { agentKey, agent: myContainer })
if (!v.ok) throw new Error(v.problems.map((p) => p.code).join(', '))
```

### What a verifier refuses as malformed

Messages are read in the JSON forms of the draft TAP (§3.7), never leniently (since 1.8; no hash changed). A message
that breaks them is `mandate-malformed` (a mandate) or `message-malformed` (any other message):

- a `bytes32` (a task hash, a mandate hash, a reason hash) is `0x` and 64 **lower-case** hex digits;
- a `uint256` (`nonce`, `fee`, `feeCap`, a scope `cap`) is a decimal **string** without leading zeros: a JSON number or
  a bigint received in a message is refused;
- a time is a whole number of Unix seconds from 0 to 2^53 − 1, so an agent message whose `ts` or `result.exp` is
  negative is refused; an agent message's receipt also needs the TAP-13 method, `params` (an object when present), an
  `id` of 1 to 128 code units and a 65-byte `sig`;
- every member is present: a verdict without `reasonHash` is refused (write 32 zero bytes when there is no reason);
- a hash-only receipt in a delivery's evidence needs a JSON boolean `ok` (a string `"true"` or a missing `ok` is
  `receipt-not-hash-only`, never read as `false`), both hashes in the `bytes32` form, `ts` in the time form, and an `id` of 1 to 128 code units (the empty `id` of TAP-13
  §8 binding rule 1 is allowed only when `ok` is `false`).

The builders are unchanged: `mandateTypedData`, `taskOfferTypedData`, the hash and `sign*` functions still take a number
or a bigint for a `uint256` and write the decimal string, and still read a missing `reasonHash` as zero; only a
lower-case `bytes32` (or 32 bytes as a `Uint8Array`) is taken. `agentMessageProblem(receipt, kind, agent)` and
`hashOnlyReceiptProblem(receipt)` check the two receipt forms without the chain. The cases are vectors:
`spec/vectors/container-agent.json`, member `inputForms`.

### Check a payment

The recipient of a payment is always read from the chain, never taken from a text:

```js
import { createPaymentKit } from '@tapeapi/sdk/agent'

const pay = createPaymentKit(api)
const { circuits, tokenId } = await kit.identityOf(agentContainer)   // read from the chain
const tx = await pay.transferToContainer({ circuits, tokenId, token, amount: '1000000000000000000' })
for (const line of tx.summary) console.log(line)   // every field in words: compare it with the wallet
// the wallet signs and sends { to: tx.to, data: tx.data, value: tx.value }
```

On the example's fake chain the summary reads:

```text
to: 0xB0B0b0B0B0B0B0b0B0B0B0b0b0b0b0B0b0b0B0B0
value: 0 (smallest unit of the native coin)
call: transfer(to = 0xa6a6A6a6a6a6A6A6A6a6A6a6a6a6a6a6a6a6a6A6, amount = 1000000000000000000 (smallest unit, 18 decimals) = 1 tokens) on token 0xB0B0b0B0B0B0B0b0B0B0B0b0b0b0b0B0b0b0B0B0
recipient container: 0xa6a6A6a6a6a6A6A6A6a6A6a6a6a6a6a6a6a6a6A6, circuit 0x5050505050505050505050505050505050505050 #12, held by 0x7564105E977516C53bE337314c7E53838967bDaC
```

The rules behind it:

- The recipient is named by `{ circuits, tokenId }` or by an on-chain name (`{ name: '<#ID>.<processor>.tape' }`),
  then derived through the factory and the hub. An address passed in (`to`, `container`, `recipient`, `address`) is
  refused with `recipient-not-from-chain`, and so is a #ID nobody holds (`no-such-token`): the hub derives an address
  for any #ID, and nobody could ever move a payment sent to an unminted one.
- Only `transfer` is built, never `approve`. `decimals()` is read from the chain. `nativeToContainer` sends the native
  coin, from the holder's wallet straight to the container only.
- `viaContainer({ from, tx, value })` wraps an ERC-20 transfer in the payer container's `execute`, and accepts only the
  unedited object `transferToContainer` returned. The inner value is always 0 (a native coin is never sent through a
  container). The optional `value` is the **outer** value of the transaction: the TapeOut fee that the container's
  `execute` may require, in the chain's native coin. On BNB Smart Chain mainnet, a read-only test at the time of writing
  found that every call to a TapeOut container's `execute` has to carry 0.0002 BNB, which goes to TapeOut (the excess
  is refunded to the sender) and never to the recipient, and a smaller payment reverts with
  `0xafd49700(paid, required)`. The fee has no public getter, and the SDK neither reads it nor hard-codes it: simulate
  the transaction (`eth_call` or your wallet's simulation) and read the amount from that revert data, then pass it as
  `value`, a whole number in the smallest unit (`'200000000000000'` is 0.0002 BNB). It is a fact about the deployed
  contracts at one time, not part of any specification, and it may change. Without `value` the transaction keeps the
  value 0, and the summary says in its last line that a call without the fee may revert. 1.7.0 and 1.7.1 had no `value`
  option, so their `viaContainer` transactions revert on BNB Smart Chain mainnet.
- After the transfer, send the agent a TapeSend message that carries it as an asset attachment (`encodeContent`), and
  send it first: the payment counts only if no other message from you reaches that recipient in between and the
  message follows within 3,600 seconds. `paymentOrder()` tracks this in your client (record the transfer, check the
  next message carries it, `dropTransfer` or `replaceTransfer` when it reverts, is cancelled or sped up).

The recipient checks it from the chain:

```js
const msg = await pay.readMessage({ recipient: agentContainer, inboxIndex })
for (const r of await pay.verifyAttachments(msg)) console.log(r.attachment.type, r.attachment.amount, r.result)
// erc20 1000000000000000000 ok
```

Only `ok` proves that the sender's wallet paid this amount to this container for this message. The other results, from
the fifteen steps of TAP-10 §19: `pending` (not final yet), `mismatch` (no such transfer, it reverted, or the amount or
recipient differs), `unavailable` (the chain cannot answer now), `unverifiable` (a native transfer that did not go
straight to the container), `late` (the transfer came after the message), `indirect` (the message was written through
a contract), `third-party` (someone else paid), `stale` (more than 3,600 seconds between transfer and message),
`crowded` (more than 60 messages in between), `not-first` (the sender wrote to this recipient in between),
`other-chain`, and `repeat` (the same transaction attached twice). The SDK has no list of known tokens: pass
`createPaymentKit(api, { tokenAllowed })` to mark your own, otherwise every token is shown as neutral.

## From the command line

`tapeapi-verify`, the command-line tool that ships with the SDK, checks a thread saved as a JSON array of its messages:

```bash
tapeapi-verify task thread.json
tapeapi-verify task thread.json --payment <agent container> <inbox index>
tapeapi-verify task thread.json --rpc https://node-a.example,https://node-b.example
```

Without installing anything, use `npx -y --package=https://github.com/BruceLanLan/tapeapi/releases/download/v1.8.0/tapeapi-sdk-1.8.0.tgz tapeapi-verify task thread.json`;
in a checkout, `node sdk/bin/tapeapi-verify.js task thread.json`.

- `--payment <recipient> <index>` also checks the TapeSend message at that index in the recipient's inbox. The recipient
  must be the thread's agent and the sender the thread's principal. Public (unsealed) messages only.
- `--rpc` takes a comma-separated list of nodes from at least two operators. The default is three public nodes of
  different operators.
- Exit status: `0` the thread verifies (and the payment, with `--payment`), `1` it does not or the chain cannot be read,
  `2` a usage mistake.
- Each run starts with an empty nonce store and revocation floor, so a one-shot check cannot see a reused nonce or an
  older revocation list put back.

The report for the example's thread, produced by the same command code run against the example's offline chain:

```text
tapeapi-verify task: 5 message(s), chain 56   EXPERIMENTAL
state:       Settled
result:      ok
enforcement: none (phase 0: a mandate is a signed statement; nothing enforces it)
self-hire:   no
principal:   0x86DDaEF00401E3F10418398D67D7189fc458eA95  name 11.7.tape  holder 0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A
agent:       0xa6a6A6a6a6a6A6A6A6a6A6a6a6a6a6a6a6a6a6A6  name 12.7.tape  signer 0x1563915e194D8CfBA1943570603F7606A3115508
             manifest name (untrusted: the agent wrote it, it is not an identity): "Report agent"
...
verdict:     accepted at 1791000000 (verdictHash 0x69bb45f4…df05c3)
revocation:  none
problems:    none
payment:     message 0 in the inbox of 0xa6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6: ok
  erc20 0xb0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0 1000000000000000000 in 0xaaaaaaaa…aaaaa1: ok
  the message body names the thread's verdictHash (information only)
```

The `revocation` line gives the thread's revocation time, when a revocation applies: agent messages signed after it
are refused, and nothing else. It does not say the thread was cancelled; the `state` line does. A thread delivered and
accepted before a revocation reads `result: ok` with `revocation: at <issued> (site); ...`.

## What a check proves, and what it does not

A thread that verifies proves:

- **Who signed what.** The offer, the mandate, the verdict and any revocation were signed by the current holder of the
  principal container's circuit. The accept and the delivery were signed by the signer the agent container's current
  manifest publishes.
- **That the pieces belong together.** The task text matches the offer, the mandate matches the offer and the key the
  agent announced, the delivery names this mandate, the verdict names this delivery.
- **Who answered the agent's upstream calls.** Each receipt in the delivery was signed by the signer that the listed
  container publishes now, the container is in the mandate's scope, and the time the receipt states is inside the
  mandate's window. The receipts carry hashes only, so the principal's requests are not published.
- **That a payment reached the agent's container**, when `verifyAttachments` says `ok`: the sender's wallet paid that
  amount of that token to that container, and the message carrying it came first and within the hour.

It does not prove:

- **That the work is right.** Not that the calls were needed, that the answers were right, or that the deliverable is
  correct or complete. Every evidence check carries these words in `proves` and `doesNotProve`. The task hash binds the
  task text, not the result.
- **That the agent kept to the mandate.** Nothing stops an agent from calling other services, or from spending money
  it can reach some other way. The services it calls do not even see the mandate in phase 0.
- **That the two sides are different people.** `selfHire` marks a self-hire (`same-container`, `same-holder`,
  `agent-signer-is-principal-holder`, `agent-key-is-principal-holder`); it does not block one.
- **Anything about the payment beyond the transfer.** A phase-0 payment is unrelated to the mandate: before paying, the
  holder sees an ordinary transfer.

## Revoking a mandate

There are two ways, and a verifier applies both:

1. **A message.** Sign a `MandateRevocation` and send it to the agent, or put it in the thread. It costs nothing and
   binds only whoever receives it.
2. **A list on your container's site**, at `.well-known/tapeapi-mandates.json`. Anyone checking a mandate reads it.
   Writing it is one site transaction from the holder's wallet, which pays the gas.

A revocation lists up to 24 mandate hashes, and with `revokedBefore` it also revokes every mandate of that principal
whose `notBefore` is earlier (`0` revokes none by date). To revoke more than 24 at once, use the date. Build the file
with `revocationFileBytes`, which writes it compactly and checks it: the file must fit 4,096 bytes, and a
pretty-printed list of the maximum size would not.

```js
import { abi } from '@tapeapi/sdk'
import { mandateRevocationTypedData, forWallet, revocationFileBytes, MANDATES_KEY } from '@tapeapi/sdk/agent'

const revocation = { principal: PRINCIPAL, mandateHashes: [mandateHash], revokedBefore: 0, issued: Math.floor(Date.now() / 1000) }
const { payload } = forWallet(mandateRevocationTypedData(chainId, hub, revocation), { chainId, hub })
const sig = await ethereum.request({ method: 'eth_signTypedData_v4', params: [holderAddress, JSON.stringify(payload)] })
const bytes = revocationFileBytes({ chainId, revocation, sig })
const sha256 = '0x' + Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) => b.toString(16).padStart(2, '0')).join('')
const putFile = {                                    // for the holder's wallet to send
  to: api.addresses.siteRegistry, value: '0x0',
  data: abi.encodeCall('putFile', [PRINCIPAL, MANDATES_KEY, 'application/json', sha256, abi.toHex(bytes)]),
}
```

Once the list is on the site, `kit.readRevocations(PRINCIPAL)` returns `status: 'published'`, and checking the mandate
on its own (`kit.verifyMandate`) reports `mandate-revoked: revoked by the principal's holder at <issued> (site)`. In a
thread the list only sets the revocation time, as a revocation message does (see the task thread above).

How the list is read:

- It is read like a manifest, at the check's pinned block (the block the holder is read at): from the first site store
  of the chain that has any file for the container (one store per chain in this version), only while
  that store and the payment contract run code TAP-10 accepts; `chunkCount` 0 means no file; the bytes must match the
  size and SHA-256 the chain declares, must not begin with a byte order mark, and the current holder's signature must
  verify. `issued` may be at most 300 seconds ahead of the verifier's clock. A kit for a chain or a site store without
  such a list of accepted implementations is refused when it is created (`INVALID_ARGUMENT`).
- A verifier remembers the highest `issued` it has seen. An older list (someone put back a replaced one), or no list
  where one was seen before, makes every mandate of that principal `revocation-unavailable`: it fails closed instead of
  reading as "not revoked". A principal that never published one is `none-published`, which is not an error.
- To clear the list, publish an empty one with a higher `issued`. Do not delete the file.
- In a thread whose mandate was never applied (it is still `Offered` or `Accepted`), a revocation has no mandate hash to
  match, so it applies only by date (`revokedBefore` above 0). A revocation found while checking a mandate that was
  refused does not count.

## Problems and error codes

A check reports problems in `problems[].code`; it throws only for a mistake in your call or a chain read that failed.
A failure caused by the counterparty is a problem, never an exception; a failing node is an exception, never a verdict.

| Code | Where | Meaning |
|---|---|---|
| `phase0-no-funds`, `subdelegate-not-allowed` | mandate | A cap, a fee cap or a token is not zero, or sub-delegation is on. |
| `mandate-too-long` | mandate | `expires` is more than 30 days after `notBefore`. |
| `mandate-not-yet`, `mandate-expired` | mandate | Outside its window at the time of the check. In a thread the window is checked against the delivery time instead. |
| `agent-key-mismatch`, `agent-mismatch` | mandate | It names another key than the agent announced, or another agent. |
| `not-signed-by-holder` | holder messages | Not signed by the current holder of the principal's circuit. |
| `nonce-reused` | mandate | This kit's nonce store has seen another mandate with the same chain, principal and nonce. |
| `mandate-revoked`, `revocation-unavailable` | mandate | Revoked (reported by `verifyMandate`, never in a thread); or the principal's revocation list cannot be relied on. |
| `not-tapeout`, `no-such-token` | identity | TAP-10 §4.3: the address is not a TapeOut circuit container of this chain (`token()` fails or names another chain, the processor is not the factory's, the opener derives another address), or its processor has no circuit with that #ID. (1.7 used `not-a-container` and `wrong-chain` for some of these.) |
| `mandate-mismatch` | thread | The mandate's principal, task, mode or nonce differ from the offer, or a delivery names another mandate. |
| `task-hash-mismatch`, `offer-mismatch`, `offer-expired` | thread | The task text, the offer an accept names, or an accept after the offer's `exp`. |
| `out-of-order`, `message-malformed`, `kind-unknown`, `kind-not-implemented`, `thread-empty` | thread | A message in the wrong place, of the wrong shape (see "What a verifier refuses as malformed"), or of a kind this version does not implement. |
| `not-signed-by-agent`, `agent-unresolvable` | thread | An agent message not signed by the agent's published signer, or an agent that does not resolve (TAP-11 §2.3: a site status such as `not-opened` or `unpaid`, no manifest, an invalid manifest or delegation; a chain or node outcome throws instead). |
| `deliver-after-deadline`, `deliver-outside-mandate`, `deliver-before-accept`, `message-after-revocation` | thread | Timing of a delivery or of an agent message. The first is reported but the delivery is kept. |
| `verdict-mismatch`, `verdict-before-delivery`, `revocation-mismatch` | thread | A verdict for another delivery or issued before it, or a revocation that does not cover this thread. |
| `receipt-not-hash-only`, `receipt-repeated`, `receipt-provider-out-of-scope`, `receipt-outside-mandate`, `receipt-invalid`, `receipts-hash-mismatch`, `provider-unresolvable`, `evidence-malformed` | evidence | A receipt that is not hash-only, repeated, from a service outside the scope, outside the window, badly signed, or a bundle that does not match its hash. |

Thrown errors (`TapeAPIError`, details in `data`):

| Code | When |
|---|---|
| `AGENT_INVALID` | `mandateTypedData` or `signMandate` refuses a mandate with an amount, an asset or sub-delegation (`data.reason` `phase0-no-funds` or `subdelegate-not-allowed`); `forWallet` refuses a payload; a task text does not match its hash; a field has the wrong shape; `identityOf` is given an address that is not a container (`data.reason` is the problem code). |
| `INVALID_ARGUMENT` | A check needs nodes of at least two operators and the client has fewer, or no `rpcUrls`; `nonces` is neither a `Map` nor a `setIfAbsent` store; a payment builder refuses (`data.reason` `recipient-not-from-chain`, `no-such-token`, `not-tapeout`, `only-transfer`, `native-via-container-unverifiable`); `revocationFileBytes` gets a list over 4,096 bytes or a malformed signature. |
| `NOT_FOUND` | `readMessage` is given an inbox index that does not exist. |
| `RPC_STALE`, `RPC_UNAVAILABLE`, `RPC_DISAGREE`, and `INVALID_ARGUMENT` with `data.status` `wrong-chain` | The chain could not be read for a check: the pinned block is too far behind (`data.status` `stale-block`), nodes failed or disagreed, the processor number was not found within the scan budget (at most 256 `cpuAt` reads per processor looked up, per check; `unavailable`, and the next check goes on), or the nodes are on another chain. |

## Limits

- **No enforcement.** A mandate cannot stop the agent or a provider from doing anything. It is a verifiable record of
  what was entrusted, not a gate.
- **Checks use the current holder.** When a circuit changes hands, the messages the former holder signed stop
  verifying, and so do old threads; the same holds for TAP-11 delegations. A receipt from a provider that has since
  changed its signer stops verifying too.
- **A revocation binds only whoever reads it.** A message binds its recipient; the site list costs a transaction.
- **A revocation affects only what is signed after it.** Checked again after the holder lists its mandate, a thread
  that was delivered and accepted before the revocation still reads `Settled`; only agent messages signed after the
  revocation's `issued` are refused. (Before 1.7.1 a site list turned such a thread into `Cancelled` with
  `mandate-revoked`.) Times are what the signers claim: the agent's `ts` and the holder's `issued` are not checked
  against the chain. `verifyTaskThread(messages, { readSite: false })` checks a thread without reading the list.
- **Nonce reuse is visible only to whoever keeps the nonce store**, and only if the principal uses a new nonce for
  every offer.
- **No arbiter.** A principal can reject or stay silent; the agent can only keep its evidence (`unaccepted`).
- **Self-hire is marked, not prevented.**
- **The wallet does not show the task text.** It shows the twelve mandate fields and the scope, with `taskHash` as 32
  bytes. A wallet that supports `eth_signTypedData_v4` shows them field by field; how particular wallets render them
  has not been tested. Signing mandates whose amounts are always zero can teach a habit of clicking through; the
  console notice and the zero-address tokens are there against that.
- **Acceptances and revocations do not expire.** They carry only `issued`, for ordering.
- **Payment checks need old block data.** They read the receipts of the transfer's block; if public nodes stop serving
  old receipts, a check made long afterwards becomes `unavailable`.
- **Our reading of TAP-10 §19, step 14.** When an earlier message to the same recipient, sent after the transfer, was
  itself written through a contract (`indirect`), the check skips it: its sending container has been compared already,
  and it has no sending wallet to compare. We read the step's "cannot determine the wallet" as TAP-10 §18.5 step 1
  failing, which §18.5 and §19 keep apart from `indirect`. This is our reading of TAP-10, and we have asked the
  editors to confirm it. What it leaves open: a payer who first sent the same recipient another message through a
  contract is caught by its container, not by its wallet.

## What comes next

Nothing beyond phase 0 is built. Idea [#40](https://github.com/TapeOutProtocol/TAPs/issues/40) sketches two further
phases:

- **Phase 1, payment channels.** The principal funds a channel per provider and authorises the agent's key as a
  session key on it, so the channel balance is the cap and the session's expiry the time limit. It builds on the
  payment-voucher design of Idea #38 (TapeAPI's experimental TAPI-22), whose escrow contract is not deployed and has no
  third-party audit. Even then, #40 says plainly, a session key cannot be revoked, only outlived.
- **Phase 2, a spending vault.** A new, non-upgradeable contract that holds a deposit and lets the agent's key call
  whitelisted targets within per-call and total caps, with immediate revocation. It needs a new contract and an
  independent audit before any deployment.

The mandate already carries the fields those phases need (`scope[].token`, `scope[].cap`, `feeToken`, `feeCap`,
`subdelegate`), so that a later phase need not change the type and invalidate signed mandates. In phase 0 they must
stay zero, and the SDK's console warning for a mandate that names an amount says why: a later phase may treat it as a
spending authorisation. The formats may still change with the discussion in #40 and #41.
