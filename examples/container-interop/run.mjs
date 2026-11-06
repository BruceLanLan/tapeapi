#!/usr/bin/env node
// Container-to-container interop on the SDK's FAKE chain (EXPERIMENTAL; no network, no cost, no real wallet, keys are fixtures):
//
//   node examples/container-interop/run.mjs spend     (a) A's agent calls B's paid method inside a signed cap
//   node examples/container-interop/run.mjs thread    (b) A sends B a task thread; B delivers; A accepts (or, with --lie, rejects)
//   node examples/container-interop/run.mjs channel   (c) A and B talk in a private channel (TAPI-26 v2 labels); B signs a receipt
//   node examples/container-interop/run.mjs all
//
// The scenarios are the functions the tests call (spend-call.mjs, task-thread.mjs, private-exchange.mjs). The escrow contract
// behind (a) is unaudited and not deployed: (a) is verified on a local chain model and in tests only, and is not available on
// mainnet. See README.md for what each scenario proves and what it does not.
// 在 SDK 的假链上跑容器↔容器互通（实验性；不联网、不花钱、不碰真实钱包，密钥都是夹具）。三个场景就是测试调用的那几个函数。
// (a) 背后的托管合约没有审计、也没有部署：(a) 只在本地链模型与测试里验证，主网不可用。每个场景证明什么、不证明什么见 README.md。
import { fileURLToPath } from 'node:url'
import { realpathSync } from 'node:fs'

const USAGE = `run.mjs: container-to-container interop on the fake chain (EXPERIMENTAL; fixtures only)

  node examples/container-interop/run.mjs spend [--cap <prices>] [--calls <n>]
  node examples/container-interop/run.mjs thread [--lie]
  node examples/container-interop/run.mjs channel
  node examples/container-interop/run.mjs all

Exit status: 0 the scenario ended as designed, 1 it did not or failed, 2 a usage mistake.
`

export async function main(argv = process.argv.slice(2), { stdout = (l) => console.log(l) } = {}) {
  const [cmd, ...rest] = argv
  const flags = new Map()
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (!['--cap', '--calls', '--lie'].includes(a)) { console.error(`run.mjs: unknown option ${a}\n\n${USAGE}`); return 2 }
    flags.set(a, a === '--lie' ? true : rest[++i])
  }
  if (!['spend', 'thread', 'channel', 'all'].includes(cmd)) { console.error(USAGE); return cmd === '--help' || cmd === '-h' ? 0 : 2 }
  const num = (name, dflt, min) => {
    if (!flags.has(name)) return dflt
    const v = Number(flags.get(name))
    return Number.isSafeInteger(v) && v >= min ? v : null
  }
  const cap = num('--cap', 10, 1), calls = num('--calls', 3, 0)
  if (cap === null || calls === null) { console.error(`run.mjs: --cap takes a whole number of at least 1 and --calls one of at least 0\n\n${USAGE}`); return 2 }
  let status = 0
  stdout('FAKE chain: nothing is on BNB Smart Chain, no real key, nothing leaves this process; its clock is fixed (the fake chain has its own calendar)')

  if (cmd === 'spend' || cmd === 'all') {
    const { createSpendWorld, runSpendCall, closeOut } = await import('./spend-call.mjs')
    stdout('\n(a) container A\'s agent calls container B\'s paid method inside a cap A\'s holder signed')
    const world = await createSpendWorld({ n: calls, cap: BigInt(cap) })
    try {
      const r = await runSpendCall({ world, cap: BigInt(cap), print: stdout })
      const c = await closeOut(world, r)
      stdout(`    A closed the channel out (${c.steps.join(', ') || 'nothing left to close'}): ${c.returned} returned of ${BigInt(cap) * 10_000n} funded`)
      // the thread check is a point-in-time check of the funded channel: with the cap spent in full there is nothing left to read
      const spentInFull = r.delivered.spend?.[0] && BigInt(r.delivered.spend[0].claimedAtDelivery) - BigInt(r.delivered.spend[0].claimedAtStart) === BigInt(cap) * 10_000n
      if ((!r.check.ok && !spentInFull) || r.receiptChecks.some((x) => !x.ok)) status = 1
    } finally { world.close() }
  }
  if (cmd === 'thread' || cmd === 'all') {
    const { runTaskThread, misreportingTask } = await import('./task-thread.mjs')
    const { createInteropWorld } = await import('./world.mjs')
    for (const lie of cmd === 'all' ? [false, true] : [flags.has('--lie')]) {
      stdout(`\n(b) container A sends container B a task thread${lie ? ' (B misreports what S answered)' : ''}`)
      const world = await createInteropWorld({ channels: false, ...(lie ? { agentOptions: { tasks: { 'chain.block-height': misreportingTask() } } } : {}) })
      try {
        const r = await runTaskThread({ world, print: stdout })
        const expected = lie ? 'Rejected' : 'Settled'
        if (r.final.state !== expected) status = 1
      } finally { world.close() }
    }
  }
  if (cmd === 'channel' || cmd === 'all') {
    const { createInteropWorld } = await import('./world.mjs')
    const { openChannel, callOverChannel, relayHoldings } = await import('./private-exchange.mjs')
    stdout('\n(c) containers A and B in a private channel (TAPI-26 v2 labels); B answers with a signed receipt')
    const world = await createInteropWorld()
    try {
      const chan = await openChannel({ world, print: stdout })
      const r = await callOverChannel({ world, chan, print: stdout })
      const leaked = relayHoldings(world).some((t) => t.includes('widget') || t.includes('quote'))
      stdout(`   the relay holds ${relayHoldings(world).length} wire message(s); the request text appears in none: ${!leaked}`)
      if (!r.check.ok || leaked) status = 1
    } finally { world.close() }
  }
  stdout(status === 0 ? '\nok' : '\nFAILED')
  return status
}
const self = (() => { try { return realpathSync(fileURLToPath(import.meta.url)) } catch { return null } })()
const argv1 = (() => { try { return process.argv[1] && realpathSync(process.argv[1]) } catch { return null } })()
if (self && self === argv1) main().then((c) => process.exit(c), (e) => { console.error(`run.mjs: ${e?.code ? e.code + ': ' : ''}${e?.message ?? e}`); process.exit(1) })
