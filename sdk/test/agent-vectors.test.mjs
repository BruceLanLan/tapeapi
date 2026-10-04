// spec/vectors/container-agent.json (container agents, phase 0, experimental): the reference SDK reproduces every type
// hash, intermediate hash, digest and signature. spec/vectors/verify.py (Python) and contracts/test/AgentMandateTypehash.t.sol
// (Solidity) check the same file independently. / 三方一致：JS、Python、Solidity 核对同一份向量。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as agent from '../src/agent-sig.js'
import * as sig from '../src/sig.js'
import { toHex, keccak256, utf8ToBytes } from '../src/abi.js'

const { mandateHashOf, signMandate } = agent

test('spec/vectors/container-agent.json: the SDK reproduces every type hash, intermediate hash, digest and signature (verify.py and Solidity check the same file)', () => {
  const v = JSON.parse(readFileSync(new URL('../../spec/vectors/container-agent.json', import.meta.url), 'utf8'))
  const d = v.domain
  for (const [n, t] of Object.entries(v.types)) assert.equal(toHex(keccak256(utf8ToBytes(t))), v.typeHashes[n], n)
  assert.equal(agent.taskHashOf(v.task.value), v.task.taskHash)
  for (const c of v.mandates) {
    assert.deepEqual(c.scope.map((s) => toHex(agent.hashScope(s))), c.intermediate.scopeHashes, c.name)
    assert.equal(toHex(agent.hashMandate(c)), c.intermediate.structHash, c.name)
    assert.equal(mandateHashOf(d.chainId, d.verifyingContract, c), c.digest, c.name)
    assert.equal(signMandate(d.chainId, d.verifyingContract, c, v.holderKey, { allowFunds: true }), c.sig, c.name)
    assert.equal(sig.recoverAddress(c.digest, c.sig), v.holderAddress)
  }
  assert.equal(mandateHashOf(v.otherChain.chainId, d.verifyingContract, v.mandates[v.otherChain.mandate]), v.otherChain.digest)
  for (const [list, hashFn, digestFn] of [[v.offers, agent.hashTaskOffer, agent.taskOfferDigest], [v.verdicts, agent.hashTaskVerdict, agent.taskVerdictDigest], [v.revocations, agent.hashMandateRevocation, agent.mandateRevocationDigest]]) {
    for (const c of list) {
      assert.equal(toHex(hashFn(c)), c.structHash, c.name)
      assert.equal(toHex(digestFn(d.chainId, d.verifyingContract, c)), c.digest, c.name)
      assert.equal(sig.recoverAddress(c.digest, c.sig), v.holderAddress, c.name)
    }
  }
})
