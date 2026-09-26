// Signing and broadcasting an EIP-1559 transaction, so an example can actually settle what it earned.
// The SDK deliberately holds no wallet: it builds calldata and hands it over. This is the small piece an
// operator needs on the other side, kept here (examples) rather than in the SDK.
// 签署并广播 EIP-1559 交易，让示例真的能把挣到的钱结算上链。SDK 刻意不持有钱包：它只构造调用数据。
// 这一小段是运营者那一侧需要的东西，因此放在示例里，而不是 SDK 里。
//
// Nonce, fees and gas come from the node; every send is confirmed by reading the receipt back.
// nonce、手续费与 gas 都向节点取；每次发送都读回执确认。
import { abi, sig, TapeAPIError } from '@tapeapi/sdk'

const { hexToBytes, toHex, keccak256, concatBytes, isAddress } = abi
const hex = (n) => (n === 0n || n === 0 ? '0x' : '0x' + BigInt(n).toString(16))
const bytesOf = (v) => {
  if (v === undefined || v === null || v === '0x' || v === 0n || v === 0) return new Uint8Array(0)
  if (v instanceof Uint8Array) return v
  const h = String(v).startsWith('0x') ? String(v).slice(2) : BigInt(v).toString(16)
  return hexToBytes('0x' + (h.length % 2 ? '0' + h : h))
}

// ---- RLP ----
function rlpLen(len, offset) {
  if (len < 56) return Uint8Array.of(offset + len)
  const b = bytesOf(BigInt(len))
  return concatBytes(Uint8Array.of(offset + 55 + b.length), b)
}
export function rlp(item) {
  if (Array.isArray(item)) {
    const body = concatBytes(...item.map(rlp))
    return concatBytes(rlpLen(body.length, 0xc0), body)
  }
  const b = bytesOf(item)
  if (b.length === 1 && b[0] < 0x80) return b
  return concatBytes(rlpLen(b.length, 0x80), b)
}

/**
 * Sign an EIP-1559 (type 2) transaction. Returns the raw bytes to broadcast.
 * 签署 EIP-1559（类型 2）交易，返回可广播的原始字节。
 */
export function signTx({ chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gas, to, value = 0n, data = '0x' }, privateKey) {
  if (!isAddress(to)) throw new TapeAPIError('ABI_INVALID', 'tx.to must be an address')
  const fields = [
    bytesOf(BigInt(chainId)), bytesOf(BigInt(nonce)), bytesOf(BigInt(maxPriorityFeePerGas)), bytesOf(BigInt(maxFeePerGas)),
    bytesOf(BigInt(gas)), hexToBytes(to), bytesOf(BigInt(value)), bytesOf(data), [],
  ]
  const unsigned = concatBytes(Uint8Array.of(0x02), rlp(fields))
  const { r, s, v } = sig.parseSignature(sig.signDigest(keccak256(unsigned), privateKey))
  // r and s are integers in RLP: no leading zero bytes, or nodes refuse the transaction as non-canonical (~1% of
  // signatures) (review M-5). / RLP 中 r、s 是整数：不得有前导零字节，否则约 1% 的签名会被节点当作非规范拒绝。
  const int = (b) => bytesOf(BigInt(toHex(b)))
  const signed = concatBytes(Uint8Array.of(0x02), rlp([...fields, bytesOf(BigInt(v - 27)), int(r), int(s)]))
  return toHex(signed)
}

/**
 * A sender bound to one key and one node. `send(tx)` fills in nonce, fees and gas, signs, broadcasts and waits
 * for the receipt; it throws when the transaction reverted.
 * 绑定一把密钥与一个节点的发送器：补全 nonce/手续费/gas，签名、广播并等待回执；交易回滚时抛错。
 */
export function createSender({ rpcUrl, privateKey, chainId = 56, fetch: fetchImpl = globalThis.fetch, confirmMs = 60_000, gasBuffer = 12n }) {
  const from = sig.privateKeyToAddress(privateKey)
  let id = 1
  const call = async (method, params) => {
    const res = await fetchImpl(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: id++, method, params }), signal: AbortSignal.timeout(15_000) })
    const j = await res.json()
    if (j.error) throw new TapeAPIError('RPC_ERROR', `${method}: ${j.error.message}`, { rpcCode: j.error.code })
    return j.result
  }
  return {
    from,
    async send(tx) {
      const [nonce, base, tip] = await Promise.all([
        call('eth_getTransactionCount', [from, 'pending']),
        call('eth_gasPrice', []),
        call('eth_maxPriorityFeePerGas', []).catch(() => null),   // a node without it: tip = gas price, never 0 / 节点不支持时小费取 gas 价格，绝不为 0
      ])
      const tipWei = tip === null ? BigInt(base) : BigInt(tip)
      const gas = tx.gas ?? await call('eth_estimateGas', [{ from, to: tx.to, data: tx.data, value: tx.value ?? '0x0' }])
      const maxFee = (BigInt(base) * (10n + gasBuffer)) / 10n + tipWei
      const raw = signTx({
        chainId, nonce: BigInt(nonce), maxPriorityFeePerGas: tipWei, maxFeePerGas: maxFee,
        gas: (BigInt(gas) * (10n + gasBuffer)) / 10n, to: tx.to, value: tx.value ?? 0n, data: tx.data,
      }, privateKey)
      const hash = await call('eth_sendRawTransaction', [raw])
      const deadline = Date.now() + confirmMs
      for (;;) {
        const r = await call('eth_getTransactionReceipt', [hash])
        if (r) {
          if (BigInt(r.status) !== 1n) throw new TapeAPIError('RPC_ERROR', `transaction ${hash} reverted`)
          return { hash, blockNumber: Number(BigInt(r.blockNumber)), gasUsed: Number(BigInt(r.gasUsed)) }
        }
        if (Date.now() > deadline) throw new TapeAPIError('RPC_UNAVAILABLE', `transaction ${hash} not mined within ${confirmMs} ms`)
        await new Promise((s) => setTimeout(s, 1500))
      }
    },
  }
}

/**
 * The settler loop TAP-22 §3.3.1 asks every paid provider to run: settle what is due before a consumer's
 * withdraw request becomes executable, and before a voucher or its session key expires.
 * `provider.dueSettlements()` decides what is due; this only sends it and reports.
 * TAP-22 §3.3.1 要求每个收费提供者运行的结算循环：在消费者的提现请求可执行之前、在凭证或会话密钥过期之前，把该收的收掉。
 * 由 `provider.dueSettlements()` 判断该结算什么，这里只负责发送与汇报。
 */
export function createSettler({ provider, sender, intervalMs = 60_000, marginS, log = () => {} }) {
  let timer = null
  let running = false
  const stats = { settled: 0, failed: 0, lastRun: 0 }
  async function runOnce() {
    if (running) return stats
    running = true
    try {
      const due = await provider.dueSettlements(marginS === undefined ? {} : { marginS })
      for (const v of due) {
        try {
          const receipt = await sender.send(provider.settleTx(v))
          stats.settled++
          log(`settled ${v.cumulative} for ${v.consumer} (${v.reason}) in block ${receipt.blockNumber}`)
        } catch (e) {
          stats.failed++
          log(`settle failed for ${v.consumer}: ${e.message}`)   // the next run tries again / 下一轮再试
        }
      }
      stats.lastRun = Date.now()
    } catch (e) {
      stats.failed++
      log(`dueSettlements failed: ${e.message}`)
    } finally { running = false }
    return stats
  }
  return {
    runOnce,
    stats: () => ({ ...stats }),
    start() { if (!timer) { timer = setInterval(() => { runOnce().catch(() => {}) }, intervalMs); timer.unref?.() } return this },
    stop() { if (timer) { clearInterval(timer); timer = null } },
  }
}
