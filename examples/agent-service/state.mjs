// The agent runtime's state on disk (EXPERIMENTAL, phase 1, local chains only): a file store for the spend limiter's
// records, the sealed agent keys, the payer's counters and the order records, and the key vault from the environment.
// Only with a passphrase: without one nothing is written, every order lives in memory, and a restart voids them all.
// What is written: JSON records (public data: the signed offer and mandate, receipts) and, for each order's agent key,
// only what the vault sealed (scrypt + XChaCha20-Poly1305, @tapeapi/sdk/agent passphraseKeyVault), never the key.
// Files are 0600 in a 0700 directory, each written to a temporary file and renamed. ONE runtime process per directory:
// the store compares and sets within its process only (the spend limiter's single-writer premise), so the directory is
// locked (LOCK_FILE: the holder's pid, its start time and host; released when the process exits; a lock is taken over
// only when its process is gone on this host). NEVER restore the directory from a backup or a snapshot: a rollback
// revives sealed keys and orders that were stopped, revoked or delivered (the internal phase-1 draft §10.9.3).
// 代理运行时的磁盘状态（实验、阶段 1、仅本地链）：文件存储（限额记录、封存的钥匙、付款器计数、订单记录）与来自环境变量的保险箱。
// 只有给了口令才启用：没有口令就什么都不写，订单只在内存里，重启即全部作废。写入的是 JSON 记录（公开数据）与保险箱封存后的钥匙，
// 绝不是钥匙本身。文件 0600、目录 0700，先写临时文件再改名。每个目录只能有一个运行时进程（限额器的单写者前提），所以目录加锁
// （LOCK_FILE：持有者的 pid、启动时间与主机；进程退出时释放；只有本机上持有进程已不存在时才接管）。绝不要从备份或快照恢复这个目录：
// 回滚会让已停工、已撤销、已交付的单与其密文复活。
import { mkdirSync, chmodSync, readFileSync, writeFileSync, renameSync, unlinkSync, linkSync, openSync, closeSync, fsyncSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import { passphraseKeyVault, KEY_VAULT_MIN_PASSPHRASE } from '@tapeapi/sdk/agent'

export const PASSPHRASE_ENV = 'TAPEAPI_AGENT_KEY_PASSPHRASE'
export const STATE_DIR_ENV = 'TAPEAPI_AGENT_STATE_DIR'

// a key to a file name: letters, digits, '.', '-' as they are, everything else as _xx (reversible, no path separators)
// 键到文件名：字母数字、'.'、'-' 原样，其余写成 _xx（可逆，没有路径分隔符）
const fileOf = (key) => String(key).replace(/[^A-Za-z0-9.-]/g, (c) => '_' + Buffer.from(c, 'utf8').toString('hex')) + '.json'
const seqIn = (s) => (s == null || s === '' ? null : (JSON.parse(s).seq ?? 0))

// ---- one process per directory: the lock (Bruce, 2026-10-08) / 一个目录一个进程：锁 ----
export const LOCK_FILE = '.tapeapi-agent.lock'
const held = new Set()                                         // the lock files this process holds / 本进程持有的锁文件
let exitHooked = false
const myLock = () => ({ pid: process.pid, startedAt: new Date(Math.floor(performance.timeOrigin)).toISOString(), host: hostname() })
function readLock(path) {
  let raw
  try { raw = readFileSync(path, 'utf8') } catch (e) { if (e.code === 'ENOENT') return { gone: true }; return null }
  try {
    const x = JSON.parse(raw)
    if (x && Number.isSafeInteger(x.pid) && x.pid > 0 && typeof x.host === 'string' && typeof x.startedAt === 'string') return { pid: x.pid, host: x.host, startedAt: x.startedAt, raw }
  } catch { /* unreadable: held */ }
  return null
}
// a process that is gone: only a pid on this host that the system says does not exist (ESRCH); EPERM (another user's
// process) is alive, and a lock from another host or one that cannot be read is never stale / 只有本机上系统说不存在（ESRCH）的 pid 才算已不在
function isStale(lock) {
  if (!lock || lock.gone || lock.host !== hostname()) return false
  try { process.kill(lock.pid, 0); return false } catch (e) { return e.code === 'ESRCH' }
}
function releaseAll() {
  for (const path of held) { const l = readLock(path); if (l && !l.gone && l.pid === process.pid) { try { unlinkSync(path) } catch { /* gone already */ } } }
  held.clear()
}
const busy = (path, lock) => Object.assign(new Error(lock
  ? `the state directory is in use by process ${lock.pid} on ${lock.host} (started ${lock.startedAt}): one runtime process per directory. If that process is gone and this is another host, or the pid now belongs to another program, remove ${path} by hand`
  : `the state directory's lock ${path} cannot be read: one runtime process per directory. Remove it by hand once you are sure no runtime uses the directory`), { code: 'STATE_DIR_LOCKED' })
/**
 * Take the directory's lock for this process: { path, pid, startedAt, host, release() }. Made atomically with its content
 * (a temporary file hard-linked to LOCK_FILE). Held already by this process: the same lock. Held by a live process, by
 * another host, or unreadable: throws STATE_DIR_LOCKED. Held by a process that is gone on this host (it crashed or was
 * killed): taken over. Released when this process exits (release() earlier); a signal that kills the process leaves it,
 * and the next start takes it over.
 * 为本进程加目录锁：原子创建（临时文件硬链接到 LOCK_FILE）。本进程已持有：同一把锁。活着的进程、别的主机、读不懂的锁：抛
 * STATE_DIR_LOCKED。本机上持有进程已不在（崩溃或被杀）：接管。进程退出时释放；被信号杀死则留下，下次启动接管。
 */
export function lockStateDir(dir) {
  const root = resolve(dir), path = join(root, LOCK_FILE)
  const mine = myLock()
  const done = () => {
    held.add(path)
    if (!exitHooked) { exitHooked = true; process.on('exit', releaseAll) }
    return { path, ...mine, release() { const l = readLock(path); if (l && !l.gone && l.pid === process.pid) unlinkSync(path); held.delete(path) } }
  }
  for (let i = 0; i < 3; i++) {
    const tmp = join(root, `.${randomBytes(8).toString('hex')}.tmp`)
    writeFileSync(tmp, JSON.stringify(mine), { mode: 0o600, flag: 'wx' })
    let made = false
    try { linkSync(tmp, path); made = true } catch (e) { if (e.code !== 'EEXIST') throw e } finally { unlinkSync(tmp) }
    if (made) return done()
    const lock = readLock(path)
    if (lock?.gone) continue                                   // released meanwhile / 刚被释放
    // this process (a second store on the same directory), or a dead process whose pid this one now has
    // 本进程（同一目录上的第二个存储），或 pid 恰好被本进程复用的已死进程
    if (lock && lock.pid === process.pid && lock.host === mine.host) return done()
    if (!isStale(lock)) throw busy(path, lock)
    // take a stale lock over: moved aside atomically, and checked to be the very one judged stale (another process may
    // have taken it over first: then it is put back and this one refuses) / 接管失效的锁：原子移开，确认移开的正是判定失效的那一把
    const grave = join(root, `.${randomBytes(8).toString('hex')}.stale`)
    try { renameSync(path, grave) } catch (e) { if (e.code === 'ENOENT') continue; throw e }
    const moved = readLock(grave)
    if (!moved || moved.raw !== lock.raw) {
      try { linkSync(grave, path) } catch { /* someone holds it now */ }
      unlinkSync(grave)
      throw busy(path, moved && !moved.gone ? moved : null)
    }
    unlinkSync(grave)
  }
  throw busy(path, readLock(path))
}

/**
 * A store of strings on disk: { get(key), set(key, value, { ifSeq }), delete(key), dir, lock }. set with ifSeq compares
 * the stored record's seq first (the spend limiter's compare-and-set, within this process); every file is 0600 in a 0700
 * directory, and the directory is locked to this process (lockStateDir: another live process using it throws).
 * 磁盘上的字符串存储；带 ifSeq 的 set 先比较已存记录的 seq（本进程内的比较并写入）；文件 0600、目录 0700，目录锁给本进程。
 */
export function createFileStore(dir) {
  if (typeof dir !== 'string' || dir === '') throw new Error('createFileStore needs a directory')
  const root = resolve(dir)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  chmodSync(root, 0o700)                                       // an existing directory too / 已存在的目录也收紧
  const lock = lockStateDir(root)
  const path = (key) => join(root, fileOf(key))
  const read = (key) => { try { return readFileSync(path(key), 'utf8') } catch (e) { if (e.code === 'ENOENT') return null; throw e } }
  return {
    dir: root, lock,
    get: (key) => read(key),
    set(key, value, opts) {
      if (typeof value !== 'string') throw new Error('the store keeps strings')
      if (opts && 'ifSeq' in opts && seqIn(read(key)) !== opts.ifSeq) return false
      const tmp = join(root, `.${randomBytes(8).toString('hex')}.tmp`)
      const fd = openSync(tmp, 'wx', 0o600)
      try { writeFileSync(fd, value); fsyncSync(fd) } finally { closeSync(fd) }
      renameSync(tmp, path(key))
      return true
    },
    delete(key) { try { unlinkSync(path(key)) } catch (e) { if (e.code !== 'ENOENT') throw e } },
  }
}

/**
 * The runtime's persistence from the environment: TAPEAPI_AGENT_KEY_PASSPHRASE (at least 12 UTF-8 bytes; never logged) and
 * TAPEAPI_AGENT_STATE_DIR. Both given: { store, vault, dir }, for createAgentService({ spend: { ...spend, store, vault } })
 * and its recover(). Otherwise null, and `log` says that persistence is off and what a restart then means.
 * 从环境变量取持久化：两者都给了才返回 { store, vault, dir }；否则返回 null，并在日志里说明持久化未启用、重启意味着什么。
 */
export function persistenceFromEnv(env = process.env, { log = () => {} } = {}) {
  const pass = env[PASSPHRASE_ENV], dir = env[STATE_DIR_ENV]
  if (!pass || !dir) {
    log(`persistence OFF: set ${PASSPHRASE_ENV} (at least ${KEY_VAULT_MIN_PASSPHRASE} bytes) and ${STATE_DIR_ENV} to keep spend orders across a restart; without them every order's agent key lives in memory only and a restart voids every order (the principal then closes its channels out)`)
    return null
  }
  if (Buffer.byteLength(pass, 'utf8') < KEY_VAULT_MIN_PASSPHRASE) throw new Error(`${PASSPHRASE_ENV} must be at least ${KEY_VAULT_MIN_PASSPHRASE} bytes`)
  const store = createFileStore(dir)
  log(`persistence ON in ${store.dir} (0700): agent keys sealed with the passphrase (scrypt + XChaCha20-Poly1305), never written in the clear; one runtime process per directory`)
  return { store, vault: passphraseKeyVault({ passphrase: pass }), dir: store.dir }
}

/** the permission bits of a path (for tests and checks) / 路径的权限位 */
export const modeOf = (p) => statSync(p).mode & 0o777
