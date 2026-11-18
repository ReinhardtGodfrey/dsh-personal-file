import fs from 'node:fs'
import path from 'node:path'
import {
  listSessionFiles,
  readSessionAppend,
  userMessageText,
  isHisMessage,
  messageId,
} from './reader.js'
import {
  ensureDir,
  exists,
  readText,
  atomicWrite,
  sha256,
  localDate,
  localTime,
  stamp,
  backupFile,
  pruneBackups,
  appendDailyLog,
} from './store.js'
import { askModel, parseModelJson } from './llm.js'
import { buildPrompt, validateOps, applyOps, archiveTooLarge, LIMITS } from './ops.js'

const MEMORY_HEADER = '# 记忆库（次要信息）\n\n## 自动记录\n'
const CHUNK_MESSAGES = 30
const CHUNK_CHARS = 18000
const LOCK_MAX_AGE_MS = 30 * 60 * 1000

/** 大肥鱼接入qq 工作区里，只认这几个昵称通道发来的消息（其余是别人聊的）。 */
export const ALLOWED_QQ_TITLES = ['噗噗', '噗噗1', '噗噗2', '噗噗3', '噗噗4']

export function normalizeTitle(title) {
  return String(title || '').replace(/\s+/g, '')
}

export function titleAllowed(title) {
  return ALLOWED_QQ_TITLES.includes(normalizeTitle(title))
}

/** 项目目录名含 qq 的，就是 QQ 桥接工作区。 */
export function isQqWorkspace(project) {
  return /qq/i.test(String(project || ''))
}

/** 取会话最后一次标题（用户可能改过标题，以最后一次为准）。 */
export function extractTitle(events) {
  let title = null
  for (const event of events) {
    if (event && event.type === 'session/title') {
      const data = event.data
      if (data && typeof data.title === 'string' && data.title.trim()) title = data.title.trim()
      else if (typeof data === 'string' && data.trim()) title = data.trim()
    }
  }
  return title
}

export function titlesPath(dataDir) {
  return path.join(dataDir, 'qq-titles.json')
}

export function loadTitles(dataDir) {
  const text = readText(titlesPath(dataDir))
  if (!text) return {}
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function saveTitles(dataDir, titles) {
  atomicWrite(titlesPath(dataDir), JSON.stringify(titles, null, 2) + '\n')
}

/**
 * 历史补扫：把安装时刻（state.installedAt）之前的本人消息再走一遍抽取。
 * 与日常运行的区别：从每个会话文件头开始读、只收 time < installedAt 的消息；
 * 大肥鱼接入qq 工作区只收标题为 噗噗/噗噗1..4 的 QQ 会话，其余 QQ 通道跳过。
 * 结果一次性写档案/记忆库（写前备份），并同步更新 state 里的文件哈希。
 */
export async function runBackfill(ctx, cfg, options = {}) {
  const days = cfg.pluginRoot
  const dataDir = path.join(days, 'data')
  const logDir = path.join(days, 'logs')
  const backupRoot = path.join(days, 'backups')
  ensureDir(dataDir)

  const startedAt = options.startedAt || Date.now()
  const mode = (readText(path.join(dataDir, 'mode.txt')) || '').trim()
  const live = mode === 'live'
  const result = {
    trigger: options.trigger || 'backfill',
    mode: live ? 'live' : 'dry-run',
    status: '失败',
    startedAt,
    messages: 0,
    sessions: 0,
    filtered: 0,
    chunks: 0,
    added: [],
    replaced: [],
    deleted: [],
    rejected: [],
    errors: [],
    backupPath: null,
    skippedChunks: 0,
  }

  if (exists(path.join(dataDir, 'disabled'))) {
    result.status = '跳过'
    result.errors.push('data/disabled 存在，本次不运行')
    return result
  }
  if (!acquireLock(dataDir, startedAt, LOCK_MAX_AGE_MS)) {
    result.status = '跳过'
    result.errors.push('另一个运行还没结束（锁未过期）')
    return result
  }

  try {
    await runBackfillBody(ctx, cfg, result, { dataDir, logDir, backupRoot, startedAt, live, force: options.force === true })
  } catch (error) {
    result.status = '失败'
    result.errors.push(errorText(error))
  } finally {
    releaseLock(dataDir)
  }

  result.finishedAt = Date.now()
  result.durationMs = result.finishedAt - startedAt
  writeBackfillLog(logDir, cfg, result)
  try {
    atomicWrite(
      path.join(dataDir, 'backfill-state.json'),
      JSON.stringify({
        lastBackfillAt: result.startedAt,
        finishedAt: result.finishedAt,
        status: result.status,
        mode: result.mode,
        messages: result.messages,
        sessions: result.sessions,
        filtered: result.filtered,
        chunks: result.chunks,
        skippedChunks: result.skippedChunks,
        added: result.added.length,
        replaced: result.replaced.length,
        deleted: result.deleted.length,
        errors: result.errors.slice(0, 5),
      }, null, 2) + '\n',
    )
  } catch {
    // 诊断文件写不进去不影响主流程
  }
  return result
}

async function runBackfillBody(ctx, cfg, result, ctxs) {
  const { dataDir } = ctxs
  const statePath = path.join(dataDir, 'state.json')
  const state = loadState(statePath)
  const installedAt = Number(state.installedAt) || 0
  if (!installedAt) {
    result.status = '失败'
    result.errors.push('state 里没有安装时刻基线，不能补扫历史')
    return
  }
  if (state.lastBackfillAt && !ctxs.force) {
    result.status = '跳过'
    result.errors.push('已经补扫过历史（' + new Date(Number(state.lastBackfillAt)).toISOString() + '）；要重跑先删 data/backfill-state.json 再放请求文件')
    return
  }

  const archivePath = cfg.archivePath
  const memoryPath = cfg.memoryPath
  const archiveOriginal = readText(archivePath)
  if (archiveOriginal == null) {
    result.status = '失败'
    result.errors.push('档案文件不存在：' + archivePath)
    return
  }
  let memoryOriginal = readText(memoryPath)
  if (memoryOriginal == null) memoryOriginal = MEMORY_HEADER

  const archiveDrift = state.archiveHash && state.archiveHash !== sha256(archiveOriginal)
  const memoryDrift = state.memoryHash && memoryOriginal !== MEMORY_HEADER && state.memoryHash !== sha256(memoryOriginal)
  if (archiveDrift || memoryDrift) {
    result.status = '失败'
    result.errors.push('档案或记忆库在本轮开始前被外部修改，这次补扫不写')
    return
  }

  const titles = loadTitles(dataDir)
  const pending = []
  const seen = new Set()
  for (const entry of listSessionFiles(cfg.sessionsRoot)) {
    let read
    try {
      read = readSessionAppend(entry.file, 0)
    } catch {
      read = null
    }
    if (!read) {
      result.errors.push('读不了会话文件：' + entry.file)
      continue
    }
    const header = read.header || {}
    const title = extractTitle(read.events) || titles[entry.file] || null
    if (title) titles[entry.file] = title
    const isQq = isQqWorkspace(entry.project)

    for (const event of read.events) {
      if (!isHisMessage(event)) continue
      const text = userMessageText(event)
      if (!text) continue
      const time = Number(event.time)
      if (!Number.isFinite(time) || time >= installedAt) continue
      if (header.isSeeded && Number(header.createdAt) && time < Number(header.createdAt)) continue
      const sourceKind = (event.data && event.data.source && event.data.source.kind) || 'unknown'
      if (sourceKind === 'qq' && isQq && !titleAllowed(title)) {
        result.filtered += 1
        continue
      }
      const id = messageId(event) || entry.sessionId + ':' + event.seq
      if (seen.has(id)) continue
      seen.add(id)
      pending.push({
        id,
        time,
        text,
        session: entry.sessionId,
        source: sourceKind,
        file: entry.file,
      })
    }
  }
  saveTitles(dataDir, titles)

  pending.sort((a, b) => a.time - b.time)
  result.messages = pending.length
  result.sessions = new Set(pending.map((m) => m.session)).size

  if (pending.length === 0 && result.filtered === 0) {
    result.status = '成功无变更'
    result.errors.push('安装时刻之前没有可补扫的本人消息')
    return
  }

  let archiveText = archiveOriginal
  let memoryText = memoryOriginal
  const chunks = chunkMessages(pending, CHUNK_MESSAGES, CHUNK_CHARS)
  result.chunks = chunks.length
  const rejectedAll = []
  let wroteSomething = false
  let blocked = null

  for (let i = 0; i < chunks.length; i += 1) {
    if (blocked) break
    const chunk = chunks[i]
    const prompt = buildPrompt({
      archive: archiveText,
      memory: memoryText,
      messages: chunk.map((m) => ({ ...m, timeText: localTime(m.time) + ' ' + localDate(m.time) })),
      recent: [],
    })
    let modelText = null
    let lastError = null
    for (let attempt = 0; attempt < 2 && modelText == null; attempt += 1) {
      try {
        modelText = await askModel(ctx, cfg.llm, prompt, { maxTokens: cfg.maxTokens, timeoutMs: 240000 })
      } catch (error) {
        lastError = error
      }
    }
    if (modelText == null) {
      result.skippedChunks += 1
      result.errors.push('第 ' + (i + 1) + '/' + chunks.length + ' 批模型调用失败：' + errorText(lastError))
      continue
    }
    let rawOps
    try {
      rawOps = parseModelJson(modelText).ops
    } catch (error) {
      result.skippedChunks += 1
      const excerpt = String(modelText || '').replace(/\s+/g, ' ').slice(0, 200)
      result.errors.push('第 ' + (i + 1) + '/' + chunks.length + ' 批模型输出解析失败：' + errorText(error) + '｜原文开头：' + (excerpt || '(空)'))
      continue
    }
    const validated = validateOps(rawOps, { archive: archiveText, memory: memoryText, messages: chunk })
    await rescoreBoundaryAdds(ctx, cfg.llm, validated, archiveText, memoryText, result)
    const sorted = repartition(validated, archiveText, memoryText)
    rejectedAll.push(...validated.rejected, ...sorted.rejected)

    if (sorted.archive.length > 0) {
      const out = applyOps(archiveText, sorted.archive)
      archiveText = out.text
      for (const op of out.applied) {
        wroteSomething = true
        recordChange(result, op, 'archive')
      }
    }
    if (sorted.memory.length > 0) {
      const out = applyOps(memoryText, sorted.memory)
      memoryText = out.text
      for (const op of out.applied) {
        wroteSomething = true
        recordChange(result, op, 'memory')
      }
    }

    try {
      atomicWrite(
        path.join(dataDir, 'backfill-progress.json'),
        JSON.stringify({
          startedAt: result.startedAt,
          chunk: i + 1,
          totalChunks: chunks.length,
          messagesDone: chunk[chunk.length - 1] ? chunk[chunk.length - 1].time : null,
          added: result.added.length,
          replaced: result.replaced.length,
          errors: result.errors.length,
        }, null, 2) + '\n',
      )
    } catch {
      // 进度文件写不进去不影响补齐
    }

    if (archiveTooLarge(archiveText)) {
      blocked = '补扫后档案会超过 60000 字节上限，已保留前 ' + (i + 1) + ' 批结果'
      break
    }
  }

  result.rejected = rejectedAll.slice(0, 200)
  if (archiveTooLarge(archiveText)) {
    blocked = '补扫后档案会超过 60000 字节上限，放弃本轮写入'
    archiveText = archiveOriginal
    memoryText = memoryOriginal
    result.added = []
    result.replaced = []
    result.deleted = []
    wroteSomething = false
  }

  if (blocked) {
    result.status = '部分完成'
    result.errors.push(blocked)
    // 已生成的内容仍按上限内写入（如果只是最后一批越界，前面的结果保留）
    if (!archiveTooLarge(archiveText)) blocked = null
  }

  if (!wroteSomething) {
    result.status = result.skippedChunks > 0 ? '失败' : '成功无变更'
    if (result.status === '成功无变更') {
      state.lastBackfillAt = ctxs.startedAt
      state.archiveHash = sha256(archiveOriginal)
      state.memoryHash = sha256(memoryOriginal)
      saveState(statePath, state)
    }
    if (result.skippedChunks > 0 && result.errors.length === 0) result.errors.push('有批次提取失败')
    return
  }

  if (result.mode === 'live') {
    try {
      const archiveChanged = archiveText !== archiveOriginal
      const memoryChanged = memoryText !== memoryOriginal
      if (archiveChanged) result.backupPath = backupFile(archivePath, ctxs.backupRoot, stamp(ctxs.startedAt))
      if (memoryChanged) {
        const memoryBackup = backupFile(memoryPath, ctxs.backupRoot, stamp(ctxs.startedAt))
        if (!result.backupPath) result.backupPath = memoryBackup
      }
      if (archiveChanged) atomicWrite(archivePath, archiveText)
      if (memoryChanged) {
        ensureDir(path.dirname(memoryPath))
        atomicWrite(memoryPath, memoryText)
      }
      pruneBackups(ctxs.backupRoot, cfg.keepBackups)
    } catch (error) {
      result.status = '失败'
      result.errors.push('写入失败：' + errorText(error))
      return
    }
    result.status = result.skippedChunks > 0 ? '部分完成' : '成功'
  } else {
    result.status = '干跑（有变更）'
  }

  state.archiveHash = sha256(readText(archivePath) ?? archiveOriginal)
  state.memoryHash = sha256(readText(memoryPath) ?? memoryOriginal)
  state.lastBackfillAt = ctxs.startedAt
  saveState(statePath, state)
}

async function rescoreBoundaryAdds(ctx, llmCfg, validated, archiveText, memoryText, result) {
  const candidates = []
  for (const op of validated.archive) if (op.op === 'add' && op.weight === 5) candidates.push(op)
  for (const op of validated.memory) if (op.op === 'add' && op.weight === 4) candidates.push(op)
  if (candidates.length === 0) return

  const prompt = [
    '你在给「关于噗噗的长期信息」定档。人格档案只收权重 5（核心身份、长期关系、长期工作方式、反复出现的明确偏好），记忆库存权重 3 或 4（具体事实、次要但值得留），≤2 不记。',
    '下面几条首轮得分正好在 4 或 5 的边界上，请逐条重新独立打分。只输出 JSON，不要解释：{"scores":[{"index":1,"weight":5}]}',
    '档位参考：稳定身份、长期关系、长期工作方式、明确且反复出现的偏好 → 5；新的、长期有用的具体事实或偏好 → 4；次要但可留 → 3；一次性安排、会过时、情绪 → 2；拿不准给 4。',
    '',
    '候选：',
    candidates.map((op, i) => i + 1 + '. ' + op.line + '\n   依据：' + op.quote).join('\n'),
    '',
    '人格档案现状（节选）：',
    archiveText.slice(0, 3000),
    '',
    '记忆库现状：',
    memoryText.slice(0, 1200),
  ].join('\n')

  let text
  try {
    text = await askModel(ctx, llmCfg, prompt, { maxTokens: 2000, timeoutMs: 120000 })
  } catch (error) {
    result.errors.push('边界权重二次打分调用失败，沿用首轮权重：' + errorText(error))
    return
  }
  let scores
  try {
    const parsed = parseModelJson(text)
    scores = Array.isArray(parsed.scores) ? parsed.scores : []
  } catch (error) {
    result.errors.push('边界权重二次打分结果解析失败，沿用首轮权重：' + errorText(error))
    return
  }
  const byIndex = new Map()
  for (const item of scores) {
    if (!item || !Number.isFinite(Number(item.index))) continue
    const weight = Number(item.weight)
    if (!Number.isFinite(weight) || weight < 0 || weight > 5) continue
    byIndex.set(Number(item.index), Math.round(weight))
  }
  for (let i = 0; i < candidates.length; i++) {
    const second = byIndex.get(i + 1)
    if (second == null) continue
    const op = candidates[i]
    op.weight1 = op.weight
    op.weight2 = second
    op.weight = Math.round((op.weight + second) / 2)
  }
}

function repartition(validated, archiveText, memoryText) {
  const out = { archive: [], memory: [], rejected: [] }
  const counters = { archive: { writes: 0, deletes: 0 }, memory: { writes: 0, deletes: 0 } }
  const push = (op) => {
    const counter = counters[op.target]
    const key = op.op === 'delete' ? 'deletes' : 'writes'
    const cap = op.op === 'delete' ? LIMITS.MAX_DELETE : LIMITS.MAX_ADD_REPLACE
    if (counter[key] >= cap) {
      out.rejected.push({ op, reason: '二次分档后超过每批上限，顺延到下次运行' })
      return
    }
    counter[key] += 1
    out[op.target].push(op)
  }
  const moveTo = (op, target, text) => {
    const anchor = String(op.anchor || '').trim()
    const lines = text.split('\n')
    if (anchor !== 'append' && !lines.some((l) => l.trim() === anchor)) {
      op = { ...op, anchor: 'append' }
    }
    if (lines.some((l) => l.trim() === op.line)) {
      out.rejected.push({ op, reason: '二次分档后目标文件里已有这条，不重复写' })
      return
    }
    push({ ...op, target })
  }
  for (const op of validated.archive) {
    if (op.op !== 'add') {
      push(op)
      continue
    }
    if (op.weight >= 5) push(op)
    else if (op.weight >= 3) moveTo(op, 'memory', memoryText)
    else out.rejected.push({ op, reason: '二次打分后权重 ' + op.weight + ' ≤2，不写' })
  }
  for (const op of validated.memory) {
    if (op.op !== 'add') {
      push(op)
      continue
    }
    if (op.weight >= 3 && op.weight < 5) push(op)
    else if (op.weight >= 5) moveTo(op, 'archive', archiveText)
    else out.rejected.push({ op, reason: '二次打分后权重 ' + op.weight + ' ≤2，不写' })
  }
  return out
}

function chunkMessages(messages, maxCount, maxChars) {
  const chunks = []
  let current = []
  let chars = 0
  for (const m of messages) {
    const cost = m.text.length + 80
    if (current.length > 0 && (current.length >= maxCount || chars + cost > maxChars)) {
      chunks.push(current)
      current = []
      chars = 0
    }
    current.push(m)
    chars += cost
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

function recordChange(result, op, target) {
  const entry = {
    target,
    op: op.op,
    weight: op.weight,
    line: op.line || '',
    old: op.old || '',
    quote: op.quote,
    session: op.session,
    time: op.time,
  }
  if (op.weight1 != null) entry.weight1 = op.weight1
  if (op.weight2 != null) entry.weight2 = op.weight2
  if (op.op === 'add') result.added.push(entry)
  else if (op.op === 'replace') result.replaced.push(entry)
  else result.deleted.push(entry)
}

function loadState(file) {
  const text = readText(file)
  if (!text) return {}
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function saveState(file, state) {
  state.updatedAt = Date.now()
  atomicWrite(file, JSON.stringify(state, null, 2) + '\n')
}

function acquireLock(dataDir, now, maxAge) {
  const file = path.join(dataDir, 'lock.json')
  try {
    const text = readText(file)
    if (text) {
      const parsed = JSON.parse(text)
      const lockedAt = Number(parsed.lockedAt) || 0
      if (now - lockedAt < maxAge) return false
    }
  } catch {
    // 锁文件损坏就当作可以覆盖
  }
  try {
    atomicWrite(file, JSON.stringify({ lockedAt: now, pid: process.pid }) + '\n')
    return true
  } catch {
    return false
  }
}

function releaseLock(dataDir) {
  try {
    fs.rmSync(path.join(dataDir, 'lock.json'), { force: true })
  } catch {
    // 清不掉锁时下次按过期处理
  }
}

function writeBackfillLog(logDir, cfg, result) {
  const head = [
    '## ' + localTime(result.startedAt) + ' 历史补扫（' + result.mode + '）',
    '',
    '- 结果：' + result.status,
    '- 会话/消息：' + result.sessions + ' 个会话，' + result.messages + ' 条本人消息（QQ 通道过滤掉 ' + result.filtered + ' 条）',
    '- 分批：' + result.chunks + ' 批，失败 ' + result.skippedChunks + ' 批',
    '- 模型：' + cfg.llm.provider + ' / ' + cfg.llm.model,
    '- 耗时：' + Math.round((result.durationMs || 0) / 1000) + ' 秒',
  ]
  if (result.backupPath) head.push('- 备份：' + result.backupPath)
  const body = []
  if (result.added.length || result.replaced.length || result.deleted.length) {
    body.push('### 新增')
    for (const item of result.added) body.push(changeLine(item))
    body.push('### 修改')
    for (const item of result.replaced) body.push(changeLine(item) + ' ｜旧：' + item.old)
    body.push('### 删除')
    for (const item of result.deleted) body.push(changeLine(item) + ' ｜旧：' + item.old)
  } else {
    body.push('### 变更', '- 无')
  }
  body.push('### 拒绝')
  if (result.rejected.length === 0) body.push('- 无')
  for (const item of result.rejected) {
    body.push('- ' + (item.op ? '[' + item.op.target + ' ' + item.op.op + '] ' : '') + item.reason)
  }
  body.push('### 错误')
  if (result.errors.length === 0) body.push('- 无')
  for (const message of result.errors.slice(0, 50)) body.push('- ' + message)
  try {
    appendDailyLog(logDir, [...head, ...body, ''].join('\n') + '\n')
  } catch (error) {
    result.errors.push('日志写入失败：' + errorText(error))
  }
  try {
    atomicWrite(
      path.join(logDir, '最新变更.md'),
      [
        '# 档案变更摘要（供 ClawBot 读取）',
        '',
        ...head,
        ...body,
        '',
        '- 日期：' + localDate(result.startedAt),
        '- 完整日志：logs/' + localDate(result.startedAt) + '.md',
        '',
      ].join('\n') + '\n',
    )
  } catch (error) {
    result.errors.push('最新变更摘要写入失败：' + errorText(error))
  }
}

function changeLine(item) {
  const weightNote = item.weight2 != null
    ? '（二次打分 ' + item.weight1 + '→' + item.weight + '）'
    : '（权重 ' + item.weight + '）'
  return '- [' + item.target + '] ' + item.line + weightNote + '｜依据「' + item.quote + '」｜' + item.session.slice(0, 12) + ' · ' + item.time
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
