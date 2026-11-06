# @tapeapi/interop

**Experimental, a prototype: visitor grants between apps.** A visitor's wallet signs a `VisitorGrant` (EIP-712, its
own domain "TapeAPI Visitor Grant", never TAP-11's) that lets app A call a few named methods of service B for a short
time (1 hour by default, 7 days at most), a bounded number of times, with no payment. App A adds the grant to its
request (`withGrant`); service B checks it (`verifyVisitorGrant`, `grantMethods`), counts it, takes revocations
(`grantRevokeHandler`, free method `grant_revoke`) and writes `result.grant` into its signed answer.

This package is **outside the compatibility promise**: it may change or go away in any minor release. It is not a
specification and not a TAP, and no service knows the format. The format text is
[spec/TAPI-28.md](https://github.com/BruceLanLan/tapeapi/blob/main/spec/TAPI-28.md) (experimental; where the two differ,
the code is the source of truth).

Boundaries:

- A cross-app call is an off-chain request, so a site that uses it is no longer "100% on-chain".
- Revocation and the count are enforced by the called service only, and are useless against a malicious one.
- A receipt proves what was signed, not that the data is right, nor which upstream model ran.
- Until shells check it, the visitor compares the caller named in the grant with the site the wallet names. How wallets
  display the grant has not been checked yet.
- Nothing in a grant moves money. The escrow that paid calls rely on is not audited and not deployed.

## Install

Not on npm: install from the GitHub release, the SDK first and from the same release (this package depends on
`@tapeapi/sdk`, which npm would otherwise look for in the registry, where neither package is):

```bash
npm install https://github.com/BruceLanLan/tapeapi/releases/download/v3.0.0/tapeapi-sdk-3.0.0.tgz
npm install https://github.com/BruceLanLan/tapeapi/releases/download/v3.0.0/tapeapi-interop-0.1.0.tgz
```

Experimental and outside the compatibility promise. It has a version of its own (0.1.0); the release's tag is the
SDK's version. Built from https://github.com/BruceLanLan/tapeapi (folder `interop/`).

ES modules; Node 22+, and browser-plain (no `node:` import, `Buffer` or `process`). TypeScript declarations are
included.

## Use

```js
import { prepareGrant, grantTypedData, withGrant, grantMethods, memoryGrantStore, chainReadsFromApi } from '@tapeapi/interop'
```

The guide is [Interop between apps and containers](https://github.com/BruceLanLan/tapeapi/blob/main/docs/guides/interop.md);
a local demo of two apps is
[examples/app-interop](https://github.com/BruceLanLan/tapeapi/tree/main/examples/app-interop). Self-test vectors:
`spec/vectors/interop-visitor-grant.json` and `spec/vectors/interop-visitor-grant-negative.json`, reproduced by
`spec/vectors/verify.py`.

It is a package of its own, never part of `@tapeapi/sdk`, so that the SDK carries none of it.

MIT licensed.
