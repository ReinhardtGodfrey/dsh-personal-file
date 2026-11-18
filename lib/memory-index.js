/**
 * 记忆库索引：记录每条是从哪天、哪个会话、哪句原话写进来的。
 * 记忆库正文不动，只靠这个文件判断「半年没再提过的 3 分条目」。
 */

import fs from 'node:fs'
import path from 'node:path'
import { similarity } from './ops.js'

export const STALE_DAYS = 180
export const STALE_SIMILARITY = 0.6

export function indexFile(dataDir) {
  return path.join(dataDir, 'memory-index.json')
}

export function loadIndex(dataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(indexFile(dataDir), 'utf8'))
    return { entries: Array.isArray(parsed.entries) ? parsed.entries : [] }
  } catch {
    return { entries: [] }
  }
}

export function saveIndex(dataDir, index) {
  const file = indexFile(dataDir)
  const tmp = file + '.tmp'
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(tmp, JSON.stringify({ entries: index.entries }, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, file)
}

/** 记下本轮写进记忆库的条目；同一天同一条内容只记一次。 */
export function recordEntries(dataDir, entries) {
  const index = loadIndex(dataDir)
  const seen = new Set(index.entries.map((e) => e.date + '|' + normalize(e.line)))
  let added = 0
  for (const entry of entries || []) {
    const key = entry.date + '|' + normalize(entry.line)
    if (!entry.date || seen.has(key)) continue
    seen.add(key)
    index.entries.push({
      date: entry.date,
      topic: entry.topic || '',
      kind: entry.kind || '',
      line: entry.line,
      quote: entry.quote || '',
      session: entry.session || '',
      time: entry.time || '',
    })
    added++
  }
  if (added > 0) saveIndex(dataDir, index)
  return { added, total: index.entries.length }
}

/**
 * 半年没再提到过的 minor（3 分）条目：只清这些，4 分与档案不动。
 * 「又提到过」= 索引里有更晚的条目跟它相似（同一件事换了个说法）。
 */
export function staleMinorEntries(index, now = Date.now(), days = STALE_DAYS) {
  const cutoff = now - days * 24 * 60 * 60 * 1000
  const entries = Array.isArray(index && index.entries) ? index.entries : []
  const stale = []
  for (const entry of entries) {
    if (!entry || entry.kind !== 'minor' || !entry.date || !entry.line) continue
    const at = Date.parse(entry.date + 'T00:00:00+08:00')
    if (!(at < cutoff)) continue
    const mentionedLater = entries.some(
      (other) =>
        other &&
        other.line &&
        other.date &&
        other.date > entry.date &&
        similarity(other.line, entry.line) >= STALE_SIMILARITY,
    )
    if (!mentionedLater) stale.push(entry.line)
  }
  return stale
}

/** 清掉已经空了的主题节标题。 */
export function dropEmptyTopics(text) {
  const lines = String(text || '').split('\n')
  const kept = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim().startsWith('## 主题：')) {
      let next = i + 1
      while (next < lines.length && lines[next].trim() === '') next++
      if (next >= lines.length || lines[next].startsWith('#')) continue
    }
    kept.push(line)
  }
  const out = kept.join('\n').replace(/\n{3,}/g, '\n\n')
  return out.endsWith('\n') || out.length === 0 ? out : out + '\n'
}

function normalize(line) {
  return String(line || '')
    .replace(/^-\s*(\d{4}-\d{2}-\d{2}\s*[:：]\s*)?/, '')
    .replace(/\s+/g, '')
}
