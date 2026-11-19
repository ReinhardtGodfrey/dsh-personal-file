/**
 * 旧条目归组：记忆库里早期写入的条目没有主题、档位和日期前缀。
 * 这里让模型给每条判主题与档位、只从正文里抽取明确写出的日期，然后按主题重排。
 * 只动记忆库，不碰个人档案；写入前备份，改完更新索引与状态哈希。
 */

import path from 'node:path'
import fs from 'node:fs'
import { atomicWrite, backupFile, exists, readText, sha256, localDate, localTime, stamp } from './store.js'
import { loadIndex, saveIndex } from './memory-index.js'
import { KIND_WEIGHTS } from './ops.js'
import { askModel, parseModelJson } from './llm.js'

const DATE_AT_START = /^(\d{4}-\d{2}-\d{2})[ 　]+/
const MAX_TOPIC = 20
const CHUNK_ITEMS = 60

function entryText(line) {
  return String(line || '').replace(/^-\s*/, '').trim()
}

export function parseMemory(text) {
  const lines = String(text || '').split('\n')
  const sections = []
  const head = []
  let current = null
  for (const line of lines) {
    const heading = line.match(/^##\s+(.*)$/)
    if (heading) {
      current = { title: heading[1].trim(), lines: [], items: [] }
      sections.push(current)
      current.lines.push(line)
      continue
    }
    if (!current) {
      head.push(line)
      continue
    }
    current.lines.push(line)
    if (line.startsWith('- ')) {
      const raw = line.slice(2).trim()
      const dated = raw.match(/^(\d{4}-\d{2}-\d{2})[：:]\s*(.*)$/)
      current.items.push({ raw, text: dated ? dated[2].trim() : raw, date: dated ? dated[1] : null })
    } else if (!/^主题：/.test(current.title) && line.trim() !== '' && !line.startsWith('#')) {
      // 早期补扫与迁移写进非主题节的条目，有一部分没有行首「- 」，同样是条目，不能漏掉。
      const raw = line.trim()
      const dated = raw.match(/^(\d{4}-\d{2}-\d{2})[：:]\s*(.*)$/)
      current.items.push({ raw, text: dated ? dated[2].trim() : raw, date: dated ? dated[1] : null })
    }
  }
  return { preamble: head, sections }
}

export function rebuildMemory(parsed, classified) {
  const keep = parsed.sections.filter((s) => /^主题：/.test(s.title))
  const topics = new Map()
  for (const section of keep) {
    const title = section.title.match(/^主题：([^ ]+)/)
    if (title) topics.set(title[1].trim(), section)
  }
  const leftovers = []
  for (const item of classified) {
    let section = topics.get(item.topic)
    if (!section) {
      section = { title: '主题：' + item.topic, lines: [], items: [] }
      topics.set(item.topic, section)
      keep.push(section)
    }
    leftovers.push({ section, item })
  }
  for (const entry of leftovers) {
    const { section, item } = entry
    if (section.lines.length === 0) section.lines.push('## ' + section.title)
    const prefix = item.date ? item.date + '：' : ''
    section.lines.push('- ' + prefix + item.text)
    section.items.push({ raw: prefix + item.text, text: item.text, date: item.date })
  }
  const out = [...(parsed.preamble || [])]
  for (const section of keep) {
    const body = section.lines.length > 0 ? section.lines : ['## ' + section.title]
    out.push(...body)
    if (out[out.length - 1] !== '') out.push('')
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out.join('\n') + '\n'
}

function legacyCandidates(parsed) {
  const list = []
  for (const section of parsed.sections) {
    if (/^主题：/.test(section.title)) continue
    for (const item of section.items) {
      list.push(item)
    }
  }
  return list
}

export function buildScorePrompt(items, topics) {
  const list = items.map((item, i) => '[' + (i + 1) + '] ' + item.text).join('\n')
  const topicLine = topics.length ? topics.join('、') : '（还没有主题）'
  return `你在给一个记忆库里的旧条目补元数据。这些条目是早期写入的，没有主题、没有档位、没有日期。

【已有主题】尽量复用：${topicLine}

【档位】
- identity = 稳定身份、长期关系、明确禁令、长期工作方式、反复出现的偏好
- detail = 长期有用的具体事实或偏好
- minor = 次要但值得留下的信息
- temp = 临时状态、一次性安排、情绪

【日期】只从这一行正文里明确写出的日期照抄成 YYYY-MM-DD（例如正文开头写着「2026-10-24」）；正文里读不到就留空字符串，绝对不要按语气猜、不要用今天。

【条目】
${list}

【输出】只输出 JSON，覆盖每一个编号，不要解释：
{"items":[{"i":1,"topic":"主题名","kind":"detail","date":""}]}
- topic：2–10 个字的名词短语，同一件事必须用同一个主题名；实在归不进去用「其他」
- kind：identity / detail / minor / temp 之一`
}

function normalizeDate(value) {
  const s = String(value || '').trim()
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ''
}

export async function runRegroup(ctx, cfg, options = {}) {
  const startedAt = Date.now()
  const result = {
    status: '失败',
    trigger: options.trigger || 'regroup',
    startedAt,
    total: 0,
    moved: 0,
    dated: 0,
    undated: 0,
    topics: 0,
    keptTopics: 0,
    backupPath: null,
    errors: [],
  }

  const memoryPath = cfg.memoryPath
  if (!memoryPath || !exists(memoryPath)) throw new Error('记忆库文件不存在：' + memoryPath)
  const dataDir = cfg.dataDir || path.join(cfg.pluginRoot, 'data')
  const logDir = cfg.logDir || path.join(cfg.pluginRoot, 'logs')
  const backupRoot = cfg.backupRoot || path.join(cfg.pluginRoot, 'backups')
  const memoryText = readText(memoryPath) || ''
  const archiveText = exists(cfg.archivePath) ? readText(cfg.archivePath) || '' : ''

  // 外部改动保护：状态里的哈希和当前文件对不上就停，不覆盖别人手改的内容。
  const statePath = path.join(dataDir, 'state.json')
  if (exists(statePath)) {
    try {
      const state = JSON.parse(readText(statePath) || '{}')
      if (state.archiveHash && state.archiveHash !== sha256(archiveText)) {
        throw new Error('个人档案在本轮开始后被外部修改，这次不写')
      }
      if (state.memoryHash && state.memoryHash !== sha256(memoryText)) {
        throw new Error('记忆库在本轮开始后被外部修改，这次不写')
      }
    } catch (error) {
      if (error && /外部修改/.test(error.message)) throw error
      result.errors.push('状态读取失败，跳过哈希校验：' + ((error && error.message) || error))
    }
  }

  const parsed = parseMemory(memoryText)
  const items = legacyCandidates(parsed)
  result.total = items.length
  if (items.length === 0) {
    result.status = '成功无变更'
    return result
  }

  const existingTopics = parsed.sections
    .map((s) => s.title.match(/^主题：([^ ]+)/))
    .filter(Boolean)
    .map((m) => m[1].trim())
  result.keptTopics = existingTopics.length

  const classified = []
  try {
    for (let start = 0; start < items.length; start += CHUNK_ITEMS) {
      const slice = items.slice(start, start + CHUNK_ITEMS)
      const prompt = buildScorePrompt(slice, existingTopics)
      const text = await askModel(ctx, cfg.llm, prompt, { maxTokens: 8000, timeoutMs: 240000 })
      const data = parseModelJson(text)
      const rows = Array.isArray(data.items) ? data.items : []
      const byIndex = new Map()
      for (const row of rows) {
        const i = Number(row && row.i)
        if (Number.isInteger(i) && i >= 1 && i <= slice.length) byIndex.set(i, row)
      }
      if (byIndex.size === 0) throw new Error('模型没有返回任何可用的条目判定')
      for (let i = 1; i <= slice.length; i++) {
        const item = slice[i - 1]
        const row = byIndex.get(i)
        const topic = row ? String(row.topic || '').trim().slice(0, MAX_TOPIC) : ''
        const kind = row && KIND_WEIGHTS[String(row.kind || '')] !== undefined ? String(row.kind) : 'detail'
        let date = normalizeDate(row && row.date)
        const atStart = item.text.match(DATE_AT_START)
        if (!date && atStart) date = atStart[1]
        const textOnly = atStart ? item.text.slice(atStart[0].length).trim() : item.text
        classified.push({
          text: textOnly,
          topic: topic || '其他',
          kind,
          date: date || '',
          missing: !row,
        })
      }
    }
  } catch (error) {
    result.errors.push('模型判定失败：' + ((error && error.message) || error))
    throw new Error(result.errors[result.errors.length - 1])
  }
  if (result.errors.length === 0 && classified.some((c) => c.missing)) {
    result.errors.push('有 ' + classified.filter((c) => c.missing).length + ' 条没有拿到判定，按 detail/其他 落盘')
  }

  const newText = rebuildMemory(parsed, classified)
  result.moved = classified.length
  result.dated = classified.filter((c) => c.date).length
  result.undated = result.moved - result.dated
  const topicCount = new Set(classified.map((c) => c.topic)).size
  result.topics = topicCount

  // 备份 → 写入 → 索引 → 状态哈希
  const backupStamp = stamp(startedAt)
  const backupDir = path.join(backupRoot, backupStamp)
  result.backupPath = backupFile(memoryPath, backupRoot, backupStamp)
  const indexPath = path.join(dataDir, 'memory-index.json')
  if (exists(indexPath)) {
    try {
      fs.mkdirSync(backupDir, { recursive: true })
      fs.copyFileSync(indexPath, path.join(backupDir, 'memory-index.json'))
    } catch {
      result.errors.push('索引备份失败，继续执行')
    }
  }

  atomicWrite(memoryPath, newText)

  const index = loadIndex(dataDir)
  if (!Array.isArray(index.entries)) index.entries = []
  for (const item of classified) {
    const line = '- ' + (item.date ? item.date + '：' : '') + item.text
    const duplicate = index.entries.some((e) => (e.line || '').replace(/^-\s*/, '') === line.replace(/^-\s*/, ''))
    if (duplicate) continue
    index.entries.push({
      date: item.date,
      topic: item.topic,
      kind: item.kind,
      line,
      quote: '',
      session: 'legacy',
      time: '',
    })
  }
  saveIndex(dataDir, index)

  if (exists(statePath)) {
    try {
      const state = JSON.parse(readText(statePath) || '{}')
      state.memoryHash = sha256(newText)
      state.archiveHash = sha256(archiveText)
      state.regroupedAt = startedAt
      atomicWrite(statePath, JSON.stringify(state, null, 2) + '\n')
    } catch (error) {
      result.errors.push('状态哈希更新失败：' + ((error && error.message) || error))
    }
  }

  result.status = result.errors.length > 0 ? '完成但有错误' : '成功'

  // 日志与变更摘要
  const head = [
    '## ' + localTime(startedAt) + ' 旧条目归类',
    '',
    '- 结果：' + result.status,
    '- 处理：' + result.total + ' 条旧条目，归到 ' + result.topics + ' 个主题（原有 ' + result.keptTopics + ' 个主题保留）',
    '- 日期：' + result.dated + ' 条从正文取到日期，' + result.undated + ' 条无法确定日期',
    '- 备份：' + (result.backupPath || '（无）'),
  ]
  const body = ['### 归组后主题']
  for (const [name, count] of topicSummary(classified)) body.push('- ' + name + '：' + count + ' 条')
  if (result.errors.length > 0) {
    body.push('### 错误')
    for (const message of result.errors) body.push('- ' + message)
  }
  try {
    fs.mkdirSync(logDir, { recursive: true })
    fs.appendFileSync(path.join(logDir, localDate(startedAt) + '.md'), [...head, ...body, ''].join('\n') + '\n', 'utf8')
    const digest = [
      '# 档案变更摘要（供 ClawBot 读取）',
      '',
      ...head,
      ...body,
      '',
      '- 日期：' + localDate(startedAt),
      '- 完整日志：logs/' + localDate(startedAt) + '.md',
      '',
    ].join('\n') + '\n'
    atomicWrite(path.join(logDir, '最新变更.md'), digest)
    const historyDir = path.join(logDir, '变更历史')
    fs.mkdirSync(historyDir, { recursive: true })
    const d = new Date(startedAt)
    const p = (n) => String(n).padStart(2, '0')
    atomicWrite(
      path.join(historyDir, d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '.md'),
      digest,
    )
  } catch (error) {
    result.errors.push('日志写入失败：' + ((error && error.message) || error))
  }

  try {
    atomicWrite(path.join(dataDir, 'regroup-result.json'), JSON.stringify(result, null, 2) + '\n')
  } catch {
    // 结果文件写不下不算失败
  }
  return result
}

function topicSummary(classified) {
  const counts = new Map()
  for (const item of classified) counts.set(item.topic, (counts.get(item.topic) || 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1])
}
