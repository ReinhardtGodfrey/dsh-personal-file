/**
 * 独立模型调用：只在插件自己的运行里使用 ctx.llm，不碰会话本身的对话。
 */

/** 调一次模型，返回纯文本输出；失败抛 Error（带出可用诊断）。 */
export async function askModel(ctx, cfg, prompt, options = {}) {
  const messages = [
    {
      role: 'user',
      content: [{ type: 'text', text: prompt }],
    },
  ]
  const request = {
    provider: cfg.provider,
    model: cfg.model,
    messages,
    temperature: options.temperature ?? 0.2,
    maxTokens: options.maxTokens ?? 3000,
  }
  if (cfg.reasoningEffort) request.reasoningEffort = cfg.reasoningEffort

  // 单次调用超时：没有上限的话，提供方不返回就会一直挂着，整轮补扫卡死。
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 180000
  const controller = new AbortController()
  const timerId = setTimeout(() => controller.abort(), timeoutMs)
  request.signal = options.signal || controller.signal

  let text = ''
  let finished = false
  let failure = null
  let finishKind = null
  try {
    for await (const chunk of ctx.llm.stream(request)) {
      if (!chunk || typeof chunk !== 'object') continue
      if (chunk.type === 'text-delta') {
        if (typeof chunk.text === 'string') text += chunk.text
      } else if (chunk.type === 'finish') {
        finished = true
        finishKind = chunk.reason && chunk.reason.kind ? chunk.reason.kind : null
        if (chunk.reason && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
          failure = chunk.reason.failure || { message: JSON.stringify(chunk.reason) }
        }
      }
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error('模型调用超时（超过 ' + timeoutMs + ' 毫秒没有结果），已放弃这次调用')
    }
    throw new Error('模型调用失败：' + errorText(error))
  } finally {
    clearTimeout(timerId)
  }
  if (failure) throw new Error('模型调用失败：' + errorText(failure))
  if (!finished) throw new Error('模型调用未正常结束（没有收到 finish）')
  if (finishKind === 'max-tokens') throw new Error('模型输出被截断（max-tokens），没拿到完整 JSON：' + text.slice(0, 160))
  return text
}

function errorText(value) {
  if (!value) return '未知错误'
  if (typeof value === 'string') return value
  if (typeof value.message === 'string' && value.message.length > 0) return value.message
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** 丢掉 ```json 围栏，截取最外层 {…}，再解析。 */
export function parseModelJson(text) {
  let s = String(text || '').trim()
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) s = fence[1].trim()
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('模型输出里没有 JSON 对象')
  return JSON.parse(s.slice(start, end + 1))
}
