// @experimental (phase 1) The enforcement backends: what bounds an agent key's spending on chain. A backend answers the
// limiter's questions about a voucher; the mandate, its rules, the record and the budget are the same for every backend.
// Any other value of `enforcement` is phase 0, as before. / 执行后端；其它取值一律是阶段 0
import { ENFORCEMENT_ESCROW_CHANNEL } from './agent-sig.js'
import { voucherDigest, recoverAddress } from './sig.js'
import { ENFORCEMENT_X402_BATCH, x402VoucherSigner } from './x402-batch.js'

// TAPI-22 escrow channels: the voucher is signed against the pinned escrow (its EIP-712 domain), which binds the channel
const escrowChannel = Object.freeze({
  name: ENFORCEMENT_ESCROW_CHANNEL,
  // who signed `voucher` on the pinned channel, or null
  voucherSigner({ chainId, pin, voucher: v }) {
    try { return recoverAddress(voucherDigest(chainId, pin.escrow, { consumer: v.consumer, provider: v.provider, cumulative: BigInt(v.cumulative), expires: v.expires }), v.sig) } catch { return null }
  },
  // the payer, payee and cumulative it names
  voucherTerms(v) { return { consumer: v.consumer, provider: v.provider, cumulative: v.cumulative } },
  onPinnedChannel() { return true },
})

// @experimental prototype: x402 batch-settlement channels (x402-batch.js); the pin names the settlement and channel id
const x402Batch = Object.freeze({
  name: ENFORCEMENT_X402_BATCH,
  voucherSigner({ chainId, pin, voucher }) { return x402VoucherSigner(chainId, pin.escrow, voucher) },
  voucherTerms(v) { return { consumer: v?.channelConfig?.payer, provider: v?.channelConfig?.receiver, cumulative: v?.voucher?.maxClaimableAmount } },
  onPinnedChannel({ pin, voucher }) { return typeof voucher?.voucher?.channelId === 'string' && voucher.voucher.channelId.toLowerCase() === pin.channelId },
})

const BACKENDS = new Map([[escrowChannel.name, escrowChannel], [x402Batch.name, x402Batch]])
export const ENFORCEMENTS = Object.freeze([...BACKENDS.keys()])
export function enforcementBackend(name) { return (typeof name === 'string' && BACKENDS.get(name)) || null }
