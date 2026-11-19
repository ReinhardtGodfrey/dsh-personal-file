import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const plugin = path.join(HERE, '..')
const load = (rel) => import(pathToFileURL(path.join(plugin, rel)).href)
const [reader, ops, store, llm, pipeline, index] = await Promise.all([
  load('lib/reader.js'),
  load('lib/ops.js'),
  load('lib/store.js'),
  load('lib/llm.js'),
  load('lib/pipeline.js'),
  load('index.js'),
])

const failures = []
let checks = 0
function check(name, ok, extra = '') {
  checks++
  if (!ok) failures.push(name + (extra ? ' —— ' + extra : ''))
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? ' | ' + extra : ''))
}

// 1. 会话文件枚举（用本机 DSH 的 sessions 目录；没有就跳过下面两组解码检查）
const sessionsRoot = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'sessions')
const files = reader.listSessionFiles(sessionsRoot)
if (files.length) {
  check('listSessionFiles 能列出会话文件', true, files.length + ' 个')
  check('每个条目都有 sessionId/project/file/size', files.every((f) => f.sessionId && f.project && f.file && Number.isFinite(f.size)))
} else {
  console.log('SKIP 本机没有 ' + sessionsRoot + ' 下的会话文件，跳过解码检查（装上 DSH 并产生会话后再跑这条）')
}

if (files.length) {
// 2. 逐帧解码最大的一个会话文件
const biggest = files.slice().sort((a, b) => b.size - a.size)[0]
const decoded = reader.readSessionAppend(biggest.file, 0)
check('readSessionAppend 返回结构完整', decoded && Array.isArray(decoded.events) && Number.isFinite(decoded.nextOffset))
check('首行 header 被解析出来', decoded && decoded.header && decoded.header.type === 'session', decoded && decoded.header ? decoded.header.id : '无 header')
check('大文件全部帧解压成功（无残缺）', decoded && decoded.torn === false, biggest.size + ' B')
check('事件数量大于 1000', decoded && decoded.events.length > 1000, decoded ? decoded.events.length + ' 条' : '')
check('nextOffset 等于文件大小', decoded && decoded.nextOffset === decoded.size)

// 3. seq 连续、时间单调
let seqOk = true
let timeOk = true
let prevSeq = null
let prevTime = null
for (const ev of decoded.events) {
  if (typeof ev.seq === 'number') {
    if (prevSeq != null && ev.seq !== prevSeq + 1) seqOk = false
    prevSeq = ev.seq
  }
  if (typeof ev.time === 'number') {
    if (prevTime != null && ev.time < prevTime) timeOk = false
    prevTime = ev.time
  }
}
check('事件 seq 严格 +1 连续', seqOk)
check('事件 time 单调不减', timeOk)

// 4. 本人通道判定与正文提取
const his = decoded.events.filter((e) => reader.isHisMessage(e))
check('能找到本人 user/message', his.length > 0, his.length + ' 条')
check('本人消息有可提取正文', his.length > 0 && his.some((e) => reader.userMessageText(e).length > 0))
check('系统注入不是本人消息', decoded.events.filter((e) => e.type === 'user/message').some((e) => !reader.isHisMessage(e)))
check('messageId 从 data.id 读取', his.length > 0 && reader.messageId(his[0]) !== null)

// 5. 增量读取：从中间帧起点继续
const halfway = Math.floor(decoded.size / 2)
const tail = reader.readSessionAppend(biggest.file, halfway)
if (tail) {
  check('从中间偏移读取不抛错', Array.isArray(tail.events))
  check('中间偏移读取的 nextOffset 到达文件尾', tail.nextOffset === tail.size)
}
}

// 6. ops 校验
const archiveText = '# 关于我\n\n### 基本情况\n- 称呼：测试用户\n- 生日：2006-09-22\n\n### 沟通偏好\n- 短句为主\n\n### 项目\n- 测试项目\n'
const memoryText = '# 记忆库（次要信息）\n\n## 自动记录\n'
const messages = [
  { id: 'm1', text: '我下周三要去杭州', timeText: '11:00', time: 1000, session: 's1', source: 'user' },
]
const rawOps = [
  { target: 'archive', op: 'add', anchor: '### 基本情况', line: '- 下周三去杭州', weight: 5, quote: '下周三要去杭州', session: 's1', time: '11:00' },
  { target: 'archive', op: 'add', anchor: '### 不存在的小节', line: '- x', weight: 5, quote: '下周三要去杭州' },
  { target: 'archive', op: 'add', anchor: '### 基本情况', line: '- 重复生日行', weight: 5, quote: '不存在的原话' },
  { target: 'archive', op: 'add', anchor: '### 基本情况', line: '- 低权重内容', weight: 2, quote: '下周三要去杭州' },
  { target: 'memory', op: 'add', anchor: 'append', line: '- 临时：周三杭州', weight: 3, quote: '杭州', session: 's1', time: '11:00' },
  { target: 'archive', op: 'delete', old: '- 生日：2006-09-22', weight: 5, quote: '生日', session: 's1', time: '11:00' },
]
const validated = ops.validateOps(rawOps, { archive: archiveText, memory: memoryText, messages })
check('校验：合法档案新增被接受', validated.archive.length === 1 && validated.archive[0].line === '- 下周三去杭州', 'archive=' + validated.archive.length)
check('校验：合法记忆库新增被接受', validated.memory.length === 1, 'memory=' + validated.memory.length)
check('校验：拒绝项记录了 4 条原因', validated.rejected.length === 4, validated.rejected.map((r) => r.reason).join(' / '))
check('校验：低权重进档案被拒', validated.rejected.some((r) => r.reason.includes('权重 5')))
check('校验：编造 quote 被拒', validated.rejected.some((r) => r.reason.includes('找不到逐字原文')))

// 6b. 相似条目：add 命中近似条目转 replace；replace 的 old 写偏时纠正到实际行
const simMessages = [{ id: 'm2', text: '我的生日是 2006 年 9 月 22 日', timeText: '11:00', time: 1100, session: 's1', source: 'user' }]
const simOps = [
  { target: 'archive', op: 'add', anchor: '### 基本情况', line: '- 生日：2006-09-22（公历）', weight: 5, quote: '生日是 2006 年 9 月 22 日', session: 's1', time: '11:00' },
  { target: 'archive', op: 'replace', old: '- 生日：2006-09-22 那天', line: '- 生日：2006-09-22（确认）', weight: 5, quote: '生日是 2006 年 9 月 22 日', session: 's1', time: '11:00' },
]
const simValidated = ops.validateOps(simOps, { archive: archiveText, memory: memoryText, messages: simMessages })
check('相似新增自动转成 replace', simValidated.archive.some((o) => o.op === 'replace' && o.old === '- 生日：2006-09-22'), 'archive=' + JSON.stringify(simValidated.archive.map((o) => [o.op, o.old])))
check('写偏的 old 被纠正到实际行', simValidated.archive.filter((o) => o.op === 'replace' && o.old === '- 生日：2006-09-22').length === 2, 'rejected=' + simValidated.rejected.map((r) => r.reason).join(' / '))

// 7. applyOps
const applied = ops.applyOps(archiveText, validated.archive)
check('applyOps 把新增插到指定小节内', applied.text.includes('- 下周三去杭州') && applied.text.includes('- 生日：2006-09-22') && applied.text.indexOf('- 下周三去杭州') > applied.text.indexOf('- 生日：2006-09-22'))
check('applyOps 插在下一个小节标题之前', applied.text.indexOf('- 下周三去杭州') < applied.text.indexOf('### 沟通偏好'))
const memApplied = ops.applyOps(memoryText, validated.memory)
check('applyOps 记忆库 append 生效', memApplied.text.includes('- 临时：周三杭州'))
check('applyOps 结果保留尾部换行', applied.text.endsWith('\n') && memApplied.text.endsWith('\n'))
check('档案超 60000 字节判定可用', ops.archiveTooLarge('x'.repeat(60001)) && !ops.archiveTooLarge('x'.repeat(60000)))

// 8. 每批上限
const many = []
for (let i = 0; i < 20; i++) many.push({ target: 'archive', op: 'add', anchor: 'append', line: '- 第' + i + '条', weight: 5, quote: '下周三要去杭州' })
const capped = ops.validateOps(many, { archive: '', memory: '', messages })
check('每批新增上限 12 条生效', capped.archive.length === 12 && capped.rejected.length === 8, 'accepted=' + capped.archive.length)

// 9. store 基础能力
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-store-'))
const tmpFile = path.join(tmpDir, 'a.txt')
store.atomicWrite(tmpFile, 'hello')
check('atomicWrite 写入内容正确', store.readText(tmpFile) === 'hello')
check('sha256 稳定', store.sha256('hello') === store.sha256('hello') && store.sha256('hello') !== store.sha256('hello2'))
const backup = store.backupFile(tmpFile, path.join(tmpDir, 'backups'), '2026-01-01T00-00-00')
check('backupFile 生成备份', backup && fs.existsSync(backup), backup)
fs.rmSync(tmpDir, { recursive: true, force: true })

// 10. llm 的 JSON 解析
check('parseModelJson 能剥掉代码围栏', llm.parseModelJson('```json\n{"ops":[]}\n```').ops.length === 0)
check('parseModelJson 能截取前后废话中的 JSON', llm.parseModelJson('前面废话 {"ops":[1]} 后面废话').ops.length === 1)
check('parseModelJson 对无 JSON 抛错', (() => { try { llm.parseModelJson('没有对象'); return false } catch { return true } })())

// 11. 入口与管道导出
check('index.js 导出 apply 函数', typeof index.apply === 'function')
check('pipeline 导出 runOnce 函数', typeof pipeline.runOnce === 'function')

console.log('\n共 ' + checks + ' 项检查，失败 ' + failures.length + ' 项')
if (failures.length > 0) {
  console.log('失败明细：')
  for (const f of failures) console.log(' - ' + f)
  process.exitCode = 1
}
