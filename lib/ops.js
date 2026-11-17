/**
 * 提示词拼装 + 模型输出校验 + 文本落盘操作。
 * 模型只准提 ops，写与不写、怎么改由这里按固定规则裁决。
 */

const MAX_LINE = 200
const MAX_ADD_REPLACE = 12
const MAX_DELETE = 3
const MAX_ARCHIVE_BYTES = 60000

export function buildPrompt({ archive, memory, messages, recent = [] }) {
  const batch = messages
    .map((m, i) => `[${i + 1}] 会话 ${m.session} · ${m.timeText} · ${m.source}\n${limit(m.text, 1200)}`)
    .join('\n\n')
  const recentText = recent.length
    ? recent.map((m) => `- ${m.timeText}：${limit(m.text, 160)}`).join('\n')
    : '（无）'

  return `你在维护一个人格档案，对象是「噗噗」。你的唯一任务是：从下面这批他自己发的消息里，找出关于他本人、值得长期记住的信息，并且只输出一份 JSON 操作清单。

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

【本批消息】
${batch}

【判断规则】
- 只提取本人原话直接支持的内容；不要推测、不要补全、不要从助手的话里反推他的信息。
- 每条事实配一句原话片段 quote（必须逐字出现在本批某条消息里，最多 60 字）。
- 权重：5 = 稳定身份、长期关系、长期工作方式、明确且反复出现的偏好；4 = 新的、长期有用的具体事实或偏好；3 = 次要但可留的信息；1–2 = 临时状态、一次性的安排、情绪，不写。
- 档案（AGENTS.md）只收 weight >= 4 的内容，且写成一行陈述，善用原文措辞；记忆库收 weight = 3 的内容。
- 已经写进档案或记忆库、意思相同的内容不要重复输出。
- 与档案已有内容冲突时，用 replace 改掉旧行；他明确否定了档案里的某条，才用 delete；没提到不等于否定，不许删。
- 拿不准真假的，不要输出。
- 本批没有值得写的内容时，输出 {"ops":[]}。

【输出格式】只输出 JSON，不要解释：
{"ops":[
  {"target":"archive","op":"add","anchor":"## 关于噗噗","line":"- 新的稳定事实","weight":4,"quote":"原话片段","session":"会话标识","time":"消息时间"},
  {"target":"archive","op":"replace","old":"- 档案里原有的整行","line":"- 改后的整行","weight":5,"quote":"原话片段","session":"会话标识","time":"消息时间"},
  {"target":"memory","op":"add","anchor":"## 自动记录","line":"- 次要信息","weight":3,"quote":"原话片段","session":"会话标识","time":"消息时间"},
  {"target":"memory","op":"delete","old":"- 记忆库里原有的整行","weight":3,"quote":"原话片段","session":"会话标识","time":"消息时间"}
]}
- add 的 anchor 必须是目标文件里真实存在的、以 # 开头的标题整行，或者字符串 append（追加到文件末尾）。
- replace / delete 的 old 必须是目标文件里那一行的完整原文（含行首符号），且全文件唯一。
- line 必须是单行，最多 ${MAX_LINE} 字。
- 每批每文件最多 ${MAX_ADD_REPLACE} 条新增/修改、${MAX_DELETE} 条删除。`
}

function limit(text, max) {
  const s = String(text || '')
  return s.length <= max ? s : s.slice(0, max) + '…'
}

/**
 * 校验模型给的 ops，返回可执行的分拣结果与拒绝记录。
 * messages 是本批消息 {text, session, timeText, source}。
 */
export function validateOps(rawOps, { archive, memory, messages }) {
  const out = { archive: [], memory: [], rejected: [] }
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
      const targetText = op.target === 'archive' ? archive : memory
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
      if (op.target === 'archive' && op.weight < 4) {
        out.rejected.push({ op: raw, reason: '档案只收权重 >= 4 的内容' })
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
  const weight = Number(raw.weight)
  if (!Number.isFinite(weight)) return null
  const op = {
    target,
    op: opName,
    weight: Math.round(weight),
    quote: stringOr(raw.quote),
    session: stringOr(raw.session),
    time: stringOr(raw.time),
  }
  if (opName === 'add') {
    op.anchor = stringOr(raw.anchor) || 'append'
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
      if (op.anchor === 'append') {
        trimTrailingBlank(lines)
        lines.push(op.line)
        lines.push('')
      } else {
        const idx = lines.findIndex((l) => l.trim() === op.anchor.trim())
        if (idx < 0) continue
        let end = lines.length
        for (let i = idx + 1; i < lines.length; i++) {
          if (lines[i].startsWith('#')) {
            end = i
            break
          }
        }
        let at = end
        while (at > idx + 1 && lines[at - 1].trim() === '') at--
        lines.splice(at, 0, op.line)
      }
      applied.push(op)
    } else if (op.op === 'replace') {
      const idx = lines.findIndex((l) => l.trim() === op.old)
      if (idx < 0) continue
      const indent = (lines[idx].match(/^[ \t]*/) || [''])[0]
      lines[idx] = indent + op.line
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

function trimTrailingBlank(lines) {
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
}

export function archiveTooLarge(text) {
  return Buffer.byteLength(text, 'utf8') > MAX_ARCHIVE_BYTES
}

export const LIMITS = { MAX_LINE, MAX_ADD_REPLACE, MAX_DELETE, MAX_ARCHIVE_BYTES }
