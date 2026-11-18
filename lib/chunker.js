/**
 * 切批：先按会话分组，再在会话内按条数与字数切。
 * 同一条会话的消息尽量放在一起，跨批的事实才连得起来；
 * 除第一批外，每批带上一批最后 3 条原话作为只读上下文（用于理解指代，不从这里提取事实）。
 */

export function chunkBySession(messages, options = {}) {
  const maxCount = Number(options.maxCount) > 0 ? Number(options.maxCount) : 40
  const maxChars = Number(options.maxChars) > 0 ? Number(options.maxChars) : 18000
  const overlap = Number(options.overlap) >= 0 ? Number(options.overlap) : 3

  const groups = new Map()
  for (const m of messages) {
    if (!groups.has(m.session)) groups.set(m.session, [])
    groups.get(m.session).push(m)
  }

  const out = []
  for (const list of groups.values()) {
    let current = []
    let chars = 0
    let previousTail = []
    const flush = () => {
      if (current.length === 0) return
      out.push({ messages: current, context: previousTail })
      previousTail = overlap > 0 ? current.slice(-overlap) : []
      current = []
      chars = 0
    }
    for (const m of list) {
      const cost = String(m.text || '').length + 80
      if (current.length > 0 && (current.length >= maxCount || chars + cost > maxChars)) flush()
      current.push(m)
      chars += cost
    }
    flush()
  }
  out.sort((a, b) => a.messages[0].time - b.messages[0].time)
  return out
}
