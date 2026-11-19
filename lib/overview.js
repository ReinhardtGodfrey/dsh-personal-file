/**
 * 设置页数据：把个人档案和记忆库读成设置面板能直接渲染的结构。
 * 只读文件，不写任何东西。
 */

import fs from 'node:fs'
import path from 'node:path'
import { loadIndex } from './memory-index.js'
import { parseBans } from './bans.js'

const KIND_WEIGHT = { identity: 5, detail: 4, minor: 3, temp: 2 }

export function buildOverview(cfg, options = {}) {
  const now = Number(options.now) || Date.now()
  const archivePath = cfg.archivePath
  const memoryPath = cfg.memoryPath
  const dataDir = path.dirname(memoryPath)

  const archive = parseArchive(readText(archivePath))
  const memory = parseMemory(readText(memoryPath), loadIndexEntries(dataDir))
  const lastRun = readJson(path.join(dataDir, 'last-run.json'))
  const pending = countPending(dataDir)
  const bans = parseBans(readText(path.join(dataDir, '禁令待审.md')))

  const counts = { 5: 0, 4: 0, 3: 0, 2: 0, unknown: 0 }
  for (const topic of memory.topics) {
    for (const item of topic.items) {
      if ([5, 4, 3, 2].includes(item.weight)) counts[item.weight] += 1
      else counts.unknown += 1
    }
  }

  return {
    ok: true,
    generatedAt: formatStamp(now),
    archive: {
      path: archivePath,
      bytes: sizeOf(archivePath),
      modifiedAt: stampOf(archivePath),
      count: archive.count,
      sections: archive.sections,
    },
    memory: {
      path: memoryPath,
      bytes: sizeOf(memoryPath),
      modifiedAt: stampOf(memoryPath),
      counts,
      total: memory.total,
      topics: memory.topics,
    },
    pending,
    bans: {
      count: bans.length,
      items: bans.map((e) => ({
        banWeight: e.banWeight,
        line: e.line.replace(/^-\s*/, ''),
        quote: e.quote,
        session: e.session,
        time: e.time,
      })),
    },
    lastRun: {
      at: lastRun.startedAt ? formatStamp(Number(lastRun.startedAt)) : '',
      status: lastRun.status || '',
      messages: Number(lastRun.messages) || 0,
      sessions: Number(lastRun.sessions) || 0,
    },
  }
}

function parseArchive(text) {
  const sections = []
  let current = null
  let count = 0
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const heading = /^#{2,4}\s+(.+)$/.exec(line)
    if (heading) {
      current = { title: heading[1], items: [] }
      sections.push(current)
      continue
    }
    if (/^#\s/.test(line)) continue
    const bullet = /^-\s+(.+)$/.exec(line)
    if (!bullet) continue
    if (!current) {
      current = { title: '其他', items: [] }
      sections.push(current)
    }
    current.items.push(bullet[1])
    count += 1
  }
  return { count, sections: sections.filter((s) => s.items.length > 0) }
}

function parseMemory(text, entries) {
  const topics = []
  let current = null
  let total = 0
  const ensure = (name) => {
    const found = topics.find((t) => t.name === name)
    if (found) return found
    const created = { name, items: [] }
    topics.push(created)
    return created
  }

  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('#')) {
      const topicAt = line.indexOf('主题：')
      if (topicAt >= 0) current = ensure(line.slice(topicAt + 3).trim() || '未命名')
      else if (line.includes('自动记录')) current = ensure('自动记录')
      else current = ensure(line.replace(/^#+\s*/, '').trim() || '其他')
      continue
    }
    if (!current) continue
    const bullet = /^-\s*(.*)$/.exec(line)
    if (!bullet) continue
    const body = bullet[1]
    const dated = /^(\d{4}-\d{2}-\d{2})\s*[:：]\s*(.*)$/.exec(body)
    const textBody = dated ? dated[2] : body
    const entry = entries.get(normalize(body))
    const weight = entry && KIND_WEIGHT[entry.kind] ? KIND_WEIGHT[entry.kind] : 0
    current.items.push({
      date: (entry && entry.date) || (dated ? dated[1] : ''),
      weight,
      text: textBody,
      quote: (entry && entry.quote) || '',
      session: (entry && entry.session) || '',
      time: (entry && entry.time) || '',
    })
    total += 1
  }

  for (const topic of topics) {
    topic.items.sort((a, b) => (b.date || '').localeCompare(a.date || ''))
  }
  return { total, topics: topics.filter((t) => t.items.length > 0) }
}

function loadIndexEntries(dataDir) {
  const map = new Map()
  let entries = []
  try {
    entries = loadIndex(dataDir).entries
  } catch {
    entries = []
  }
  for (const entry of entries) {
    if (!entry || !entry.line) continue
    const key = normalize(entry.line)
    if (!map.has(key)) map.set(key, entry)
  }
  return map
}

function countPending(dataDir) {
  const text = readText(path.join(dataDir, '待确认.md'))
  const lines = text.split('\n').filter((line) => /^-\s/.test(line.trim()))
  return { count: lines.length, items: lines.slice(0, 5).map((line) => line.trim().replace(/^-\s*/, '')) }
}

function normalize(line) {
  return String(line || '')
    .replace(/^-\s*/, '')
    .replace(/^\d{4}-\d{2}-\d{2}\s*[:：]\s*/, '')
    .replace(/\s+/g, '')
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function sizeOf(file) {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

function stampOf(file) {
  try {
    return formatStamp(fs.statSync(file).mtimeMs)
  } catch {
    return ''
  }
}

function formatStamp(ms) {
  const d = new Date(Number(ms))
  if (Number.isNaN(d.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
}
