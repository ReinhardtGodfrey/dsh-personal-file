import path from 'node:path'
import { atomicWrite, readText } from './store.js'

// 「待确认」区：模型拿不准、但又确实有原话支撑的信息先放这里，
// 不进档案也不进记忆库；下次同主题再出现时正常 add，插件会把它移走。
const PENDING_HEADER = '# 待确认\n'
const SEP = ' ｜依据'

export function pendingFile(dataDir) {
  return path.join(dataDir, '待确认.md')
}

function normalizeBase(text) {
  return String(text || '')
    .replace(/\s+/g, '')
    .replace(/^-/, '')
    .trim()
}

export function readPendingEntries(dataDir) {
  const text = readText(pendingFile(dataDir))
  if (!text) return []
  const entries = []
  for (const line of text.split('\n')) {
    if (!line.startsWith('- ')) continue
    const raw = line.trim()
    const base = raw.replace(/\s*｜依据[\s\S]*$/, '').replace(/^- /, '').trim()
    if (base) entries.push({ raw, line: base })
  }
  return entries
}

export function readPendingPrompt(dataDir, limit = 40) {
  return readPendingEntries(dataDir).map((entry) => entry.raw).slice(-limit)
}

export function appendPending(dataDir, entries, live) {
  if (!live || !Array.isArray(entries) || entries.length === 0) return 0
  const file = pendingFile(dataDir)
  const existing = readPendingEntries(dataDir)
  const known = new Set(existing.map((entry) => normalizeBase(entry.line)))
  const lines = existing.map((entry) => entry.raw)
  let added = 0
  for (const entry of entries) {
    const line = String(entry.line || '').trim()
    const base = normalizeBase(line)
    if (!base || known.has(base)) continue
    known.add(base)
    lines.push('- ' + line + SEP + '「' + String(entry.quote || '').replace(/\s+/g, ' ').trim() + '」｜' + String(entry.session || '') + ' · ' + String(entry.time || ''))
    added += 1
  }
  if (added === 0) return 0
  atomicWrite(file, PENDING_HEADER + lines.join('\n') + '\n')
  return added
}

export function promotePending(dataDir, lines, live) {
  if (!live || !Array.isArray(lines) || lines.length === 0) return 0
  const file = pendingFile(dataDir)
  const existing = readPendingEntries(dataDir)
  if (existing.length === 0) return 0
  const promoted = new Set(lines.map((line) => normalizeBase(line)))
  const kept = existing.filter((entry) => !promoted.has(normalizeBase(entry.line)))
  const removed = existing.length - kept.length
  if (removed > 0) {
    atomicWrite(file, PENDING_HEADER + kept.map((entry) => entry.raw).join('\n') + '\n')
  }
  return removed
}
