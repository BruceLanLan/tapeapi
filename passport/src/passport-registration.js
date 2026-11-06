// @tapeapi/passport (@experimental): the registration file of §5, written and checked locally, and the read-only
// preparation `tapeapi init --passport` uses. Nothing here sends a transaction, asks for a signature or a key, or writes
// anywhere: the holder registers the identity and stores the file in the site with their own wallet, and pays for it.
// §5 登记文件的本地生成与自检，以及 tapeapi init --passport 用到的只读准备。这里不发交易、不索要签名或密钥、不往任何地方写：
// 身份登记与把文件写进站点都由持有人用自己的钱包完成，费用自付。
import { TapeAPIError } from '@tapeapi/sdk'
import { utf8ToBytes } from '@tapeapi/sdk/abi'
import {
  PASSPORT_CONFIG, PASSPORT_KEY, REGISTRATION_KEY, REGISTRATION_TYPE, MANIFEST_KEY, MAX_REGISTRATION_BYTES, Broken, Unavailable,
  addr, canonicalJson, parseRegistrationFile, listedAgentIds, gatewayLabel, decodeKey, normaliseInput, internal,
} from './passport-core.js'
import { liveReads, logsClient } from './passport-live.js'
import { reasonZh } from './passport-text.js'

const badArg = (m) => new TapeAPIError('INVALID_ARGUMENT', m)
const T = (en, zh) => ({ en, zh })
const LABEL_DOMAIN = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/

/**
 * R-3's form of the identity's agentURI: https://<gateway host label>.<gateway domain>/.well-known/agent-registration.json.
 * Another form is allowed and only gives the warning agent-uri-not-canonical. / R-3 的 agentURI 形式；别的形式只给警告。
 */
export function canonicalAgentUri(tokenId, processorNumber, gatewayDomain) {
  if (typeof gatewayDomain !== 'string' || !LABEL_DOMAIN.test(gatewayDomain)) throw badArg('gatewayDomain: a domain name such as gateway.example')
  return `https://${gatewayLabel(tokenId, processorNumber)}.${gatewayDomain}/${REGISTRATION_KEY}`
}

/**
 * §5: the registration file for one identity and one circuit, as canonical JSON (RFC 8785), at most 65,536 bytes. Every
 * value of `tap` must come from chain reads (R-1), never from a file: pass what the chain answered.
 * p: { agentId, processor, tokenId, container, name (on-chain name, 4246.0.tape), manifestSha256?, displayName?,
 * description?, image?, extraServices?, gatewayDomain? }. `problems` lists what the file's own check (checkRegistrationFile) says.
 * §5：一个身份与一枚电路的登记文件（规范 JSON，≤ 65,536 字节）。tap 的每个值都必须取自链上读取，绝不取自文件。
 */
export function buildRegistrationFile(p) {
  if (!p || typeof p !== 'object') throw badArg('buildRegistrationFile: { agentId, processor, tokenId, container, name, ... }')
  const agentId = BigInt(p.agentId); const tokenId = BigInt(p.tokenId)
  if (agentId < 0n) throw badArg('agentId: a non-negative integer')
  let processor, container
  try { processor = addr(p.processor); container = addr(p.container) } catch { throw badArg('processor and container: addresses') }
  const nm = /^([1-9][0-9]*)\.(0|[1-9][0-9]*)\.tape$/.exec(String(p.name))
  if (!nm || BigInt(nm[1]) !== tokenId) throw badArg('name: the on-chain name of this circuit, <#ID>.<processor number>.tape (BNB Smart Chain form)')
  if (p.manifestSha256 !== undefined && p.manifestSha256 !== null && !/^0x[0-9a-f]{64}$/.test(p.manifestSha256)) throw badArg('manifestSha256: 0x and 64 lowercase hex digits')
  for (const k of ['displayName', 'description', 'image']) if (p[k] !== undefined && typeof p[k] !== 'string') throw badArg(`${k}: a string`)
  if (p.extraServices !== undefined && !Array.isArray(p.extraServices)) throw badArg('extraServices: an array of service objects')
  const tap = { v: 1, chainId: PASSPORT_CONFIG.chainId, processor, tokenId: String(tokenId), container }
  if (p.manifestSha256) tap.manifest = { path: '/' + MANIFEST_KEY, sha256: p.manifestSha256 }
  const doc = {
    type: REGISTRATION_TYPE,
    name: p.displayName ?? p.name,
    ...(p.description !== undefined ? { description: p.description } : {}),
    ...(p.image !== undefined ? { image: p.image } : {}),
    services: [{ name: 'tape', endpoint: `tape://${p.name}`, version: '1' }, ...(p.extraServices ?? [])],
    registrations: [{ agentId: agentId <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(agentId) : String(agentId), agentRegistry: `eip155:${PASSPORT_CONFIG.chainId}:${PASSPORT_CONFIG.identityRegistry}` }],
    tap,
  }
  const text = canonicalJson(doc)
  const bytes = utf8ToBytes(text)
  const check = checkRegistrationFile(bytes, { agentId, processor, tokenId, container, name: p.name })
  const agentUri = p.gatewayDomain ? canonicalAgentUri(tokenId, Number(nm[2]), p.gatewayDomain) : null
  return { bytes, text, agentUri, key: REGISTRATION_KEY, problems: check.ok ? [] : [check] }
}

/**
 * §5 on a file's bytes, and, with `expect`, R-1 (the tap member equals the chain), §5.2 item 4 (the tape service) and
 * P-10 (exactly this one identity is listed). Returns { ok } or { ok: false, reason, detail }; reason is a §6.3 name.
 * 对文件字节做 §5 检查；给了 expect 还查 R-1、tape 服务条目与 P-10。
 */
export function checkRegistrationFile(bytes, expect = {}) {
  if (!(bytes instanceof Uint8Array)) throw badArg('checkRegistrationFile: the file as a Uint8Array')
  if (bytes.length > MAX_REGISTRATION_BYTES) return { ok: false, reason: 'registration-file-too-large', detail: `${bytes.length} bytes` }
  let doc
  try { doc = parseRegistrationFile(bytes) } catch (e) { if (e instanceof Broken) return { ok: false, reason: e.reason, detail: e.detail }; throw e }
  const tap = doc.tap
  if (expect.processor !== undefined && addr(tap.processor) !== addr(expect.processor)) return { ok: false, reason: 'file-chain-mismatch', detail: 'tap.processor' }
  if (expect.tokenId !== undefined && BigInt(tap.tokenId) !== BigInt(expect.tokenId)) return { ok: false, reason: 'file-chain-mismatch', detail: 'tap.tokenId' }
  if (expect.container !== undefined && addr(tap.container) !== addr(expect.container)) return { ok: false, reason: 'file-chain-mismatch', detail: 'tap.container' }
  if (tap.chainId !== PASSPORT_CONFIG.chainId) return { ok: false, reason: 'file-chain-mismatch', detail: 'tap.chainId' }
  if (expect.name !== undefined && !doc.services.some((s) => s && typeof s === 'object' && s.name === 'tape' && s.endpoint === `tape://${expect.name}`)) return { ok: false, reason: 'tape-service-missing', detail: `tape://${expect.name}` }
  if (expect.agentId !== undefined) {
    const ids = listedAgentIds(doc, PASSPORT_CONFIG.chainId, PASSPORT_CONFIG.identityRegistry)
    if (ids.length > 1) return { ok: false, reason: 'several-listed' }
    if (ids.length === 0 || ids[0] !== BigInt(expect.agentId)) return { ok: false, reason: 'not-listed' }
  }
  return { ok: true }
}

/**
 * `tapeapi init --passport`, read-only, at one pinned block: the circuit (P-4, P-5, its on-chain name), the identity's
 * owner is the circuit's holder (P-1), the identity's tap.passport key names this circuit (P-2, P-3, P-11), and the
 * manifest's SHA-256 from the site store (for tap.manifest). Then the file, built from those reads only. It reads,
 * never writes or sends: `steps` says what the holder does next, in their own wallet. Returns
 * { status: 'ready' | 'fail' | 'unavailable', checks, file?, agentUri?, ... }.
 * tapeapi init --passport 的只读准备（一个钉块）：电路、身份所有者即电路持有人、tap.passport 键指向这枚电路、清单的 SHA-256；
 * 然后只用这些读取生成文件。它只读，不写、不发；steps 说明持有人接下来在自己的钱包里做什么。
 */
export async function preparePassportRegistration(o = {}) {
  const cfg = o.config ?? PASSPORT_CONFIG
  const inp = normaliseInput(o.circuit ? { circuit: o.circuit } : { name: o.name })
  const agentId = normaliseInput({ agentId: o.agentId }).agentId
  if (o.gatewayDomain !== undefined && (typeof o.gatewayDomain !== 'string' || !LABEL_DOMAIN.test(o.gatewayDomain))) throw badArg('gatewayDomain: a domain name such as gateway.example')
  const rpc = o.rpc ?? o.api?.rpc
  if (!rpc || typeof rpc.tap10Block !== 'function') throw badArg('preparePassportRegistration: rpc (a createRpc() client) or api (a createTapeAPI() client)')
  const table = o.api && typeof o.api.chain?.processorNumber === 'function' ? async (p, pin) => { const n = await o.api.chain.processorNumber(p, { at: pin }); return n === null ? null : Number(n) } : null
  const rd = await liveReads(rpc, { config: cfg, logs: logsClient(o.logs), ...(table ? { processorNumber: table } : {}) })
  const { fixedReads, circuit, fileInfo, call, isRevert, decAddress, decDyn, decoded } = internal
  const checks = []
  const out = (status, extra = {}) => ({ status, checks, pinnedBlock: rd.pinnedBlock, agentId: String(agentId), ...extra })
  const pass = (id, en, zh) => checks.push({ id, ok: true, detail: T(en, zh) })
  const stop = (id, reason, en, zh) => { checks.push({ id, ok: false, reason, detail: T(en, zh) }); return out('fail', { reason }) }
  try {
    await fixedReads(rd, cfg)
    pass('chain', `chain 56 at block ${rd.pinnedBlock}, registry and site store implementations as the draft lists`, `链 56，块 ${rd.pinnedBlock}，注册表与站点存储的实现与草案所列一致`)
    let processor, tokenId, known = null
    if (inp.name) {
      const r = await call(rd, `${addr(cfg.factory)}.cpuAt(${inp.name.number})`)
      if (isRevert(r)) return stop('circuit', 'not-tapeout', `no processor number ${inp.name.number}`, `没有 ${inp.name.number} 号处理器`)
      processor = decoded('cpuAt', () => decAddress(r)); tokenId = inp.name.tokenId; known = inp.name.number
    } else ({ processor, tokenId } = inp.circuit)
    let c
    try { c = await circuit(rd, cfg, processor, tokenId, known) } catch (e) {
      if (e instanceof Broken) return stop('circuit', e.reason, `the circuit: ${e.reason}`, `电路：${reasonZh(e.reason)}`)
      throw e
    }
    pass('circuit', `${c.name}: holder ${c.holder}, container ${c.container} (opened)`, `${c.name}：持有人 ${c.holder}，容器 ${c.container}（已开通）`)
    const registry = addr(cfg.identityRegistry)
    const own = await call(rd, `${registry}.ownerOf(${agentId})`)
    if (isRevert(own)) return stop('identity', 'no-such-agent', `agent ${agentId} does not exist in the identity registry: register it first, from the holder's wallet`, `身份注册表里没有 agent ${agentId}：请先用持有人的钱包登记`)
    const owner = decoded('ownerOf', () => decAddress(own))
    if (owner !== c.holder) return stop('identity', 'holder-mismatch', `agent ${agentId} is owned by ${owner}, not by the circuit's holder ${c.holder}`, `agent ${agentId} 的所有者是 ${owner}，不是电路持有人 ${c.holder}`)
    pass('identity', `agent ${agentId} is owned by the holder`, `agent ${agentId} 的所有者就是持有人`)
    const meta = await call(rd, `${registry}.getMetadata(${agentId},${PASSPORT_KEY})`)
    let key
    try { key = decodeKey(isRevert(meta) ? new Uint8Array(0) : decoded('getMetadata', () => decDyn(meta, 0))) } catch (e) {
      if (e instanceof Broken) return stop('key', e.reason, `the identity's tap.passport key: ${e.reason}; the holder writes it with register(agentURI, [("tap.passport", value)]) or setMetadata`, `身份的 tap.passport 键：${reasonZh(e.reason)}；持有人用 register(agentURI, [("tap.passport", 值)]) 或 setMetadata 写入`)
      throw e
    }
    if (key.chainId !== cfg.chainId) return stop('key', 'chain-mismatch', `tap.passport names chain ${key.chainId}`, `tap.passport 写的是链 ${key.chainId}`)
    if (key.processor !== processor || key.tokenId !== tokenId) return stop('key', 'key-circuit-mismatch', `tap.passport names #${key.tokenId} of ${key.processor}, not this circuit`, `tap.passport 指向 ${key.processor} 的 #${key.tokenId}，不是这枚电路`)
    pass('key', 'tap.passport names this circuit on chain 56', 'tap.passport 指向链 56 上的这枚电路')
    const mi = await fileInfo(rd, cfg, c.container, MANIFEST_KEY)
    const manifestSha256 = mi.chunkCount === 0n || mi.sha256 === '0x' + '00'.repeat(32) ? null : mi.sha256
    if (manifestSha256) pass('manifest', `manifest SHA-256 ${manifestSha256} (from the site store)`, `清单 SHA-256 ${manifestSha256}（取自站点存储）`)
    else checks.push({ id: 'manifest', ok: true, detail: T('no manifest in the site yet: the file is written without tap.manifest', '站点里还没有清单：文件不带 tap.manifest') })
    const file = buildRegistrationFile({ agentId, processor, tokenId, container: c.container, name: c.name, manifestSha256: manifestSha256 ?? undefined, displayName: o.displayName, description: o.description, gatewayDomain: o.gatewayDomain })
    if (file.problems.length) return stop('file', file.problems[0].reason, `the generated file fails its own check: ${file.problems[0].reason}`, `生成的文件自检不成立：${file.problems[0].reason}`)
    pass('file', `${file.bytes.length} bytes, canonical JSON, lists only agent ${agentId}`, `${file.bytes.length} 字节，规范 JSON，只列出 agent ${agentId}`)
    const number = Number(c.name.split('.')[1])
    return out('ready', { holder: c.holder, container: c.container, name: c.name, processor, tokenId: String(tokenId), file, agentUri: file.agentUri, agentUriForm: `https://${gatewayLabel(tokenId, number)}.<gateway domain>/${REGISTRATION_KEY}`, steps: registrationSteps(c.name) })
  } catch (e) {
    if (e instanceof Unavailable) { checks.push({ id: 'reads', ok: false, reason: e.reason, detail: T(`could not be read: ${e.reason}`, `读不到：${reasonZh(e.reason)}`) }); return out('unavailable', { reason: e.reason }) }
    throw e
  }
}

/** What the holder does after the file is written locally, in their own wallet and at their own cost. / 持有人接下来做的事。 */
export function registrationSteps(name) {
  return [
    T(`In the holder console, store the file with putFile under the site key ${REGISTRATION_KEY} of ${name}'s container (a transaction you send and pay for yourself).`,
      `在持有人操作台用 putFile 把文件写进 ${name} 容器站点的键 ${REGISTRATION_KEY}（交易由你自己发送并支付）。`),
    T(`Between your register transaction and that putFile, your own identity resolves as BROKEN (registration-file-missing or not-listed): store the file right after registering.`,
      `从你的 register 交易到这次 putFile 之间，你自己的身份会解析为 BROKEN（registration-file-missing 或 not-listed）：登记之后请立刻写入文件。`),
    T('The agent wallet must equal the holder (P-9): register sets it; after a transfer of the identity it is cleared, and only your own setAgentWallet signature (EIP-712) restores it.',
      'agent 钱包必须等于持有人（P-9）：register 会设置它；身份转手后它被清空，只有你自己签的 setAgentWallet（EIP-712）能恢复。'),
    T('A passport publicly and permanently links your wallet, the identity, the container, its site and any reviews.', '护照会把你的钱包、身份、容器、站点与评价公开且永久地关联在一起。'),
  ]
}
