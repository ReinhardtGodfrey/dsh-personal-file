/**
 * 提示词拼装 + 模型输出校验 + 文本落盘操作。
 * 模型只准提 ops，写与不写、怎么改由这里按固定规则裁决。
 */

export const KIND_WEIGHTS = { identity: 5, detail: 4, minor: 3, temp: 2 }

/** 记忆库按主题分节：同一件事写到同一节，每条前面带日期。 */
export const MEMORY_TOPIC_PREFIX = '## 主题：'

// 三处提示词（抽取、边界二次打分、档案重归类）共用这一套定义，改标准只改这里
export const KIND_RUBRIC = {
  identity: '稳定身份、长期关系（家人、对象、亲密朋友）、明确禁令、长期工作方式、明确且反复出现的偏好',
  detail: '长期有用的具体事实或偏好：项目细节、设备参数、具体流程、特殊经历',
  minor: '次要但可留的信息：别人的细节、一次性但以后可能用到的安排',
  temp: '临时状态、一阵子的情绪、已经过期的一次性安排',
}

export const KIND_SCORE_TEXT = `类别与档位：identity = 5（${KIND_RUBRIC.identity}）；detail = 4（${KIND_RUBRIC.detail}）；minor = 3（${KIND_RUBRIC.minor}）；temp = 2（${KIND_RUBRIC.temp}，不记）。`

export const KIND_RUBRIC_BLOCK = `【先分类，再由类别定档】
identity = 5 = ${KIND_RUBRIC.identity}
detail = 4 = ${KIND_RUBRIC.detail}
minor = 3 = ${KIND_RUBRIC.minor}
temp = 2 = ${KIND_RUBRIC.temp}`

const MAX_LINE = 200
const MAX_ADD_REPLACE = 12
const MAX_DELETE = 3
const MAX_ARCHIVE_BYTES = 60000

export function buildPrompt({ archive, memory, messages, recent = [], pending = [] }) {
  const batch = messages
    .map((m, i) => `[${i + 1}] 会话 ${m.session} · ${m.timeText} · ${m.source}\n${limit(m.text, 1200)}`)
    .join('\n\n')
  const recentText = recent.length
    ? recent.map((m) => `- ${m.timeText}：${limit(m.text, 160)}`).join('\n')
    : '（无）'
  const pendingText = pending.length
    ? pending.map((p) => limit(p, 300)).join('\n')
    : '（无）'

  return `你在维护一份个人档案，档案对象是用户本人。你的唯一任务是：从下面这批他自己发的消息里，找出关于他本人、值得长期记住的信息，并且只输出一份 JSON 操作清单。

【只看这些消息】
下面「本批消息」里每条前面的通道都已确认是他本人的（user = 本机直接对话，qq = 他的 QQ 通道）。助手说的话、系统注入、工具结果、别人的发言都不算数，完全没有出现在本批里的事实也不许猜。

【档案现状】
文件：${'AGENTS.md'}
"""
${archive}
"""

【记忆库现状】
"""
${memory}
"""

【最近上下文】（只用于理解「那个」「上次」之类的指代，不要从这里提取事实）
${recentText}

【待确认】（以前拿不准、暂时存在这里的信息；本批消息若明确证实其中某条，照常输出 add，插件会把它从待确认里转到档案或记忆库）
${pendingText}

【本批消息】
${batch}

【判断规则】
- 只提取本人原话直接支持的内容；不要推测、不要补全、不要从助手的话里反推他的信息。
- 每条事实配一句原话片段 quote（必须逐字出现在本批某条消息里，最多 60 字）。
- 分档按类别，不要凭感觉给分数。先判断这条属于哪一类，再按类别对应档位：
  - identity：${KIND_RUBRIC.identity} → 5 分
  - detail：${KIND_RUBRIC.detail} → 4 分
  - minor：${KIND_RUBRIC.minor} → 3 分
  - temp：${KIND_RUBRIC.temp} → 2 分
- 档案（AGENTS.md）只收 identity（5 分），且写成一行陈述，善用原文措辞；记忆库收 detail（4 分）与 minor（3 分）；temp（2 分）不写。
- 记忆库按主题分节：memory 的 add 必须给 topic（2–10 字的主题词，例如「生图」「作息」「插件规则」）；同一件事用同一个 topic，插件会写到同一节，不会另起一节。
- 日期由插件按消息时间自动补成「- YYYY-MM-DD：内容」，你的 line 里不要自己写日期。
- 拿不准这条属不属于本人、或者拿不准真假时，不要硬定档：输出一条带 "uncertain": true 的 add，插件会放进「待确认」，等以后同主题再确认，不进档案也不进记忆库。
- 已经写进档案或记忆库、意思相同的内容不要重复输出。
- 与档案已有内容冲突时，用 replace 改掉旧行；他明确否定了档案里的某条，才用 delete；没提到不等于否定，不许删。
- 本批没有值得写的内容时，输出 {"ops":[]}。

【输出格式】只输出 JSON，不要解释：
{"ops":[
  {"target":"archive","op":"add","anchor":"## 关于我","line":"- 新的稳定事实","kind":"identity","quote":"原话片段","session":"会话标识","time":"消息时间"},
  {"target":"archive","op":"replace","old":"- 档案里原有的整行","line":"- 改后的整行","kind":"identity","quote":"原话片段","session":"会话标识","time":"消息时间"},
  {"target":"memory","op":"add","topic":"生图","line":"- 会用 Seedream 出图","kind":"detail","quote":"原话片段","session":"会话标识","time":"消息时间"},
  {"target":"memory","op":"add","topic":"作息","line":"- 周三到周五晚上在机构做作业辅导","kind":"minor","quote":"原话片段","session":"会话标识","time":"消息时间"},
  {"target":"memory","op":"delete","old":"- 2026-05-01：记忆库里原有的整行","kind":"minor","quote":"原话片段","session":"会话标识","time":"消息时间"},
  {"target":"memory","op":"add","topic":"拿不准","line":"- 拿不准的事实","kind":"detail","uncertain":true,"quote":"原话片段","session":"会话标识","time":"消息时间"}
]}
- archive 的 add 用 anchor（目标文件里真实存在的、以 # 开头的标题整行，或者字符串 append）；memory 的 add 用 topic，不用 anchor。
- replace / delete 的 old 必须是目标文件里那一行的完整原文（含行首符号），且全文件唯一。
- line 必须是单行，最多 ${MAX_LINE} 字。
- 每批每文件最多 ${MAX_ADD_REPLACE} 条新增/修改、${MAX_DELETE} 条删除。`
}

function limit(text, max) {
  const s = String(text || '')
  return s.length <= max ? s : s.slice(0, max) + '…'
}

const SIMILAR_THRESHOLD = 0.75

function normalizeForCompare(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/^\s*[-*]\s*/, '')
    .replace(/[\s，。、；：！？…·「」『』“”"'（）()【】\[\],.!?:;'"’\-—]/g, '')
}

function charBigrams(text) {
  const out = new Set()
  for (let i = 0; i + 1 < text.length; i++) out.add(text.slice(i, i + 2))
  return out
}

/** 字符二元组 Dice 相似度（0–1）：用于近似去重、判断「同一件事」的新旧写法。 */
export function similarity(a, b) {
  const x = normalizeForCompare(a)
  const y = normalizeForCompare(b)
  if (!x || !y) return 0
  if (x === y) return 1
  const A = charBigrams(x)
  const B = charBigrams(y)
  let common = 0
  for (const g of A) if (B.has(g)) common++
  return (2 * common) / (A.size + B.size)
}

function findSimilarBullet(line, text) {
  const needle = String(line || '').trim()
  let best = null
  let bestScore = 0
  for (const rawLine of String(text || '').split('\n')) {
    const t = rawLine.trim()
    if (t === needle || !t.startsWith('- ')) continue
    const score = similarity(t, needle)
    if (score > bestScore) {
      bestScore = score
      best = t
    }
  }
  return best && bestScore >= SIMILAR_THRESHOLD ? { line: best, score: bestScore } : null
}

/**
 * 校验模型给的 ops，返回可执行的分拣结果与拒绝记录。
 * messages 是本批消息 {text, session, timeText, source}。
 */
export function validateOps(rawOps, { archive, memory, messages }) {
  const out = { archive: [], memory: [], uncertain: [], rejected: [] }
  if (!Array.isArray(rawOps)) {
    out.rejected.push({ op: null, reason: '模型返回的 ops 不是数组' })
    return out
  }
  for (const raw of rawOps) {
    try {
      const op = normalizeOp(raw)
      if (!op) {
        out.rejected.push({ op: raw, reason: '字段不完整或类型不对' })
        continue
      }
      if (op.target !== 'archive' && op.target !== 'memory') {
        out.rejected.push({ op: raw, reason: 'target 必须是 archive 或 memory' })
        continue
      }
      if (op.uncertain) {
        if (op.op !== 'add') {
          out.rejected.push({ op: raw, reason: 'uncertain 只能用于 add' })
          continue
        }
        if (!op.line) {
          out.rejected.push({ op: raw, reason: '待确认条目缺少 line' })
          continue
        }
        const quoteProblem = checkQuote(op, messages)
        if (quoteProblem) {
          out.rejected.push({ op: raw, reason: quoteProblem })
          continue
        }
        out.uncertain.push(op)
        continue
      }
      const targetText = op.target === 'archive' ? archive : memory
      // 相似条目：add 命中已有近似条目时改成 replace；replace 的 old 写偏了也纠正到实际行
      if (op.op === 'add') {
        const similar = findSimilarBullet(op.line, targetText)
        if (similar) {
          op.op = 'replace'
          op.old = similar.line
          op.similarity = similar.score
        }
      } else if (op.op === 'replace') {
        const oldExists = String(targetText || '').split('\n').some((l) => l.trim() === op.old)
        if (!oldExists) {
          const similar = findSimilarBullet(op.old, targetText)
          if (similar) {
            op.old = similar.line
            op.similarity = similar.score
          }
        }
      }
      const conflict = checkAgainstTarget(op, targetText)
      if (conflict) {
        out.rejected.push({ op: raw, reason: conflict })
        continue
      }
      const quoteProblem = checkQuote(op, messages)
      if (quoteProblem) {
        out.rejected.push({ op: raw, reason: quoteProblem })
        continue
      }
      if (op.uncertain) {
        if (op.op !== 'add') {
          out.rejected.push({ op: raw, reason: '待确认只接受 add' })
          continue
        }
        out.uncertain.push(op)
        continue
      }
      if (op.target === 'archive' && op.weight < 5) {
        out.rejected.push({ op: raw, reason: '档案只收权重 5 的内容' })
        continue
      }
      out[op.target].push(op)
    } catch (error) {
      out.rejected.push({ op: raw, reason: '校验异常：' + (error && error.message ? error.message : String(error)) })
    }
  }
  return applyCaps(out)
}

function normalizeOp(raw) {
  if (!raw || typeof raw !== 'object') return null
  const opName = raw.op
  if (opName !== 'add' && opName !== 'replace' && opName !== 'delete') return null
  const target = raw.target
  if (target !== 'archive' && target !== 'memory') return null
  const kind = typeof raw.kind === 'string' ? raw.kind.trim() : ''
  let weight = KIND_WEIGHTS[kind]
  if (weight == null) {
    const numeric = Number(raw.weight)
    if (!Number.isFinite(numeric)) return null
    weight = Math.round(numeric)
  }
  const op = {
    target,
    op: opName,
    kind,
    weight,
    quote: stringOr(raw.quote),
    session: stringOr(raw.session),
    time: stringOr(raw.time),
  }
  if (raw.uncertain === true) op.uncertain = true
  if (opName === 'add') {
    op.topic = stringOr(raw.topic)
    op.anchor = stringOr(raw.anchor) || 'append'
    if (target === 'memory' && op.topic && op.anchor === 'append') op.anchor = MEMORY_TOPIC_PREFIX + op.topic
    op.line = cleanLine(raw.line)
  } else {
    op.old = cleanLine(raw.old)
    if (opName === 'replace') op.line = cleanLine(raw.line)
  }
  return op
}

function stringOr(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function cleanLine(value) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim()
  return s
}

function checkAgainstTarget(op, text) {
  const lines = String(text || '').split('\n')
  if (op.line && op.line.length > MAX_LINE) return 'line 超过 ' + MAX_LINE + ' 字'
  if (op.op === 'add') {
    if (!op.line) return 'add 缺少 line'
    const anchor = op.anchor.trim()
    if (op.target === 'memory' && anchor.startsWith(MEMORY_TOPIC_PREFIX)) {
      // 记忆库的主题节可以新建；同一主题里已有近似条目时交给相似度逻辑改成改行
      const topic = anchor.slice(MEMORY_TOPIC_PREFIX.length).trim()
      if (!topic) return '主题不能为空'
      if (topic.length > 20) return '主题太长（' + topic.length + ' 字）'
      const existing = lines.find((l) => similarLineExists(l, op.line))
      if (existing) return null
      return null
    }
    if (anchor !== 'append') {
      if (!anchor.startsWith('#')) return 'anchor 必须是 # 开头的标题行或 append'
      if (!lines.some((l) => l.trim() === anchor)) return 'anchor 在目标文件里不存在：' + anchor
    }
    if (lines.some((l) => l.trim() === op.line)) return '这条内容已经存在，不重复写'
    return null
  }
  if (!op.old) return op.op + ' 缺少 old'
  if (op.old.includes('\n')) return 'old 必须是单独一行'
  const hits = lines.filter((l) => l.trim() === op.old).length
  if (hits === 0) return 'old 在目标文件里找不到：' + op.old
  if (hits > 1) return 'old 在目标文件里不唯一（' + hits + ' 处）：' + op.old
  if (op.op === 'replace') {
    if (!op.line) return 'replace 缺少 line'
    if (op.line === op.old) return 'replace 没有实际变化'
    if (lines.some((l) => l.trim() === op.line && l.trim() !== op.old)) return '改后的内容已存在，不重复写'
  }
  return null
}

/** 校验用：判断已有某行是否与待写的行高度相似（同一件事的另一种说法）。 */
function similarLineExists(existingLine, candidate) {
  const a = String(existingLine || '').trim()
  const b = String(candidate || '').trim()
  if (!a.startsWith('- ') || !b) return false
  return similarity(a.replace(/^-\s*(\d{4}-\d{2}-\d{2}：)?/, ''), b) >= 0.9
}

function checkQuote(op, messages) {
  const quote = op.quote.replace(/\s+/g, ' ').trim()
  if (quote.length < 2) return '缺少可核对的 quote'
  if (quote.length > 80) return 'quote 太长（' + quote.length + ' 字）'
  const found = messages.some((m) => normalizeSpace(m.text).includes(quote))
  if (!found) return 'quote 在本批消息里找不到逐字原文'
  return null
}

function normalizeSpace(text) {
  return String(text || '').replace(/\s+/g, ' ')
}

function applyCaps(out) {
  for (const target of ['archive', 'memory']) {
    let writes = 0
    let deletes = 0
    const kept = []
    for (const op of out[target]) {
      if (op.op === 'delete') {
        if (deletes >= MAX_DELETE) {
          out.rejected.push({ op, reason: '删除次数超过上限 ' + MAX_DELETE })
          continue
        }
        deletes++
      } else {
        if (writes >= MAX_ADD_REPLACE) {
          out.rejected.push({ op, reason: '新增/修改次数超过上限 ' + MAX_ADD_REPLACE })
          continue
        }
        writes++
      }
      kept.push(op)
    }
    out[target] = kept
  }
  return out
}

/**
 * 把校验过的 ops 应用到文本上，返回新文本与真正生效的操作。
 * add 会插到 anchor 那一节的末尾（下一个标题之前，去掉尾部空行）。
 */
export function applyOps(text, ops) {
  const lines = String(text || '').split('\n')
  const applied = []
  for (const op of ops) {
    if (op.op === 'add') {
      const isTopic = op.target === 'memory' && String(op.anchor || '').startsWith(MEMORY_TOPIC_PREFIX)
      const line = op.target === 'memory' ? memoryLine(op) : op.line
      if (isTopic) {
        const idx = lines.findIndex((l) => l.trim() === op.anchor.trim())
        if (idx >= 0) {
          insertInSection(lines, idx, line)
        } else {
          trimTrailingBlank(lines)
          if (lines.length > 0) lines.push('')
          lines.push(op.anchor.trim())
          lines.push(line)
          lines.push('')
        }
      } else if (op.anchor === 'append') {
        trimTrailingBlank(lines)
        lines.push(line)
        lines.push('')
      } else {
        const idx = lines.findIndex((l) => l.trim() === op.anchor.trim())
        if (idx < 0) continue
        insertInSection(lines, idx, line)
      }
      applied.push(op)
    } else if (op.op === 'replace') {
      const idx = lines.findIndex((l) => l.trim() === op.old)
      if (idx < 0) continue
      const indent = (lines[idx].match(/^[ \t]*/) || [''])[0]
      const oldDate = op.target === 'memory' ? (lines[idx].match(/^-\s*(\d{4}-\d{2}-\d{2})：/) || [])[1] : ''
      lines[idx] = indent + (op.target === 'memory' ? memoryLine({ line: op.line, date: oldDate }) : op.line)
      applied.push(op)
    } else if (op.op === 'delete') {
      const idx = lines.findIndex((l) => l.trim() === op.old)
      if (idx < 0) continue
      lines.splice(idx, 1)
      applied.push(op)
    }
  }
  trimTrailingBlank(lines)
  let next = lines.join('\n')
  if (next.length > 0 && !next.endsWith('\n')) next += '\n'
  return { text: next, applied }
}

/** 在标题行 idx 那一节的末尾插入一行（下一个标题之前，去掉尾部空行）。 */
function insertInSection(lines, idx, line) {
  let end = lines.length
  for (let i = idx + 1; i < lines.length; i++) {
    if (lines[i].startsWith('#')) {
      end = i
      break
    }
  }
  let at = end
  while (at > idx + 1 && lines[at - 1].trim() === '') at--
  lines.splice(at, 0, line)
}

/** 记忆库一行：日期由插件补，正文去掉模型自己带的日期与行首符号。 */
export function memoryLine(op) {
  const body = String(op.line || '')
    .replace(/^-\s*/, '')
    .replace(/^\d{4}-\d{2}-\d{2}\s*[:：]\s*/, '')
  return (op.date ? '- ' + op.date + '：' : '- ') + body
}

function trimTrailingBlank(lines) {
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
}

/** 记忆库新增：按 quote 找到原消息，用消息当天（本地时区）补日期。 */
export function attachMemoryDates(ops, messages) {
  const list = messages || []
  for (const op of ops || []) {
    if (op.target !== 'memory' || op.op !== 'add') continue
    if (!op.date) {
      const hit = list.find((m) => m && normalizeSpace(m.text).includes(op.quote))
      if (hit && Number.isFinite(Number(hit.time))) op.date = dateText(Number(hit.time))
    }
    if (!op.topic && String(op.anchor || '').startsWith(MEMORY_TOPIC_PREFIX)) {
      op.topic = op.anchor.slice(MEMORY_TOPIC_PREFIX.length).trim()
    }
  }
  return ops
}

export function dateText(ts) {
  const d = new Date(Number(ts))
  if (Number.isNaN(d.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

export function archiveTooLarge(text) {
  return Buffer.byteLength(text, 'utf8') > MAX_ARCHIVE_BYTES
}

export const LIMITS = { MAX_LINE, MAX_ADD_REPLACE, MAX_DELETE, MAX_ARCHIVE_BYTES }
