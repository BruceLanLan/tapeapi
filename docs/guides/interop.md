# Interop between apps and containers (experimental)

Two local demos and one experimental package show how one TapeOut app or container can call another and check the
answer. **Everything here is experimental**: outside the compatibility promise, it may change or go away in any minor
release. The examples run on the SDK's fake chain and in tests only; they are not in the npm packages.

> Every cross-app call is an off-chain request, so the site is no longer "100% on-chain". Grants and revocations are
> enforced by the called service; until a contract layer exists they bind only whoever reads them, and are useless
> against a malicious service. A receipt proves what the other side signed, not that the data is right, nor which
> upstream model ran. Until shells check it, the user compares the site the wallet says the request comes from with
> the caller named in the grant. A grant contains no payment. Paid calls rely on an escrow that is not audited and not
> deployed, so they cannot be used on mainnet. Visitor grants have no TAP today: this is a prototype. TAP-11, TAP-13 and
> TAP-14 to TAP-18 are merged as Draft (merging is not adoption).

## 1. Container to container, with the existing API

[`examples/container-interop/`](../../examples/container-interop/) uses only what the SDK already has (no new format):

- **(a) a paid call inside a mandate's cap**: container A's agent calls container B's priced method through a session
  key; the extra calls above the cap are refused. The escrow behind it is not audited and not deployed.
- **(b) a task thread**: offer, accept, delivery and verdict between two containers, with A's own acceptance check (a
  validly signed delivery can still carry a wrong number; only A's check finds it).
- **(c) a private channel**: encrypted messages through a relay that stores ciphertext only, and a signed receipt for a
  request.

```bash
node examples/container-interop/run.mjs all
```

Its README ends with a table of the gaps this leaves (what a container cannot tell, refuse or revoke today).

## 2. App to app: the visitor grant (a prototype)

[`examples/app-interop/`](../../examples/app-interop/) has two apps: A finds B by name, reads B's manifest from chain,
calls a free method and a priced one, and checks every answer. The experimental package `@tapeapi/interop` (its own package, not part of the SDK) adds a
**visitor grant**: a visitor's wallet signs, in EIP-712 under its own domain "TapeAPI Visitor Grant" (never TAP-11's),
that app A may call a few named methods of service B for a short time (1 hour by default, 7 days at most), a bounded
number of times. The first field is a plain-language statement generated from the other fields.

- A adds a top-level `grant` member with a call proof signed by its one-off key (`withGrant`).
- B checks it in a fixed order, cheap checks first and chain reads last (`verifyVisitorGrant`, `grantMethods`), counts
  it, takes revocations (free method `grant_revoke`) and writes `result.grant` into its signed answer.
- Refusals are `BAD_REQUEST` with the message prefix `grant: <reason>` and no `error.data`.
- A retry of the same id after a lost answer gets the envelope B signed the first time, byte for byte (the server's
  experimental `ctx.onSigned` / `ctx.resend`), while B still keeps it; otherwise `grant: replayed`.
- Self-test vectors: `spec/vectors/interop-visitor-grant.json`, reproduced by `spec/vectors/verify.py`.
- The format, written for an independent implementation of B's checks: [TAPI-28](../../spec/TAPI-28.md)
  (experimental, not a TAP, may change in any minor release; the code is the source of truth).

```bash
node examples/app-interop/demo.mjs
node --test examples/app-interop/*.test.mjs
```

How wallets display the grant has **not been checked yet**. A local test page for that check is in
[`examples/app-interop/wallet-render/`](../../examples/app-interop/wallet-render/) (empty wallets, no transaction; the
page sends nothing anywhere).

## What this is not

- Not a login, an account or a credential of any kind.
- Not a TAP, and not a format any other service knows.
- Not on the home page, the directory or the playground.
- Nothing here pays, and nothing here is usable on mainnet with money.
