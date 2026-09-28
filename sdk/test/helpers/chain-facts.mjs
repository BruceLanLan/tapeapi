// What scripts/probe-chains.mjs reads on each chain, and how it is checked against sdk/src/chains.js. Pure: no network.
// sdk/test/chains.test.mjs pins the recorded answers (fixtures/chains-onchain.json) with problemsOf.
// scripts/probe-chains.mjs 在每条链上读到的事实，以及如何对照 sdk/src/chains.js 检查。纯函数，不联网。
import { fileURLToPath } from 'node:url'
import { CHAINS } from '../../src/chains.js'

export const FIXTURE = fileURLToPath(new URL('../fixtures/chains-onchain.json', import.meta.url))
// A site on X Layer: processor 230 "Nandout" #1, one file (index.html, 13,614 bytes), found by enumeration 2026-09-28.
// X Layer 上的一个网站（2026-09-28 枚举发现）。
export const L2_SITE = Object.freeze({ chainId: 196, tokenId: '1', processor: '230', path: 'index.html' })

/** Every way `facts` disagrees with chains.js ([] when none). / 事实与 chains.js 不符之处。 */
export function problemsOf(chainId, facts) {
  const c = CHAINS[chainId]; const p = []
  const lc = (a) => String(a).toLowerCase()
  if (facts.chainId !== chainId) p.push(`eth_chainId answered ${facts.chainId}`)
  for (const [name, f] of Object.entries(facts.contracts)) {
    if (!(f.codeBytes > 0)) p.push(`${name} ${f.address} has no code`)
    const allowed = c.expectedImpl[lc(f.address)]
    if (allowed && !allowed.includes(f.implementation)) p.push(`${name} implementation ${f.implementation} is not in expectedImpl (${allowed.join(', ')})`)
    if (!allowed && f.implementation) p.push(`${name} is a proxy (implementation ${f.implementation}) with no expectedImpl entry`)
  }
  if (!facts.isCPU0) p.push(`processor 0 ${facts.processor0} is not a TapeOut processor`)
  if (facts.hubAccountOf !== facts.openerAccountOf) p.push(`hub.accountOf ${facts.hubAccountOf} differs from opener.accountOf ${facts.openerAccountOf}`)
  if (facts.hubFactory !== lc(c.factory)) p.push(`hub.factory() ${facts.hubFactory} is not ${c.factory}`)
  if (facts.hubRegistry !== lc(c.erc6551Registry)) p.push(`hub.registry() ${facts.hubRegistry} is not ${c.erc6551Registry}`)
  if (facts.hubAccountImplementation !== lc(c.accountImplementation)) p.push(`hub.accountImplementation() ${facts.hubAccountImplementation} is not ${c.accountImplementation}`)
  if (lc(c.delegation.verifyingContract) !== lc(c.hub) || c.delegation.chainId !== chainId) p.push('delegation domain is not (this chainId, this hub)')
  return p
}
