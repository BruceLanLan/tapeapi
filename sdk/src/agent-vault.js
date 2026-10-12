// @tapeapi/sdk/agent, phase 1 (experimental, internal; local chains only): a key vault, so that an agent runtime can keep
// its session keys across a restart without ever writing one in the clear. The SDK writes no key anywhere itself; a
// runtime that wants to resume its orders after a restart gives the spend limiter a vault ({ seal, open }), and the
// limiter stores only what seal returns. The vault is the operator's: a passphrase (passphraseKeyVault below), a key
// of its own, or a KMS behind the same two functions.
//
// passphraseKeyVault: scrypt (N = 2^17, r = 8, p = 1, 32 bytes; fixed in KEY_VAULT_SCRYPT) derives a key from the
// passphrase and a random 16-byte salt; XChaCha20-Poly1305 with a random 24-byte nonce seals the bytes, with the
// associated data `tapeapi/key-vault/v1` LF context, so that a blob opens only in the context it was sealed for (the
// limiter's context names the chain and the agent key: the blob of another key does not open under this one). The blob
// is the string KEY_VAULT_PREFIX + hex(salt || nonce || ciphertext || tag). Both algorithms are the audited @noble ones
// the SDK already depends on; the parameters are constants, and a blob of other parameters is malformed.
// 阶段 1（实验、内部、仅本地链）：钥匙保险箱，让代理运行时跨重启保留会话钥匙，且绝不明文落盘。SDK 自己不写任何钥匙；要在重启后
// 恢复订单的运行时把保险箱（{ seal, open }）交给花费限额器，限额器只保存 seal 的输出。保险箱属于运营方：口令（下面的
// passphraseKeyVault）、自己的密钥，或同样两个函数背后的 KMS。口令保险箱：scrypt（N = 2^17、r = 8、p = 1、32 字节，常量
// KEY_VAULT_SCRYPT）由口令与随机 16 字节盐派生密钥；XChaCha20-Poly1305（随机 24 字节 nonce）加密，关联数据为
// `tapeapi/key-vault/v1` 换行 context，密文只在封存时的 context 下能打开（限额器的 context 写明链与代理钥匙：别的钥匙的密文
// 在这里打不开）。密文串 = KEY_VAULT_PREFIX + hex(盐 || nonce || 密文 || 标签)。算法与参数都是常量，其它参数的密文串即格式错。
import { scryptAsync } from '@noble/hashes/scrypt'
import { xchacha20poly1305 } from '@noble/ciphers/chacha'
import { randomBytes, utf8ToBytes, bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { TapeAPIError } from './errors.js'

export const KEY_VAULT_VERSION = 1
/** scrypt's parameters, fixed (OWASP's minimum for scrypt) / scrypt 参数，写死 */
export const KEY_VAULT_SCRYPT = Object.freeze({ N: 2 ** 17, r: 8, p: 1, dkLen: 32 })
export const KEY_VAULT_SALT_BYTES = 16
export const KEY_VAULT_NONCE_BYTES = 24
/** the shortest passphrase passphraseKeyVault takes, in UTF-8 bytes / 最短口令（UTF-8 字节） */
export const KEY_VAULT_MIN_PASSPHRASE = 12
export const KEY_VAULT_PREFIX = 'tapeapi-key-vault:v1:'
const AAD_LABEL = 'tapeapi/key-vault/v1'
const TAG_BYTES = 16
// review p1-restart: the most a blob may seal (4 MiB), checked before anything else is done with a blob (no hex decoded,
// no KDF run): a vault seals agent keys (32 bytes) and the runtime's order records, never more
// 审查 p1-restart：一个密文最多封存 4 MiB；先查长度，再做别的（不解码、不跑 KDF）
const MAX_PLAINTEXT = 4 * 1024 * 1024
const HEX_RE = /^[0-9a-f]+$/
const bad = (msg) => { throw new TapeAPIError('INVALID_ARGUMENT', msg) }
const vaultErr = (reason, msg) => { throw new TapeAPIError('AGENT_KEY_VAULT', msg, { reason }) }

function contextBytes(context) {
  if (typeof context !== 'string' || context.length === 0 || context.length > 512) bad('a key-vault context is a non-empty string of at most 512 characters')
  return utf8ToBytes(`${AAD_LABEL}\n${context}`)
}
const bytesOf = (b, name, len) => {
  if (!(b instanceof Uint8Array) || (len !== undefined && b.length !== len)) bad(`${name} must be ${len === undefined ? 'a Uint8Array' : `${len} bytes`}`)
  return b
}
/** @experimental (phase 1) The associated data of a blob sealed for `context` (the bytes verify.py checks). / 关联数据 */
export const keyVaultAad = (context) => contextBytes(context)

/**
 * @experimental (phase 1) scrypt(passphrase, salt) with KEY_VAULT_SCRYPT: the 32-byte key a passphrase vault seals with.
 * Async (about half a second and 128 MiB). / 由口令与盐派生的 32 字节密钥（异步，约半秒、128 MiB）。
 */
export async function keyVaultKey(passphrase, salt) {
  if (typeof passphrase !== 'string' || utf8ToBytes(passphrase).length < KEY_VAULT_MIN_PASSPHRASE) bad(`the passphrase must be a string of at least ${KEY_VAULT_MIN_PASSPHRASE} UTF-8 bytes`)
  bytesOf(salt, 'salt', KEY_VAULT_SALT_BYTES)
  const { N, r, p, dkLen } = KEY_VAULT_SCRYPT
  return scryptAsync(utf8ToBytes(passphrase), salt, { N, r, p, dkLen })
}
/** @experimental (phase 1) The blob of `plaintext` sealed with `key` (32 bytes), `salt` (kept in the blob for the KDF) and `nonce` (24 bytes) for `context`. Pure. / 密封（纯函数） */
export function keyVaultSeal(key, { salt, nonce, context, plaintext } = {}) {
  bytesOf(key, 'key', 32); bytesOf(salt, 'salt', KEY_VAULT_SALT_BYTES); bytesOf(nonce, 'nonce', KEY_VAULT_NONCE_BYTES); bytesOf(plaintext, 'plaintext')
  if (plaintext.length > MAX_PLAINTEXT) bad(`a key vault seals at most ${MAX_PLAINTEXT} bytes`)
  const sealed = xchacha20poly1305(key, nonce, contextBytes(context)).encrypt(plaintext)
  return KEY_VAULT_PREFIX + bytesToHex(salt) + bytesToHex(nonce) + bytesToHex(sealed)
}
/** @experimental (phase 1) A blob taken apart: { salt, nonce, sealed }; AGENT_KEY_VAULT key-vault-malformed otherwise. / 拆开密文串 */
export function keyVaultParse(blob) {
  if (typeof blob !== 'string' || !blob.startsWith(KEY_VAULT_PREFIX)) vaultErr('key-vault-malformed', `not a key-vault blob of version ${KEY_VAULT_VERSION} (it must start with ${KEY_VAULT_PREFIX})`)
  const min = 2 * (KEY_VAULT_SALT_BYTES + KEY_VAULT_NONCE_BYTES + TAG_BYTES)
  if (blob.length - KEY_VAULT_PREFIX.length > min + 2 * MAX_PLAINTEXT) vaultErr('key-vault-malformed', `a key-vault blob seals at most ${MAX_PLAINTEXT} bytes`)
  const hex = blob.slice(KEY_VAULT_PREFIX.length)
  if (hex.length < min || hex.length % 2 !== 0 || !HEX_RE.test(hex)) vaultErr('key-vault-malformed', 'a key-vault blob is lower-case hex of salt, nonce, ciphertext and tag')
  const b = hexToBytes(hex)
  return { salt: b.slice(0, KEY_VAULT_SALT_BYTES), nonce: b.slice(KEY_VAULT_SALT_BYTES, KEY_VAULT_SALT_BYTES + KEY_VAULT_NONCE_BYTES), sealed: b.slice(KEY_VAULT_SALT_BYTES + KEY_VAULT_NONCE_BYTES) }
}
/** @experimental (phase 1) The plaintext of a blob, opened with `key` for `context`; AGENT_KEY_VAULT (key-vault-malformed, key-vault-open-failed) otherwise. Pure. / 打开（纯函数） */
export function keyVaultOpen(key, blob, { context } = {}) {
  bytesOf(key, 'key', 32)
  const aad = contextBytes(context)
  const { nonce, sealed } = keyVaultParse(blob)
  try { return xchacha20poly1305(key, nonce, aad).decrypt(sealed) } catch {
    return vaultErr('key-vault-open-failed', 'the key-vault blob does not open: a wrong passphrase or key, a blob changed in the store, or the blob of another context (another agent key); nothing is signed with it')
  }
}

/**
 * @experimental (phase 1) A key vault on a passphrase: { kind: 'passphrase', seal(bytes, { context }), open(blob, { context }) },
 * both async. seal uses one random salt per vault (the key is derived once) and a random nonce per blob; open derives the
 * key of the blob's salt (kept for the vault's life). The passphrase is the operator's (from the environment, never from
 * a file next to the store); whoever has it and the store has the keys. A failure to open throws AGENT_KEY_VAULT and
 * never yields bytes.
 * 口令保险箱：seal 每个保险箱一个随机盐（只派生一次）、每个密文一个随机 nonce；open 按密文的盐派生。口令属于运营方（来自环境变量，
 * 绝不放在存储旁边的文件里）；同时拿到口令与存储的人就拿到钥匙。打不开即抛 AGENT_KEY_VAULT，绝不返回字节。
 */
export function passphraseKeyVault({ passphrase } = {}) {
  if (typeof passphrase !== 'string' || utf8ToBytes(passphrase).length < KEY_VAULT_MIN_PASSPHRASE) bad(`passphraseKeyVault needs a passphrase of at least ${KEY_VAULT_MIN_PASSPHRASE} UTF-8 bytes`)
  const keys = new Map()                       // salt hex -> Promise<key> / 盐 -> 密钥
  let mySalt = null
  const keyFor = (salt) => {
    const h = bytesToHex(salt)
    let k = keys.get(h)
    if (!k) {
      if (keys.size >= 64) keys.delete(keys.keys().next().value)
      k = keyVaultKey(passphrase, salt)
      k.catch(() => keys.delete(h))
      keys.set(h, k)
    }
    return k
  }
  return Object.freeze({
    kind: 'passphrase',
    async seal(bytes, { context } = {}) {
      bytesOf(bytes, 'bytes'); contextBytes(context)
      if (bytes.length > MAX_PLAINTEXT) bad(`a key vault seals at most ${MAX_PLAINTEXT} bytes`)
      mySalt ??= randomBytes(KEY_VAULT_SALT_BYTES)
      const key = await keyFor(mySalt)
      return keyVaultSeal(key, { salt: mySalt, nonce: randomBytes(KEY_VAULT_NONCE_BYTES), context, plaintext: bytes })
    },
    // the context and the blob's form and length are checked before any KDF runs; each salt not seen yet costs one
    // scrypt (about half a second and 128 MiB), so whoever can write blobs into the store can make an open slow (a
    // denial of service, never a key): one runtime's blobs carry one salt per process that sealed them
    // 先查 context 与密文串的格式、长度，再跑 KDF；每个没见过的盐要一次 scrypt（约半秒、128 MiB），所以能往存储里写密文的人
    // 能让打开变慢（拒绝服务，拿不到钥匙）；一个运行时的密文每个封存它的进程只有一个盐
    async open(blob, { context } = {}) {
      contextBytes(context)
      const { salt } = keyVaultParse(blob)
      return keyVaultOpen(await keyFor(salt), blob, { context })
    },
  })
}

/** @experimental (phase 1) The context the spend limiter seals an agent key for: the chain and the key. / 限额器封存代理钥匙用的 context */
export function spendKeyContext(chainId, agentKey) {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) bad('chainId must be a positive integer')
  if (typeof agentKey !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(agentKey)) bad('agentKey must be an address')
  return `tapeapi-spend-key/v1/${chainId}/${agentKey.toLowerCase()}`
}
