/**
 * 禁令待审：模型提出的明确禁令先落这里，等本人审批通过才进规则档案。
 * 禁令分三档：5 绝对禁区、4 必须先问、3 尽量避开。
 */

import fs from 'node:fs'
import path from 'node:path'
import { atomicWrite, backupFile, localDate, readText } from './store.js'
import { similarity } from './ops.js'

export const BANS_HEADER = '# 禁令待审（等你审批）\n\n每条一行：- [档位] 禁令内容 ｜依据：原话 ｜会话：会话标识 ｜时间：消息时间\n\n'

/** 和硬性规则/记忆库重合到这个程度，就不进待审清单。 */
export const RULES_SIMILARITY = 0.6
export const MEMORY_SIMILARITY = 0.8

const SEP = ' ｜依据：'
const SESSION_SEP = ' ｜会话：'
const TIME_SEP = ' ｜时间：'
const LEAD = /^-\s*\[(\d)\]\s*/

export function bansFile(dataDir) {
  return path.join(dataDir, '禁令待审.md')
}

export function formatBan(entry) {
  const quote = String(entry.quote || '').replace(/\s+/g, ' ').trim()
  const session = String(entry.session || '').trim()
  const time = String(entry.time || '').trim()
  const line = String(entry.line || '').replace(/\s+/g, ' ').trim()
  return `- [${entry.banWeight || 4}] ${line}${SEP}${quote}${SESSION_SEP}${session}${TIME_SEP}${time}`
}

export function parseBans(text) {
  const out = []
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim()
    const match = LEAD.exec(line)
    if (!match) continue
    const rest = line.slice(match[0].length)
    const body = rest.split(SEP)[0].trim()
    const quote = partOf(rest, SEP, SESSION_SEP)
    const session = partOf(rest, SESSION_SEP, TIME_SEP)
    const time = partOf(rest, TIME_SEP, null)
    out.push({ banWeight: Number(match[1]), line: body, quote, session, time, raw: line })
  }
  return out
}

function partOf(text, startSep, endSep) {
  const start = text.indexOf(startSep)
  if (start < 0) return ''
  const from = start + startSep.length
  const end = endSep ? text.indexOf(endSep, from) : -1
  return (end < 0 ? text.slice(from) : text.slice(from, end)).trim()
}

export function readBans(dataDir) {
  const file = bansFile(dataDir)
  if (!fs.existsSync(file)) return { file, entries: [], text: '' }
  const text = fs.readFileSync(file, 'utf8')
  return { file, entries: parseBans(text), text }
}

export function bansPrompt(dataDir, limit = 30) {
  return readBans(dataDir)
    .entries.slice(-limit)
    .map((e) => `- [${e.banWeight}] ${e.line}`)
  .join('\n')
}

function normalize(text) {
  return String(text || '')
    .replace(LEAD, '')
    .replace(/\s+/g, '')
    .toLowerCase()
}

/** 把新禁令追加进待审清单，按正文去重；live=false 时只统计不写盘。 */
export function appendBans(dataDir, entries, live) {
  const result = { added: [], skipped: 0 }
  if (!entries || !entries.length) return result
  const { file, entries: existing } = readBans(dataDir)
  const known = new Set(existing.map((e) => normalize(e.line)))
  const fresh = []
  for (const entry of entries) {
    const key = normalize(entry.line)
    if (!key || known.has(key)) {
      result.skipped += 1
      continue
    }
    known.add(key)
    fresh.push(entry)
    result.added.push(entry)
  }
  if (!fresh.length || live === false) return result
  const existingText = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : BANS_HEADER
  const block = fresh.map(formatBan).join('\n') + '\n'
  atomicWrite(file, existingText + block)
  return result
}

function lineCandidates(text) {
  const out = []
  for (const raw of String(text || '').split('\n')) {
    const line = raw
      .replace(/^\s*[-*]\s*/, '')
      .replace(/^\s*#{1,6}\s*/, '')
      .replace(/\s*\|\s*/g, ' ')
      .trim()
    if (line.length >= 6) out.push(line)
  }
  return out
}

function bestScore(text, candidates) {
  let best = 0
  for (const candidate of candidates) {
    const score = similarity(text, candidate)
    if (score > best) best = score
  }
  return best
}

/**
 * 自审：跟硬性规则、记忆库、待审清单里已有的东西做相似度比对。
 * 规则 ≥0.6 视为已覆盖（不重复审批）；记忆库 ≥0.8 视为已经记过这件事。
 */
export function screenBans(entries, { rulesText = '', memoryText = '', existing = [] } = {}) {
  const kept = []
  const skipped = []
  const taken = existing.map((e) => normalize(e.line))
  const ruleLines = lineCandidates(rulesText)
  const memoryLines = lineCandidates(memoryText)
  for (const entry of entries || []) {
    const key = normalize(entry.line)
    if (!key) continue
    if (taken.includes(key)) {
      skipped.push({ entry, reason: '待审清单里已有', score: 1 })
      continue
    }
    const ruleScore = bestScore(entry.line, ruleLines)
    if (ruleScore >= RULES_SIMILARITY) {
      skipped.push({ entry, reason: '硬性规则里已有', score: ruleScore })
      continue
    }
    const memoryScore = bestScore(entry.line, memoryLines)
    if (memoryScore >= MEMORY_SIMILARITY) {
      skipped.push({ entry, reason: '记忆库里已有', score: memoryScore })
      continue
    }
    taken.push(key)
    kept.push(entry)
  }
  return { kept, skipped }
}

/** 自审通过才进待审清单；返回 added / skipped（skipped 带原因，写进日志）。 */
export function queueBans(cfg, dataDir, entries, live) {
  const { entries: existing } = readBans(dataDir)
  const screened = screenBans(entries, {
    rulesText: readText(cfg.rulesPath),
    memoryText: readText(cfg.memoryPath),
    existing,
  })
  const appended = appendBans(dataDir, screened.kept, live)
  return { added: appended.added, skipped: screened.skipped }
}


/** 审批通过的禁令从待审清单里删掉（按正文匹配）。 */
export function promoteBans(dataDir, lines, live) {
  if (!lines || !lines.length) return 0
  const { file, entries } = readBans(dataDir)
  if (!entries.length) return 0
  const approved = new Set(lines.map(normalize))
  const kept = entries.filter((e) => !approved.has(normalize(e.line)))
  const removed = entries.length - kept.length
  if (!removed || live === false) return removed
  const text = BANS_HEADER + kept.map((e) => e.raw).join('\n') + (kept.length ? '\n' : '')
  atomicWrite(file, text)
  return removed
}

export const RULES_SECTION_HEADING = '## 明确禁令（经审批）'
const RULES_SECTION_PATTERN = /^##\s*明确禁令/
const EMPTY_NOTE = '暂时没有经审批的禁令。'
const EMPTY_NOTE2 = '新禁令先落'

/** 规则文件里「明确禁令」节的追加：审批通过的禁令按档位写成一行。 */
export function insertApprovedBans(rulesText, approved, dateText = localDate()) {
  const lines = String(rulesText || '').split('\n')
  const start = lines.findIndex((l) => RULES_SECTION_PATTERN.test(l.trim()))
  if (start < 0) throw new Error('规则文件里找不到「明确禁令」节')
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].trim().startsWith('<!--')) {
      end = i
      break
    }
  }
  const middle = lines
    .slice(start + 1, end)
    .filter((l) => !l.includes(EMPTY_NOTE) && !l.includes(EMPTY_NOTE2))
  while (middle.length && !middle[middle.length - 1].trim()) middle.pop()
  const bullets = approved.map((e) => {
    const body = String(e.line || '').replace(/^-\s*/, '').trim()
    return `- [${e.banWeight}] ${dateText}：${body}`
  })
  const rebuilt = [
    ...lines.slice(0, start + 1),
    '',
    ...middle,
    ...(middle.length ? [''] : []),
    ...bullets,
    '',
    ...lines.slice(end),
  ]
  return rebuilt.join('\n').replace(/\n{3,}/g, '\n\n')
}

/**
 * 设置页审批：approve 里的写进规则文件「明确禁令」节，reject 里的直接丢掉。
 * 写规则文件前先备份到插件 backups/<stamp>/。
 */
export function decideBans(cfg, { approve = [], reject = [], stampName, live = true } = {}) {
  const dataDir = path.dirname(cfg.memoryPath)
  const { entries } = readBans(dataDir)
  const approveSet = new Set(approve.map(normalize))
  const rejectSet = new Set(reject.map(normalize))
  const approved = entries.filter((e) => approveSet.has(normalize(e.line)))
  const rejected = entries.filter((e) => rejectSet.has(normalize(e.line)))
  if (!approved.length && !rejected.length) return { approved: [], rejected: [], backupPath: null }
  if (live === false) return { approved, rejected, backupPath: null }

  let backupPath = null
  if (approved.length) {
    const text = fs.readFileSync(cfg.rulesPath, 'utf8')
    backupPath = backupFile(cfg.rulesPath, path.join(cfg.pluginRoot, 'backups'), stampName)
    atomicWrite(cfg.rulesPath, insertApprovedBans(text, approved))
  }
  const gone = new Set([...approveSet, ...rejectSet])
  const kept = entries.filter((e) => !gone.has(normalize(e.line)))
  atomicWrite(bansFile(dataDir), BANS_HEADER + kept.map((e) => e.raw).join('\n') + (kept.length ? '\n' : ''))
  return { approved, rejected, backupPath }
}
