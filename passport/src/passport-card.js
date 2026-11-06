// @tapeapi/passport (@experimental): an A2A 1.0 agent card generated from a CONFIRMED passport, Appendix B of the draft
// (informative). DISPLAY ONLY: the card never raises a passport's state, carries no signature here, and is never a
// source of signers (S-2): a signer speaks for a service only through TAP-11 §4.5. Every text in it is the holder's
// statement, rendered as plain text. For any state other than CONFIRMED there is no card.
// 由 CONFIRMED 护照生成的 A2A 1.0 名片（草案附录 B，资料性）。只用于显示：名片不提升护照状态、这里不带签名、绝不是签名者来源（S-2）。
// 名片里的文字都是持有人的陈述，按纯文本显示。非 CONFIRMED 的状态没有名片。
import { validateAgentMember } from '@tapeapi/sdk/manifest'
import { toolsDigest } from '@tapeapi/sdk/mcp'
import { holderText } from './passport-text.js'

const T = (en, zh) => ({ en, zh })
const NOTE_DISPLAY = T('Display only: this card does not raise the passport\'s state and is never a source of signers (S-2).', '只用于显示：名片不提升护照状态，也绝不是签名者来源（S-2）。')
const NOTE_HOLDER = T("name, description and skills are the holder's statements, shown as plain text.", 'name、description 与 skills 都是持有人的陈述，按纯文本显示。')
const NOTE_MCP = T("The manifest carries mcp: its tool list is the one mcp.toolsSha256 pins (TAPs #16 at 13d1179, D-7); neither this card nor the registration file can replace it.",
  '清单带 mcp：工具列表以 mcp.toolsSha256 钉住的为准（TAPs #16 头 13d1179，D-7）；名片或登记文件都不能替代它。')
const none = (why, notes = [NOTE_DISPLAY]) => ({ card: null, why, notes })

/**
 * p: { result (a CONFIRMED PassportResult), manifest (the TAP-11 manifest object read from the site store),
 * manifestSha256 (its SHA-256 from the site store, 0x hex), registrationFile (the parsed registration file object),
 * a2aEndpoints (the entries of manifest.endpoints.live that serve A2A: a manifest has no marker for that, so the caller
 * names them), tools? (the tools/list answer, checked against mcp.toolsSha256 when the manifest carries mcp) }.
 * Returns { card | null, why?, notes }.
 * 调用方必须指出 endpoints.live 里哪些提供 A2A（清单没有这种标记）；清单带 mcp 且给了 tools 时，先核对 toolsSha256。
 */
export function agentCardFromPassport(p = {}) {
  const { result, manifest, manifestSha256, registrationFile } = p
  if (!result || result.state !== 'CONFIRMED') return none('not-confirmed')
  if (!manifest || typeof manifest !== 'object' || !manifest.endpoints || !Array.isArray(manifest.endpoints.live)) return none('no-manifest')
  if (typeof manifestSha256 !== 'string' || !/^0x[0-9a-f]{64}$/.test(manifestSha256)) return none('no-manifest-hash')
  // The manifest must be the one the registration file pins (tap.manifest) when it pins one, and the passport must not
  // have found it different (FIXED R30-P5). / 登记文件钉住了清单时，必须就是那一份；护照也不能报告它不同。
  const pinned = registrationFile?.tap?.manifest?.sha256
  if ((Array.isArray(result.warnings) && result.warnings.includes('manifest-hash-differs')) || (pinned !== undefined && pinned !== manifestSha256)) return none('manifest-hash-differs')
  const live = manifest.endpoints.live.filter((u) => typeof u === 'string')
  const a2a = Array.isArray(p.a2aEndpoints) ? p.a2aEndpoints : []
  if (!a2a.length) return none('no-a2a-endpoint')
  if (a2a.some((u) => !live.includes(u))) return none('a2a-endpoint-not-in-manifest')
  const notes = [NOTE_DISPLAY, NOTE_HOLDER]
  if (manifest.mcp && typeof manifest.mcp === 'object') {
    notes.push(NOTE_MCP)
    if (p.tools !== undefined) {
      let digest = null; try { digest = toolsDigest(p.tools) } catch { digest = null }
      const want = String(manifest.mcp.toolsSha256 ?? '').toLowerCase().replace(/^0x/, '')
      if (digest === null || digest !== want) return none('mcp-digest-mismatch', notes)
    }
  }
  let agent = null
  if (manifest.agent !== undefined) { try { agent = validateAgentMember(manifest.agent) } catch { return none('agent-member-invalid', notes) } }
  const tags = agent && agent.capabilities.length ? agent.capabilities : ['tape']
  const card = {
    name: holderText(String(manifest.name ?? ''), 120),
    description: holderText(typeof registrationFile?.description === 'string' ? registrationFile.description : '', 1000),
    version: `${holderText(String(manifest.tapeapi ?? ''), 32)}+${manifestSha256.slice(2, 10)}`,
    supportedInterfaces: a2a.map((url) => ({ url, protocolBinding: 'JSONRPC', protocolVersion: '1.0' })),
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    skills: (agent?.tasks ?? []).map((t) => ({ id: t.kind, name: t.kind, description: holderText(t.description ?? '', 256), tags: [...tags] })),
  }
  if (!card.skills.length) notes.push(T('The manifest has no agent member (TAPs #49): the card lists no skill.', '清单没有 agent 成员（TAPs #49）：名片不列任何技能。'))
  return { card, notes }
}
