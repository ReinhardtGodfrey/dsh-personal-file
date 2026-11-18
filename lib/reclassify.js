import path from 'node:path'
import { askModel, parseModelJson } from './llm.js'
import {
  appendDailyLog,
  atomicWrite,
  backupFile,
  exists,
  localDate,
  localTime,
  pruneBackups,
  readText,
  sha256,
  stamp,
} from './store.js'

import { KIND_WEIGHTS, KIND_RUBRIC_BLOCK } from './ops.js'

const RUBRIC = KIND_RUBRIC_BLOCK

/**
 * 按插件自己的权重标准，对档案现有条目重新打分并归类：
 * 5 留在档案；3–4 迁到记忆库；≤2 从档案删掉（不写）。
 * 只改档案与记忆库，不改 data/state.json 的读取水位。
 */
export async function runReclassify(ctx, cfg, options = {}) {
  const startedAt = Date.now()
  const archivePath = cfg.archivePath
  const memoryPath = cfg.memoryPath
  const pluginRoot = cfg.pluginRoot
  const dataDir = path.join(pluginRoot, 'data')
  const logDir = path.join(pluginRoot, 'logs')
  const backupRoot = path.join(pluginRoot, 'backups')

  const archiveText = readText(archivePath)
  if (!archiveText) throw new Error('档案不存在，无法重新归类：' + archivePath)
  const memoryTextBefore = readText(memoryPath)
  const memoryExists = memoryTextBefore !== null

  const state = readState(dataDir)
  if (state.archiveHash && sha256(archiveText) !== state.archiveHash) {
    throw new Error('档案在本轮开始前被外部改动过（哈希不符），这次不重新归类')
  }
  if (memoryExists && state.memoryHash && sha256(memoryTextBefore) !== state.memoryHash) {
    throw new Error('记忆库在本轮开始前被外部改动过（哈希不符），这次不重新归类')
  }

  const { bullets } = parseBullets(archiveText)
  if (bullets.length === 0) {
    const result = emptyResult(startedAt, archiveText, memoryTextBefore)
    writeReclassLog(logDir, startedAt, result)
    return result
  }

  const prompt = buildScorePrompt(bullets)
  let scores = null
  let scoreError = null
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const raw = await askModel(ctx, cfg.llm, prompt, {
        temperature: 0.2,
        maxTokens: 6000,
        timeoutMs: 240000,
      })
      scores = normalizeScores(parseModelJson(raw), bullets.length)
      break
    } catch (error) {
      scoreError = error
    }
  }
  if (!scores) throw new Error('重新归类打分失败：' + errorText(scoreError))

  const decisions = bullets.map((bullet) => {
    const weight = scores.weights[bullet.index - 1]
    let action = 'drop'
    if (weight >= 5) action = 'keep'
    else if (weight >= 3) action = 'move'
    return { ...bullet, weight, action }
  })

  const keepIndexes = new Set(decisions.filter((d) => d.action === 'keep').map((d) => d.index))
  const kept = decisions.filter((d) => d.action === 'keep')
  const moved = decisions.filter((d) => d.action === 'move')
  const dropped = decisions.filter((d) => d.action === 'drop')

  let archiveAfter = archiveText
  let memoryAfter = memoryTextBefore
  let newArchiveText = archiveText
  let newMemoryText = memoryTextBefore

  if (moved.length > 0 || dropped.length > 0) {
    newArchiveText = rebuildArchive(archiveText, keepIndexes)
    if (newArchiveText === archiveText) newArchiveText = archiveText
    if (moved.length > 0) {
      const base = memoryTextBefore === null ? '# 记忆库（次要信息）\n\n## 自动记录\n' : memoryTextBefore
      const memoLines = new Set(base.split('\n').map((l) => l.trim()))
      const fresh = moved.filter((d) => !memoLines.has(d.raw.trim()))
      let next = base
      if (fresh.length > 0) {
        next = next.replace(/\s*$/, '\n') +
          '\n## 档案重新归类迁出（' + localDate(startedAt) + '）\n' +
          fresh.map((d) => d.raw).join('\n') + '\n'
      }
      newMemoryText = next
    }
    const stampName = stamp(startedAt)
    if (newArchiveText !== archiveText) backupFile(archivePath, backupRoot, stampName)
    if (newMemoryText !== memoryTextBefore && memoryExists) backupFile(memoryPath, backupRoot, stampName)
    if (newArchiveText !== archiveText) atomicWrite(archivePath, newArchiveText)
    if (newMemoryText !== memoryTextBefore) atomicWrite(memoryPath, newMemoryText)
    pruneBackups(backupRoot, cfg.keepBackups || 60)
    archiveAfter = newArchiveText
    memoryAfter = newMemoryText
    updateStateHashes(dataDir, state, archiveAfter, memoryAfter, startedAt)
  }

  const changed = archiveAfter !== archiveText || memoryAfter !== memoryTextBefore
  const result = {
    startedAt,
    status: changed ? '成功' : '成功无变更',
    total: bullets.length,
    kept: kept.length,
    moved: moved.length,
    dropped: dropped.length,
    archiveBeforeBytes: byteLength(archiveText),
    archiveAfterBytes: byteLength(archiveAfter),
    memoryBeforeBytes: memoryTextBefore === null ? 0 : byteLength(memoryTextBefore),
    memoryAfterBytes: memoryAfter === null ? 0 : byteLength(memoryAfter),
    backupPath: changed ? path.join(backupRoot, stamp(startedAt)) : '',
    decisions,
  }

  atomicWrite(
    path.join(dataDir, 'reclassify-result.json'),
    JSON.stringify({
      at: startedAt,
      mode: 'reclassify',
      status: result.status,
      total: result.total,
      kept: result.kept,
      moved: result.moved,
      dropped: result.dropped,
      archiveBeforeBytes: result.archiveBeforeBytes,
      archiveAfterBytes: result.archiveAfterBytes,
      memoryBeforeBytes: result.memoryBeforeBytes,
      memoryAfterBytes: result.memoryAfterBytes,
      backupPath: result.backupPath,
      items: decisions.map((d) => ({
        index: d.index,
        section: d.section,
        weight: d.weight,
        action: d.action,
        text: d.text,
      })),
    }, null, 2) + '\n',
  )

  writeReclassLog(logDir, startedAt, result)
  return result
}

function parseBullets(text) {
  const lines = text.split('\n')
  const bullets = []
  let section = ''
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.startsWith('### ')) {
      section = line.trim().replace(/^###\s+/, '')
      continue
    }
    if (line.startsWith('## ')) {
      section = line.trim().replace(/^##\s+/, '')
      continue
    }
    if (line.startsWith('- ')) {
      const body = line.slice(2).trim()
      bullets.push({ index: bullets.length + 1, section, text: body, raw: line, lineNo: i })
    }
  }
  return { bullets, lines }
}

function buildScorePrompt(bullets) {
  const list = bullets
    .map((b) => '[' + b.index + ']（' + b.section + '）' + b.text)
    .join('\n')
  return '你在给一份个人档案的条目分类定档，档案只收 identity（5 分）。先判断类别，再由类别定档，不要凭感觉给分数；只依据下面每条条目的文字判断，不要再从别处补信息。\n\n' +
    RUBRIC + '\n\n【档案条目】\n' + list + '\n\n' +
    '【要求】\n- 每条都要分类，index 从 1 到 ' + bullets.length + '，一项不能少。\n' +
    '- 只输出 JSON，不要解释：{"scores":[{"index":1,"kind":"identity"}]}'
}

function normalizeScores(parsed, count) {
  const list = parsed && Array.isArray(parsed.scores) ? parsed.scores : null
  if (!list) throw new Error('模型输出缺少 scores 数组')
  const weights = new Array(count).fill(5)
  const missing = []
  for (const item of list) {
    const index = Number(item && item.index)
    if (!Number.isInteger(index) || index < 1 || index > count) continue
    let weight = null
    if (typeof item.kind === 'string' && KIND_WEIGHTS[item.kind] != null) weight = KIND_WEIGHTS[item.kind]
    else if (Number.isFinite(Number(item.weight))) weight = Math.round(Number(item.weight))
    if (weight == null || weight < 1 || weight > 5) continue
    weights[index - 1] = weight
  }
  for (let i = 0; i < count; i += 1) {
    if (!list.some((item) => Math.round(Number(item && item.index)) === i + 1)) missing.push(i + 1)
  }
  return { weights, missing }
}

function rebuildArchive(text, keepLineSet) {
  const lines = text.split('\n')
  const out = []
  let header = null
  let sectionBullets = []
  let bulletNo = 0

  const flush = () => {
    if (header !== null && sectionBullets.length > 0) {
      out.push(header)
      out.push(...sectionBullets)
      out.push('')
    }
    header = null
    sectionBullets = []
  }

  for (const line of lines) {
    if (line.startsWith('### ')) {
      flush()
      header = line
      continue
    }
    if (line.startsWith('## ')) {
      flush()
      out.push(line)
      out.push('')
      continue
    }
    if (line.startsWith('- ')) {
      bulletNo += 1
      if (header !== null && keepLineSet.has(bulletNo)) sectionBullets.push(line)
      continue
    }
    if (header === null) {
      if (line.trim() === '' && out.length > 0 && out[out.length - 1] === '') continue
      out.push(line)
    }
  }
  flush()
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out.length > 0 ? out.join('\n') + '\n' : ''
}

function readState(dataDir) {
  const text = readText(path.join(dataDir, 'state.json'))
  if (!text) return {}
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function updateStateHashes(dataDir, state, archiveText, memoryText, at) {
  const next = { ...state }
  next.archiveHash = sha256(archiveText)
  if (memoryText !== null) next.memoryHash = sha256(memoryText)
  next.updatedAt = at
  next.reclassifiedAt = at
  atomicWrite(path.join(dataDir, 'state.json'), JSON.stringify(next, null, 2))
}

function writeReclassLog(logDir, startedAt, result) {
  const head = [
    '## ' + localTime(startedAt) + ' 重新归类（按插件权重）',
    '',
    '- 结果：' + result.status,
    '- 条目：' + result.total + ' 条；保留 5 分 ' + result.kept + ' 条；迁记忆库 ' + result.moved + ' 条；删除 ' + result.dropped + ' 条',
    '- 档案：' + result.archiveBeforeBytes + ' → ' + result.archiveAfterBytes + ' 字节',
    '- 记忆库：' + result.memoryBeforeBytes + ' → ' + result.memoryAfterBytes + ' 字节',
  ]
  if (result.backupPath) head.push('- 备份：' + result.backupPath)
  const movedLines = result.decisions.filter((d) => d.action === 'move')
  const droppedLines = result.decisions.filter((d) => d.action === 'drop')
  const body = ['### 迁入记忆库']
  if (movedLines.length === 0) body.push('- 无')
  for (const item of movedLines) body.push('-（权重 ' + item.weight + '）' + item.text)
  body.push('### 删除')
  if (droppedLines.length === 0) body.push('- 无')
  for (const item of droppedLines) body.push('-（权重 ' + item.weight + '）' + item.text)
  body.push('### 保留')
  body.push('- ' + result.kept + ' 条（逐条权重见 data/reclassify-result.json）')

  try {
    appendDailyLog(logDir, [...head, ...body, ''].join('\n') + '\n')
  } catch (error) {
    result.errors = ['日志写入失败：' + errorText(error)]
  }

  try {
    const digest = [
      '# 档案变更摘要（供 ClawBot 读取）',
      '',
      ...head,
      '',
      '### 迁入记忆库',
      ...(movedLines.length === 0 ? ['- 无'] : movedLines.map((d) => '-（权重 ' + d.weight + '）' + d.text)),
      '',
      '### 删除',
      ...(droppedLines.length === 0 ? ['- 无'] : droppedLines.map((d) => '-（权重 ' + d.weight + '）' + d.text)),
      '',
      '- 日期：' + localDate(startedAt),
      '- 完整日志：logs/' + localDate(startedAt) + '.md',
      '',
    ].join('\n') + '\n'
    atomicWrite(path.join(logDir, '最新变更.md'), digest)
  } catch (error) {
    result.errors = ['最新变更摘要写入失败：' + errorText(error)]
  }
}

function emptyResult(startedAt, archiveText, memoryText) {
  return {
    startedAt,
    status: '成功无变更',
    total: 0,
    kept: 0,
    moved: 0,
    dropped: 0,
    archiveBeforeBytes: byteLength(archiveText),
    archiveAfterBytes: byteLength(archiveText),
    memoryBeforeBytes: memoryText === null ? 0 : byteLength(memoryText),
    memoryAfterBytes: memoryText === null ? 0 : byteLength(memoryText),
    backupPath: '',
    decisions: [],
  }
}

function byteLength(text) {
  return text === null ? 0 : Buffer.byteLength(text, 'utf8')
}

function errorText(error) {
  if (!error) return '未知错误'
  if (typeof error === 'string') return error
  if (typeof error.message === 'string') return error.message
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}
