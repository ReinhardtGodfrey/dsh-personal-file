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
import { buildPrompt, validateOps, applyOps, archiveTooLarge, LIMITS, KIND_WEIGHTS, KIND_SCORE_TEXT, attachMemoryDates, memoryLine } from './ops.js'
import { loadIndex, recordEntries, staleMinorEntries, dropEmptyTopics } from './memory-index.js'
import { appendPending, promotePending, readPendingPrompt } from './pending.js'
import { loadBindings, classifyMessage } from './qq-identity.js'
import { chunkBySession } from './chunker.js'

const MEMORY_HEADER = '# 记忆库（次要信息）\n\n## 自动记录\n'
const CHUNK_MESSAGES = 40
const CHUNK_CHARS = 18000
const CHUNK_OVERLAP = 3
const LOCK_MAX_AGE_MS = 10 * 60 * 1000

export async function runOnce(ctx, cfg, options = {}) {
  const trigger = options.trigger || 'startup'
  const days = cfg.pluginRoot
  const dataDir = path.join(days, 'data')
  const logDir = path.join(days, 'logs')
  const backupRoot = path.join(days, 'backups')
  ensureDir(dataDir)

  const startedAt = Date.now()
  const mode = (readText(path.join(dataDir, 'mode.txt')) || '').trim()
  const live = mode === 'live'
  const result = {
    trigger,
    mode: live ? 'live' : 'dry-run',
    status: '失败',
    startedAt,
    messages: 0,
    sessions: 0,
    added: [],
    replaced: [],
    deleted: [],
    cleaned: [],
    pending: [],
    rejected: [],
    errors: [],
    backupPath: null,
  }

  if (exists(path.join(dataDir, 'disabled'))) {
    result.status = '跳过'
    result.errors.push('data/disabled 存在，本次不运行')
    return result
  }
  if (!acquireLock(dataDir, startedAt)) {
    result.status = '跳过'
    result.errors.push('另一个运行还没结束（锁未过期）')
    return result
  }

  try {
    await runBody(ctx, cfg, result, { dataDir, logDir, backupRoot, startedAt, live })
  } catch (error) {
    result.status = '失败'
    result.errors.push(errorText(error))
  } finally {
    releaseLock(dataDir)
  }

  result.finishedAt = Date.now()
  result.durationMs = result.finishedAt - startedAt
  writeLog(logDir, cfg, result)
  try {
    atomicWrite(path.join(dataDir, 'last-run.json'), JSON.stringify(result, null, 2) + '\n')
  } catch {
    // 最后一批诊断写不进去也不影响主流程
  }
  return result
}

async function runBody(ctx, cfg, result, ctxs) {
  const { dataDir } = ctxs
  const statePath = path.join(dataDir, 'state.json')
  const state = loadState(statePath)
  const installedAt = Number(state.installedAt) || 0

  const archivePath = cfg.archivePath
  const memoryPath = cfg.memoryPath
  const archiveOriginal = readText(archivePath)
  if (archiveOriginal == null) {
    result.status = '失败'
    result.errors.push('档案文件不存在：' + archivePath)
    return
  }

  // 第一跑：只记录各文件当前长度，不读安装前的历史
  if (!installedAt) {
    const files = {}
    for (const entry of listSessionFiles(cfg.sessionsRoot)) {
      files[entry.file] = { offset: entry.size, size: entry.size, lastSeq: null, headerId: null }
    }
    state.installedAt = ctxs.startedAt
    state.files = files
    state.archiveHash = sha256(archiveOriginal)
    const memoryText = ensureMemory(memoryPath, ctxs.live, result)
    state.memoryHash = sha256(memoryText)
    state.lastRunAt = ctxs.startedAt
    state.lastRunStatus = '基线'
    saveState(statePath, state)
    result.status = '基线'
    result.errors.push('已记下安装时刻的文件长度基线，本轮不读安装前的历史')
    return
  }

  let memoryOriginal = readText(memoryPath)
  if (memoryOriginal == null) {
    memoryOriginal = ensureMemory(memoryPath, ctxs.live, result)
  }

  // 比对上一轮写完后记下的哈希：外部动过就这一轮不写
  const archiveDrift = state.archiveHash && state.archiveHash !== sha256(archiveOriginal)
  const memoryDrift = state.memoryHash && memoryOriginal != null && state.memoryHash !== sha256(memoryOriginal)

  const pending = []
  const seen = new Set()
  const previousFilesJson = JSON.stringify(state.files || {})
  const bindings = loadBindings(cfg.dshHome)

  for (const entry of listSessionFiles(cfg.sessionsRoot)) {
    const prev = state.files[entry.file] || {}
    let offset = Number.isFinite(prev.offset) ? prev.offset : 0
    if (entry.size < offset) offset = 0
    if (entry.size === offset) continue

    const read = readSessionAppend(entry.file, offset)
    if (!read) {
      result.errors.push('读不了会话文件：' + entry.file)
      continue
    }
    const header = read.header || (prev.headerId ? { id: prev.headerId, createdAt: prev.createdAt } : null)
    let lastSeq = prev.lastSeq ?? null
    for (const event of read.events) {
      if (typeof event.seq === 'number') lastSeq = lastSeq == null ? event.seq : Math.max(lastSeq, event.seq)
      if (event.type === 'session/title') continue
      if (!isHisMessage(event)) continue
      const sourceKind = (event.data && event.data.source && event.data.source.kind) || 'unknown'
      const text = userMessageText(event)
      if (!text) continue
      // 只认本人：user 通道直接算；qq 通道按绑定文件里的 QQ 号判定，判不出的一律丢
      if (classifyMessage(bindings, { sessionId: entry.sessionId, sourceKind, text, ownQq: cfg.ownQq }) !== 'own') continue
      const time = Number(event.time)
      if (!Number.isFinite(time) || time < installedAt) continue
      if (header && header.isSeeded && Number(header.createdAt) && time < Number(header.createdAt)) continue
      const id = messageId(event) || entry.sessionId + ':' + event.seq
      if (seen.has(id)) continue
      seen.add(id)
      if (hasRecentId(state, id)) continue
      pending.push({
        id,
        time,
        text,
        session: entry.sessionId,
        source: sourceKind,
        file: entry.file,
      })
    }
    state.files[entry.file] = {
      offset: read.nextOffset,
      size: read.size,
      lastSeq,
      headerId: header && header.id ? header.id : prev.headerId || null,
      createdAt: header && header.createdAt ? header.createdAt : prev.createdAt || null,
    }
  }

  pending.sort((a, b) => a.time - b.time)
  result.messages = pending.length
  result.sessions = new Set(pending.map((m) => m.session)).size

  if (pending.length === 0) {
    state.lastRunAt = ctxs.startedAt
    state.lastRunStatus = '成功无变更'
    state.archiveHash = sha256(archiveOriginal)
    state.memoryHash = sha256(memoryOriginal)
    saveState(statePath, state)
    result.status = '成功无变更'
    return
  }

  let archiveText = archiveOriginal
  let memoryText = memoryOriginal
  let blocked = null
  if (archiveDrift || memoryDrift) blocked = '档案或记忆库在本轮开始后被外部修改，这次不写'

  const recent = recentContext(state, pending[0].time)
  const pendingLines = readPendingPrompt(dataDir)
  const chunks = chunkBySession(pending, { maxCount: CHUNK_MESSAGES, maxChars: CHUNK_CHARS, overlap: CHUNK_OVERLAP })
  const rejectedAll = []
  const appliedAddLines = []
  const memoryAdds = []
  let wroteSomething = false
  let modelFailed = false

  for (const batch of chunks) {
    if (blocked) break
    const chunk = batch.messages
    const contextMap = new Map()
    for (const m of [...batch.context, ...recent]) {
      if (m && (m.id || m.time)) contextMap.set(m.id || m.time, m)
    }
    const prompt = buildPrompt({
      archive: archiveText,
      memory: memoryText,
      messages: chunk.map((m) => ({ ...m, timeText: localTime(m.time) + ' ' + localDate(m.time) })),
      recent: [...contextMap.values()],
      pending: pendingLines,
    })
    let modelText
    try {
      modelText = await askModel(ctx, cfg.llm, prompt, { maxTokens: cfg.maxTokens, timeoutMs: 240000 })
    } catch (error) {
      result.errors.push(errorText(error))
      modelFailed = true
      continue
    }
    let ops
    try {
      ops = parseModelJson(modelText).ops
    } catch (error) {
      const excerpt = String(modelText || '').replace(/\s+/g, ' ').slice(0, 200)
      result.errors.push('模型输出解析失败：' + errorText(error) + '｜原文开头：' + (excerpt || '(空)'))
      modelFailed = true
      continue
    }
    const validated = validateOps(ops, { archive: archiveText, memory: memoryText, messages: chunk })
    await rescoreBoundaryAdds(ctx, cfg.llm, validated, archiveText, memoryText, result)
    const sorted = repartition(validated, archiveText, memoryText)
    attachMemoryDates(sorted.memory, chunk)
    rejectedAll.push(...validated.rejected, ...sorted.rejected)
    for (const op of validated.uncertain) {
      result.pending.push({
        line: op.line,
        kind: op.kind,
        quote: op.quote,
        session: op.session,
        time: op.time,
      })
    }

    if (sorted.archive.length > 0) {
      const out = applyOps(archiveText, sorted.archive)
      archiveText = out.text
      for (const op of out.applied) {
        wroteSomething = true
        if (op.op === 'add') appliedAddLines.push(op.line)
        recordChange(result, op, 'archive')
      }
    }
    if (sorted.memory.length > 0) {
      const out = applyOps(memoryText, sorted.memory)
      memoryText = out.text
      for (const op of out.applied) {
        wroteSomething = true
        if (op.op === 'add') {
          appliedAddLines.push(op.line)
          memoryAdds.push(op)
        }
        recordChange(result, op, 'memory')
      }
    }
  }

  // 半年没再提到的 3 分条目自动清掉（只动记忆库，清前有本轮备份兜底）
  if (!blocked && result.mode === 'live') {
    const staleLines = staleMinorEntries(loadIndex(dataDir), ctxs.startedAt)
    if (staleLines.length > 0) {
      const cleaned = applyOps(memoryText, staleLines.map((old) => ({ target: 'memory', op: 'delete', old })))
      if (cleaned.applied.length > 0) {
        memoryText = dropEmptyTopics(cleaned.text)
        wroteSomething = true
        result.cleaned = cleaned.applied.map((op) => op.old)
      }
    }
  }
  result.rejected = rejectedAll

  if (!blocked && modelFailed) blocked = '有批次提取失败，本轮不写，等下次重跑'

  const hasChanges = wroteSomething || result.pending.length > 0

  if (archiveTooLarge(archiveText)) {
    blocked = '改完档案会超过 60000 字节上限，放弃本轮写入'
    archiveText = archiveOriginal
    memoryText = memoryOriginal
    result.added = []
    result.replaced = []
    result.deleted = []
    wroteSomething = false
  }

  if (blocked) {
    result.status = '失败'
    result.errors.push(blocked)
    archiveText = archiveOriginal
    memoryText = memoryOriginal
    result.added = []
    result.replaced = []
    result.deleted = []
    // 本轮没写进档案，文件读取位置退回上一轮，消息等下次重跑再处理
    state.files = JSON.parse(previousFilesJson)
    state.lastAttemptAt = ctxs.startedAt
    state.archiveHash = sha256(readText(archivePath) ?? archiveOriginal)
    state.memoryHash = sha256(readText(memoryPath) ?? memoryOriginal)
    saveState(statePath, state)
    return
  }

  if (result.mode === 'live' && hasChanges) {
    try {
      const archiveChanged = archiveText !== archiveOriginal
      const memoryChanged = memoryText !== memoryOriginal
      if (archiveChanged) {
        result.backupPath = backupFile(archivePath, ctxs.backupRoot, stamp(ctxs.startedAt))
      }
      if (memoryChanged) {
        const memoryBackup = backupFile(memoryPath, ctxs.backupRoot, stamp(ctxs.startedAt))
        if (!result.backupPath) result.backupPath = memoryBackup
      }
      if (archiveChanged) atomicWrite(archivePath, archiveText)
      if (memoryChanged) atomicWrite(memoryPath, memoryText)
      if (memoryAdds.length > 0) {
        recordEntries(
          dataDir,
          memoryAdds.map((op) => ({
            date: op.date || '',
            topic: op.topic || '',
            kind: op.kind || '',
            line: memoryLine(op),
            quote: op.quote || '',
            session: op.session || '',
            time: op.time || '',
          })),
        )
      }
      if (appliedAddLines.length > 0) {
        result.pendingPromoted = promotePending(dataDir, appliedAddLines, true)
      }
      result.pendingAdded = appendPending(dataDir, result.pending, true)
      pruneBackups(ctxs.backupRoot, cfg.keepBackups)
    } catch (error) {
      result.status = '失败'
      result.errors.push('写入失败：' + errorText(error))
      // 写失败时退回读取位置，已写的文件靠备份还原，消息下次重跑
      state.files = JSON.parse(previousFilesJson)
      state.lastAttemptAt = ctxs.startedAt
      state.lastRunStatus = '失败'
      saveState(statePath, state)
      return
    }
    result.status = '成功'
  } else if (result.mode !== 'live' && hasChanges) {
    result.status = '干跑（有变更）'
  } else {
    result.status = '成功无变更'
  }

  state.lastRunAt = ctxs.startedAt
  state.lastRunStatus = result.status
  // 干跑没有把模拟结果写进文件，哈希必须记实际文件的，否则下一轮会被误判为外部改动
  state.archiveHash = sha256(ctxs.live ? archiveText : archiveOriginal)
  state.memoryHash = sha256(ctxs.live ? memoryText : memoryOriginal)
  updateRecent(state, pending)
  saveState(statePath, state)
  result.messages = pending.length
}

/**
 * 首轮落在边界上的 add（档案 5 分、记忆库 3/4 分）会再问一次模型，按类别重新定档；
 * 两次取较低档，宁可少写，避免同一句话一次 5 一次 4 就换了文件。非 add 的改删不动档位。
 */
async function rescoreBoundaryAdds(ctx, llmCfg, validated, archiveText, memoryText, result) {
  const candidates = []
  for (const op of validated.archive) if (op.op === 'add' && op.weight === 5) candidates.push(op)
  for (const op of validated.memory) if (op.op === 'add' && op.weight >= 3) candidates.push(op)
  if (candidates.length === 0) return

  const prompt = [
    '你在给一批关于档案对象的长期信息分类定档。先判断类别，再由类别定档，不要凭感觉给分数。',
    KIND_SCORE_TEXT,
    '下面几条首轮分档正好在边界上，请逐条重新独立打分——先重新判类别，再定档。只输出 JSON，不要解释：{"scores":[{"index":1,"kind":"identity"}]}',
    '',
    '候选：',
    candidates.map((op, i) => i + 1 + '. ' + op.line + '\n   依据：' + op.quote).join('\n'),
    '',
    '个人档案现状（节选）：',
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
    let weight = null
    if (typeof item.kind === 'string' && KIND_WEIGHTS[item.kind] != null) weight = KIND_WEIGHTS[item.kind]
    else if (Number.isFinite(Number(item.weight))) weight = Math.round(Number(item.weight))
    if (weight == null || weight < 0 || weight > 5) continue
    byIndex.set(Number(item.index), weight)
  }
  for (let i = 0; i < candidates.length; i++) {
    const second = byIndex.get(i + 1)
    if (second == null) continue
    const op = candidates[i]
    op.weight1 = op.weight
    op.weight2 = second
    op.weight = Math.min(op.weight, second)
  }
}

/**
 * 二次打分后按最终权重重新分拣：≥5 档案、3–4 记忆库、≤2 不写。
 * 跨文件的 add 要换 anchor（原节在新文件里不存在时改为 append）并查重；
 * 每批上限在此重算一次，防止跨文件搬运后超限。
 */
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

function ensureMemory(memoryPath, live, result) {
  const existing = readText(memoryPath)
  if (existing != null) return existing
  if (live) {
    atomicWrite(memoryPath, MEMORY_HEADER)
    return MEMORY_HEADER
  }
  result.errors.push('记忆库不存在，干跑按空文件处理')
  return MEMORY_HEADER
}

function hasRecentId(state, id) {
  if (!state.recent) return false
  for (const list of Object.values(state.recent)) {
    if (Array.isArray(list) && list.some((m) => m && m.id === id)) return true
  }
  return false
}

function recentContext(state, beforeTime) {
  if (!state.recent) return []
  const all = []
  for (const [sessionId, list] of Object.entries(state.recent)) {
    if (!Array.isArray(list)) continue
    for (const m of list) {
      if (!m || !Number.isFinite(Number(m.time))) continue
      if (Number(m.time) >= beforeTime) continue
      all.push({ ...m, session: sessionId, timeText: localTime(Number(m.time)) })
    }
  }
  all.sort((a, b) => Number(a.time) - Number(b.time))
  return all.slice(-20)
}

function updateRecent(state, pending) {
  if (!state.recent || typeof state.recent !== 'object') state.recent = {}
  for (const m of pending) {
    const list = Array.isArray(state.recent[m.session]) ? state.recent[m.session] : []
    list.push({ id: m.id, time: m.time, text: m.text.slice(0, 300) })
    while (list.length > 20) list.shift()
    state.recent[m.session] = list
  }
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

function acquireLock(dataDir, now) {
  const file = path.join(dataDir, 'lock.json')
  try {
    const text = readText(file)
    if (text) {
      const parsed = JSON.parse(text)
      const lockedAt = Number(parsed.lockedAt) || 0
      if (now - lockedAt < LOCK_MAX_AGE_MS) return false
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

function writeLog(logDir, cfg, result) {
  const head = [
    '## ' + localTime(result.startedAt) + ' 运行（' + result.mode + '·' + result.trigger + '）',
    '',
    '- 结果：' + result.status,
    '- 会话/消息：' + result.sessions + ' 个会话，' + result.messages + ' 条本人消息',
    '- 模型：' + (cfg.llm.provider && cfg.llm.model ? cfg.llm.provider + ' / ' + cfg.llm.model : '宿主默认'),
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

  if (Array.isArray(result.cleaned) && result.cleaned.length > 0) {
    body.push('### 自动清理（半年没再提到的 3 分条目）')
    for (const line of result.cleaned) body.push('- ' + line)
  }

  body.push('### 待确认')
  if (result.pending.length === 0) body.push('- 无')
  for (const item of result.pending) {
    body.push(
      '- ' + item.line + '（' + (item.kind || '?') + '）｜依据「' + item.quote + '」｜' + String(item.session).slice(0, 12) + ' · ' + item.time,
    )
  }

  body.push('### 拒绝')
  if (result.rejected.length === 0) body.push('- 无')
  for (const item of result.rejected) {
    body.push('- ' + (item.op ? '[' + item.op.target + ' ' + item.op.op + '] ' : '') + item.reason)
  }

  body.push('### 错误')
  if (result.errors.length === 0) body.push('- 无')
  for (const message of result.errors) body.push('- ' + message)

  try {
    appendDailyLog(logDir, [...head, ...body, ''].join('\n') + '\n')
  } catch (error) {
    result.errors.push('日志写入失败：' + errorText(error))
  }
  writeLatestDigest(logDir, result, head, body)
}

// 最近一次运行的变更摘要，固定路径，供 ClawBot 这类外部读取者每天看。
function writeLatestDigest(logDir, result, head, body) {
  const text = [
    '# 档案变更摘要（供 ClawBot 读取）',
    '',
    ...head,
    ...body,
    '',
    '- 日期：' + localDate(result.startedAt),
    '- 完整日志：logs/' + localDate(result.startedAt) + '.md',
    '',
  ].join('\n') + '\n'
  try {
    atomicWrite(path.join(logDir, '最新变更.md'), text)
  } catch (error) {
    result.errors.push('最新变更摘要写入失败：' + errorText(error))
  }
  // 每次都留一份带时间的历史摘要，不自动清理
  try {
    const historyDir = path.join(logDir, '变更历史')
    fs.mkdirSync(historyDir, { recursive: true })
    atomicWrite(path.join(historyDir, digestStamp(result.startedAt) + '.md'), text)
  } catch (error) {
    result.errors.push('变更历史写入失败：' + errorText(error))
  }
}

function digestStamp(ts) {
  const d = new Date(Number(ts))
  const p = (n) => String(n).padStart(2, '0')
  return (
    d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
  )
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
