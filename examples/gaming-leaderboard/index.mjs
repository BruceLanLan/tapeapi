#!/usr/bin/env node
// 游戏排行榜 + 存档示例：玩家用钱包签分数/存档，provider 校验签名、内存保存并落盘 JSON。
// Game leaderboard + save slots: players sign scores/state with their wallet key; the provider verifies,
// keeps everything in memory and persists to a JSON file.
import { readFile, writeFile, rename } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createProvider } from '@tapeapi/server'
import { sig, abi, TapeAPIError } from '@tapeapi/sdk'
import { recoverScoreSigner, recoverStateSigner } from './score-sig.mjs'
import { exampleEnv, applyEnvToManifest, startProvider } from '../_lib/service.mjs'

const here = new URL('.', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('manifest.json', here), 'utf8'))

// ---- env ----
const env = exampleEnv('game', { port: 8790 })
const { RPC_URLS, QUORUM, CHAIN_ID, PROD, SIGNER_KEY, log, store } = env
const DATA_FILE = process.env.DATA_FILE || fileURLToPath(new URL('leaderboard.data.json', here))
const MAX_STATE_BYTES = Number(process.env.MAX_STATE_BYTES || 16 * 1024)
applyEnvToManifest(manifest, env)

// ---- 状态：内存 + JSON 落盘 / state: in memory, persisted to JSON ----
const db = { scores: {}, states: {} } // scores[player] = {best, nonce, games, updatedAt}; states[player] = {state, nonce, bytes, updatedAt}
try { Object.assign(db, JSON.parse(await readFile(DATA_FILE, 'utf8'))); console.log(`[game] loaded ${Object.keys(db.scores).length} players from ${DATA_FILE}`) } catch (e) { if (e.code !== 'ENOENT') throw e }
let saveTimer = null, saving = Promise.resolve()
function persist() { // 200ms 合并写入，tmp+rename 原子落盘 / debounce 200ms, atomic tmp+rename
  if (saveTimer) return
  saveTimer = setTimeout(() => { saveTimer = null; saving = saving.then(async () => { await writeFile(DATA_FILE + '.tmp', JSON.stringify(db)); await rename(DATA_FILE + '.tmp', DATA_FILE) }).catch(e => console.error('[game] persist failed', e.message)) }, 200)
}

const bad = (msg) => { throw new TapeAPIError('BAD_REQUEST', msg) }
const now = () => Math.floor(Date.now() / 1000)
const isUint = (v, max = Number.MAX_SAFE_INTEGER) => Number.isInteger(v) && v >= 0 && v <= max
const isSig = (s) => typeof s === 'string' && /^0x[0-9a-fA-F]{130}$/.test(s)
function checkPlayer(player) { if (!abi.isAddress(player)) bad('player must be an address'); return abi.checksumAddress(player) }
function checkNonce(prev, nonce) { if (!isUint(nonce)) bad('nonce must be a non-negative integer (e.g. Date.now())'); if (prev && nonce <= prev.nonce) bad(`nonce ${nonce} must be > last nonce ${prev.nonce}`) }
function ranked() { return Object.entries(db.scores).sort((a, b) => b[1].best - a[1].best || a[1].updatedAt - b[1].updatedAt) }
function rankOf(player) { return ranked().findIndex(([p]) => p === player) + 1 }

const provider = createProvider({
  manifest, signerKey: SIGNER_KEY, dev: !PROD, rpcUrls: RPC_URLS, quorum: QUORUM, chainId: CHAIN_ID,
  allowSingleNode: !PROD, // 生产环境 urls 少于 quorum 拒绝启动（M-11）/ production refuses fewer urls than quorum
  log: (...a) => console.error('[game]', ...a), store,
  methods: {
    // 免费：提交分数，签名必须来自 player 本人 / free: submit a score; signature must recover to `player`
    submitScore: async ({ player, score, nonce, sig: s }) => {
      player = checkPlayer(player)
      if (!isUint(score)) bad('score must be a non-negative integer')
      if (!isSig(s)) bad('sig must be a 65-byte hex signature')
      const prev = db.scores[player]; checkNonce(prev, nonce)
      let signerAddr; try { signerAddr = recoverScoreSigner({ player, score, nonce }, s) } catch (e) { bad(`bad signature: ${e.message}`) }
      if (!abi.eqAddr(signerAddr, player)) bad(`signature recovers to ${signerAddr}, not ${player}`)
      const accepted = !prev || score > prev.best
      db.scores[player] = { best: accepted ? score : prev.best, nonce, games: (prev?.games || 0) + 1, updatedAt: accepted ? now() : prev.updatedAt }
      persist()
      return { player, best: db.scores[player].best, rank: rankOf(player), accepted }
    },
    // 免费：排行榜前 n / free: top n
    top: async ({ n } = {}) => {
      const k = n == null ? 10 : n
      if (!isUint(k, 100) || k < 1) bad('n must be 1..100')
      const all = ranked()
      return { top: all.slice(0, k).map(([player, r], i) => ({ rank: i + 1, player, score: r.best, games: r.games, updatedAt: r.updatedAt })), count: all.length }
    },
    // 收费：保存存档（签名覆盖 canonicalJSON(state)）/ paid: save state (signature covers canonicalJSON(state))
    saveState: async ({ player, state, nonce, sig: s }) => {
      player = checkPlayer(player)
      if (state === undefined || state === null || typeof state !== 'object') bad('state must be a JSON object or array')
      if (!isSig(s)) bad('sig must be a 65-byte hex signature')
      const bytes = Buffer.byteLength(JSON.stringify(state))
      if (bytes > MAX_STATE_BYTES) bad(`state is ${bytes} bytes, limit ${MAX_STATE_BYTES}`)
      const prev = db.states[player]; checkNonce(prev, nonce)
      let signerAddr; try { signerAddr = recoverStateSigner({ player, state, nonce }, s) } catch (e) { bad(`bad signature: ${e.message}`) }
      if (!abi.eqAddr(signerAddr, player)) bad(`signature recovers to ${signerAddr}, not ${player}`)
      db.states[player] = { state, nonce, bytes, updatedAt: now() }
      persist()
      return { player, bytes, updatedAt: db.states[player].updatedAt }
    },
    // 免费：读存档 / free: load state
    loadState: async ({ player }) => {
      player = checkPlayer(player)
      const r = db.states[player]
      return { player, state: r ? r.state : null, nonce: r ? r.nonce : null, updatedAt: r ? r.updatedAt : null }
    },
  },
})

// onShutdown：先等落盘完成，再关端口 —— 否则最后一次 200ms 合并写入会连同进程一起消失。
// onShutdown: flush the debounced save before closing the port, or the last write dies with the process.
await startProvider(provider, env, { lines: [`data     ${DATA_FILE}`], onShutdown: () => saving })
