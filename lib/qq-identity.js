/**
 * QQ 通道的身份判定：只认 QQ 号，不认会话标题。
 *
 * 依据：
 * - `qq-bridge-config.json` 的 `绑定[]` 记录「聊天 → DSH 会话」，每行有 `类型 / 号码 / 会话 / 称呼`；
 * - 历史绑定在 `qq-bridge-config.json.bak-*` 里，按文件名顺序回放，当前配置最后覆盖；
 * - 私聊只接受 `条.user_id === 行.号码` 的消息，所以会话里的 qq 消息必然来自绑定号码；
 * - 群消息正文带前缀「昵称（QQ号）：」，号码从前缀里读。
 *
 * 判定结果只有三种：own（本人）、other（别人）、unknown（判不出）。
 * 调用方对 other 与 unknown 一律丢弃。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CONFIG_NAME = 'qq-bridge-config.json'
const GROUP_PREFIX = /^([^\n（(]{1,24})[（(]\s*(\d{5,12})\s*[）)]\s*[:：]\s*/

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function bindingsOf(json) {
  const rows = json && Array.isArray(json.绑定) ? json.绑定 : []
  const out = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const number = String(row.号码 ?? '').trim()
    const session = String(row.会话 ?? '').trim()
    if (!session || !number) continue
    out.push({
      number,
      session,
      kind: String(row.类型 ?? '').trim(),
      name: String(row.称呼 ?? '').trim(),
    })
  }
  return out
}

/**
 * 读当前配置与所有 .bak-* 备份，返回会话 → 绑定行 的映射。
 * 备份按名字升序回放（旧的先、新的后），当前配置最后写入，所以以当前为准。
 */
export function loadBindings(dshHome) {
  const dir = dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const map = new Map()
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return map
  }
  const current = names.includes(CONFIG_NAME) ? CONFIG_NAME : null
  const backups = names
    .filter((n) => n.startsWith(CONFIG_NAME + '.bak'))
    .sort((a, b) => a.localeCompare(b, 'en'))
  const ordered = [...backups, ...(current ? [current] : [])]
  for (const name of ordered) {
    const rows = bindingsOf(readJson(path.join(dir, name)))
    for (const row of rows) map.set(row.session, row)
  }
  return map
}

/** 从群消息正文前缀里读发送人的 QQ 号；没有前缀返回 null。 */
export function groupSenderNumber(text) {
  const m = String(text || '').match(GROUP_PREFIX)
  return m ? m[2] : null
}

/**
 * 判定一条消息是不是本人说的。
 * @param {Map} bindings loadBindings 的返回值
 * @param {{sessionId: string, sourceKind: string, text: string, ownQq?: string}} input
 *   ownQq 是本人 QQ 号；留空表示没配置，QQ 通道一律判成 other（不写进档案）
 * @returns {'own'|'other'|'unknown'}
 */
export function classifyMessage(bindings, { sessionId, sourceKind, text, ownQq = '' }) {
  if (sourceKind === 'user') return 'own'
  if (sourceKind !== 'qq') return 'unknown'
  const mine = String(ownQq || '').trim()
  if (!mine) return 'other'
  const groupNumber = groupSenderNumber(text)
  if (groupNumber) return groupNumber === mine ? 'own' : 'other'
  const bound = bindings && bindings.get(sessionId)
  if (bound) return bound.number === mine ? 'own' : 'other'
  return 'unknown'
}
