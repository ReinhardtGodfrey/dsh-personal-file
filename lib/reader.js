import fs from 'node:fs'
import zlib from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 列出 sessions 根目录下全部会话日志文件（每个 session 一个 .jsonl.zstd）。 */
export function listSessionFiles(root) {
  const out = []
  let projects
  try {
    projects = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const projectDir = fsPathJoin(root, project.name)
    let sessions
    try {
      sessions = fs.readdirSync(projectDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      const sessionDir = fsPathJoin(projectDir, session.name)
      let files
      try {
        files = fs.readdirSync(sessionDir)
      } catch {
        continue
      }
      for (const name of files) {
        if (!name.endsWith('.jsonl.zstd')) continue
        out.push({ sessionId: session.name, project: project.name, file: fsPathJoin(sessionDir, name), size: safeSize(fsPathJoin(sessionDir, name)) })
      }
    }
  }
  return out
}

function fsPathJoin(base, name) {
  return base.endsWith('\\') || base.endsWith('/') ? base + name : base + '\\' + name
}

function safeSize(file) {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

/**
 * 从文件中 offset 处读到文件末尾，按 zstd 帧逐帧解压并解析 JSON 行。
 * 帧边界用 magic 扫描；magic 命中但解压失败时与下一帧合并重试。
 * 末尾不完整的帧不消费，nextOffset 停在该帧起点，下次运行重试。
 */
export function readSessionAppend(file, offset) {
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    return null
  }
  const size = stat.size
  const start = offset >= 0 && offset <= size ? offset : 0
  if (size <= start) return { events: [], nextOffset: start, size, header: null, torn: false }

  let buf
  try {
    const fd = fs.openSync(file, 'r')
    try {
      buf = Buffer.allocUnsafe(size - start)
      fs.readSync(fd, buf, 0, buf.length, start)
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }

  const findMagic = (from, to) => {
    for (let i = from; i + 4 <= to; i++) {
      if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) return i
    }
    return -1
  }

  const lines = []
  const events = []
  let header = null
  let pos = findMagic(0, buf.length)
  let nextOffset = size
  if (pos < 0) return { events: [], nextOffset: size, size, header: null, torn: false }

  while (pos < buf.length) {
    let end = findMagic(pos + 4, buf.length)
    if (end < 0) end = buf.length
    let decoded = null
    for (;;) {
      try {
        decoded = zlib.zstdDecompressSync(buf.subarray(pos, end))
        break
      } catch {
        if (end >= buf.length) break
        const next = findMagic(end + 4, buf.length)
        end = next < 0 ? buf.length : next
      }
    }
    if (!decoded) {
      nextOffset = start + pos
      break
    }
    const text = decoded.toString('utf8')
    for (const line of text.split('\n')) {
      if (line.length === 0) continue
      lines.push(line)
    }
    pos = end
    nextOffset = start + pos
  }

  for (const line of lines) {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (!event || typeof event !== 'object') continue
    if (event.type === 'session') {
      header = event
      continue
    }
    if (typeof event.type === 'string') events.push(event)
  }

  return { events, nextOffset: Math.min(nextOffset, size), size, header, torn: nextOffset < size }
}

/** 从一条 user/message 事件里取出正文；不是（或没有）正文时返回空串。 */
export function userMessageText(event) {
  const content = event && event.data && event.data.content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/** 只认噗噗本人的通道：source.kind 为 user 或 qq。 */
export function isHisMessage(event) {
  if (!event || event.type !== 'user/message') return false
  const source = event.data && event.data.source
  if (!source) return false
  return source.kind === 'user' || source.kind === 'qq'
}

export function messageId(event) {
  return event && event.data && typeof event.data.id === 'string' ? event.data.id : null
}
