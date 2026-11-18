import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import zlib from 'node:zlib'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const plugin = path.join(HERE, '..')
const load = (rel) => import(pathToFileURL(path.join(plugin, rel)).href)
const [reader, store, pipeline] = await Promise.all([load('lib/reader.js'), load('lib/store.js'), load('lib/pipeline.js')])

const failures = []
let checks = 0
function check(name, ok, extra = '') {
  checks++
  if (!ok) failures.push(name + (extra ? ' —— ' + extra : ''))
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? ' | ' + extra : ''))
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-pipeline-'))
const sessionsRoot = path.join(root, 'sessions')
const pluginRoot = path.join(root, 'plugin')
const archivePath = path.join(root, 'AGENTS.md')
const memoryPath = path.join(root, '记忆库.md')
fs.mkdirSync(path.join(pluginRoot, 'data'), { recursive: true })
fs.mkdirSync(sessionsRoot, { recursive: true })

const archiveInitial = '# 关于我\n\n### 基本情况\n- 称呼：测试用户\n\n### 沟通偏好\n- 短句为主\n'
fs.writeFileSync(archivePath, archiveInitial, 'utf8')

const frame = (obj) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(obj) + '\n'))
function writeSession(file, header, events) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const parts = [frame(header)]
  for (const ev of events) parts.push(frame(ev))
  fs.writeFileSync(file, Buffer.concat(parts))
}
function appendSession(file, events) {
  const parts = events.map((ev) => frame(ev))
  fs.appendFileSync(file, Buffer.concat(parts))
}

const now = Date.now()
const header1 = { type: 'session', version: 4, id: 'sess-1', createdAt: now - 3600000, cwd: root, origin: 'user', delegationDepth: 0 }
const session1File = path.join(sessionsRoot, 'proj-a', 'sess-1', 'session.v4.jsonl.zstd')
writeSession(session1File, header1, [
  { type: 'user/message', seq: 0, time: now - 30000, data: { id: 'old-1', content: [{ type: 'text', text: '安装前的旧消息不应被读' }], source: { kind: 'user' }, role: 'user' } },
])

const modelOps = [
  { target: 'archive', op: 'add', anchor: '### 基本情况', line: '- 正在学吉他，每天练半小时', weight: 5, quote: '在学吉他，每天练半小时', session: 'sess-2', time: '现在' },
  { target: 'memory', op: 'add', topic: '作息', line: '- 说今天有点困', weight: 3, quote: '今天有点困', session: 'sess-2', time: '现在' },
  { target: 'archive', op: 'add', anchor: '### 基本情况', line: '- 编造的条目', weight: 5, quote: '这句原话根本不存在', session: 'sess-2', time: '现在' },
]
const calls = []
function opsFor(prompt) {
  const ops = []
  if (prompt.includes('学吉他')) {
    ops.push({ target: 'archive', op: 'add', anchor: '### 基本情况', line: '- 正在学吉他，每天练半小时', weight: 5, quote: '在学吉他，每天练半小时', session: 'sess-2', time: '现在' })
  }
  if (prompt.includes('有点困')) {
    ops.push({ target: 'memory', op: 'add', topic: '作息', line: '- 说今天有点困', weight: 3, quote: '今天有点困', session: 'sess-2', time: '现在' })
    ops.push({ target: 'memory', op: 'add', anchor: '## 自动记录', line: '- 可能喜欢猫', weight: 3, quote: '今天有点困', session: 'sess-2', time: '现在', uncertain: true })
  }
  if (prompt.includes('吃了拉面')) {
    ops.push({ target: 'archive', op: 'add', anchor: '### 基本情况', line: '- 今天中午吃了拉面', weight: 5, quote: '我今天中午吃了拉面', session: 'sess-2', time: '现在' })
  }
  if (prompt.includes('去杭州')) {
    ops.push({ target: 'archive', op: 'add', anchor: '### 基本情况', line: '- 下周要去杭州', weight: 5, quote: '去杭州', session: 'sess-1', time: '现在' })
  }
  ops.push({ target: 'archive', op: 'add', anchor: '### 基本情况', line: '- 编造的条目', weight: 5, quote: '这句原话根本不存在', session: 'sess-2', time: '现在' })
  return ops
}
// 二次打分：按候选项给第二次得分，拉面刻意打 2，验证 4+2 均分 3 后降到记忆库
function scoresFor(prompt) {
  const head = prompt.split('个人档案现状（节选）')[0]
  const scores = []
  for (const line of head.split('\n')) {
    const hit = line.match(/^(\d+)\. (.*)$/)
    if (!hit) continue
    const text = hit[2]
    let weight = 3
    if (text.includes('学吉他')) weight = 5
    if (text.includes('有点困')) weight = 3
    if (text.includes('拉面')) weight = 2
    if (text.includes('去杭州')) weight = 5
    scores.push({ index: Number(hit[1]), weight })
  }
  return scores
}
function fakeCtx() {
  return {
    llm: {
      stream: async function* (req) {
        calls.push(req)
        const text = req.messages[0].content[0].text
        const scoring = text.includes('边界上，请逐条重新独立打分')
        const payload = scoring
          ? JSON.stringify({ scores: scoresFor(text) })
          : JSON.stringify({ ops: opsFor(text) })
        for (const piece of [payload.slice(0, 40), payload.slice(40, 120), payload.slice(120)]) {
          yield { type: 'text-delta', index: 0, text: piece }
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }
}
const dshHome = path.join(root, 'dsh-home')
fs.mkdirSync(dshHome, { recursive: true })
fs.writeFileSync(
  path.join(dshHome, 'qq-bridge-config.json'),
  JSON.stringify({ 绑定: [
    { 类型: '私聊', 号码: '111111111', 会话: 'sess-1', 称呼: '本人甲', 门槛: 0 },
    { 类型: '私聊', 号码: '111111111', 会话: 'sess-2', 称呼: '本人乙', 门槛: 0 },
  ] }) + '\n',
)
const cfg = {
  pluginRoot,
  dshHome,
  archivePath,
  memoryPath,
  sessionsRoot,
  runHour: 13,
  keepBackups: 60,
  maxTokens: 3000,
  ownQq: '111111111',
  llm: { provider: 'test-provider', model: 'test-model' },
}

// 第一轮：基线，不读历史
const run1 = await pipeline.runOnce(fakeCtx(), cfg, { trigger: 'startup' })
check('第一轮状态为基线', run1.status === '基线', run1.status)
check('基线不调用模型', calls.length === 0, '模型调用 ' + calls.length + ' 次')
const statePath = path.join(pluginRoot, 'data', 'state.json')
const state1 = JSON.parse(fs.readFileSync(statePath, 'utf8'))
check('state 记录 installedAt', Number.isFinite(state1.installedAt) && state1.installedAt > 0)
check('state 记录文件长度基线', state1.files[session1File] && state1.files[session1File].offset === fs.statSync(session1File).size)
check('基线没有改动档案', fs.readFileSync(archivePath, 'utf8') === archiveInitial)
check('基线不创建记忆库', !fs.existsSync(memoryPath))

// 追加新消息：旧会话追加 + 新会话（含系统注入）
appendSession(session1File, [
  { type: 'user/message', seq: 1, time: now + 1000, data: { id: 'new-1', content: [{ type: 'text', text: '我最近在学吉他，每天练半小时' }], source: { kind: 'user' }, role: 'user' } },
])
const header2 = { type: 'session', version: 4, id: 'sess-2', createdAt: now + 5000, cwd: root, origin: 'user', delegationDepth: 0 }
const session2File = path.join(sessionsRoot, 'proj-b', 'sess-2', 'session.v4.jsonl.zstd')
writeSession(session2File, header2, [
  { type: 'user/message', seq: 0, time: now + 6000, data: { id: 'inj-1', content: [{ type: 'text', text: '<system-reminder>时间注入</system-reminder>' }], source: { kind: 'time-context' }, role: 'user' } },
  { type: 'user/message', seq: 1, time: now + 7000, data: { id: 'new-2', content: [{ type: 'text', text: '今天有点困' }], source: { kind: 'qq' }, role: 'user' } },
  { type: 'assistant/message', seq: 2, time: now + 8000, data: { turn: 1, step: 0, message: { role: 'assistant', content: [{ type: 'text', text: '助手说的话不应被提取' }] } } },
  { type: 'user/message', seq: 3, time: now + 8500, data: { id: 'new-4', content: [{ type: 'text', text: '我今天中午吃了拉面' }], source: { kind: 'user' }, role: 'user' } },
])

fs.writeFileSync(path.join(pluginRoot, 'data', 'mode.txt'), 'live')

// 第二轮：真实写
const run2 = await pipeline.runOnce(fakeCtx(), cfg, { trigger: 'daily' })
const archiveAfter = fs.readFileSync(archivePath, 'utf8')
const memoryAfter = fs.readFileSync(memoryPath, 'utf8')
check('第二轮状态为成功', run2.status === '成功', run2.status + ' / ' + run2.errors.join('; '))
check('两个会话各一批，共调用四次模型（每批抽取 + 边界二次打分）', calls.length === 4, '调用 ' + calls.length + ' 次')
check('第二次调用是二次打分', calls[1] && calls[1].messages[0].content[0].text.includes('边界上，请逐条重新独立打分'))
const promptsText = calls.map((c) => c.messages[0].content[0].text).join('\n')
check('提示词只含本人消息', promptsText.includes('在学吉他') && promptsText.includes('今天有点困') && !promptsText.includes('安装前的旧消息') && !promptsText.includes('<system-reminder>') && !promptsText.includes('助手说的话不应被提取'))
check('合法新增写进档案', archiveAfter.includes('- 正在学吉他，每天练半小时'))
check('编造 quote 的条目被拒绝', !archiveAfter.includes('- 编造的条目') && run2.rejected.some((r) => r.reason.includes('找不到逐字原文')))
check('记忆库按主题分节、带日期写入 3 分条目', memoryAfter.startsWith('# 记忆库') && /- \d{4}-\d{2}-\d{2}：说今天有点困/.test(memoryAfter) && memoryAfter.includes('## 主题：'))
check('二次打分 5+2 取较低档 2 后丢弃', !memoryAfter.includes('- 今天中午吃了拉面') && !archiveAfter.includes('- 今天中午吃了拉面') && run2.rejected.some((r) => r.reason.includes('≤2')) )
check('降档丢弃时不再写记忆库', !memoryAfter.includes('- 今天中午吃了拉面'))
check('系统注入与助手消息没有进记忆库', !memoryAfter.includes('时间注入') && !memoryAfter.includes('助手说的话'))
check('每处改动都记录了依据', (run2.added.length === 2) && run2.added.every((a) => a.quote && a.session), 'added=' + run2.added.length)
check('降档条目记录了两次得分', run2.rejected.some((r) => r.op && r.op.weight1 === 5 && r.op.weight2 === 2 && r.op.weight === 2))
check('不确定的条目进待确认区', run2.pending.length === 1 && run2.pendingAdded === 1, 'pending=' + run2.pending.length + ' added=' + run2.pendingAdded)
const pendingFile = path.join(pluginRoot, 'data', '待确认.md')
check('待确认文件已写', fs.existsSync(pendingFile) && fs.readFileSync(pendingFile, 'utf8').includes('- 可能喜欢猫'))

const backupDirs = fs.readdirSync(path.join(pluginRoot, 'backups'))
check('写入前生成了备份目录', backupDirs.length === 1, backupDirs.join(','))
const backupFiles = fs.readdirSync(path.join(pluginRoot, 'backups', backupDirs[0]))
check('备份里有档案与记忆库', backupFiles.includes('AGENTS.md') && backupFiles.some((n) => n.includes('记忆库')), backupFiles.join(','))
check('备份里的档案是写前版本', fs.readFileSync(path.join(pluginRoot, 'backups', backupDirs[0], 'AGENTS.md'), 'utf8') === archiveInitial)

const logDir = path.join(pluginRoot, 'logs')
const logFiles = fs.readdirSync(logDir)
const dailyLogs = logFiles.filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n))
check('生成了当天运行日志', dailyLogs.length === 1, logFiles.join(','))
const logText = fs.readFileSync(path.join(logDir, dailyLogs[0]), 'utf8')
check('日志记录了依据原话', logText.includes('依据') && logText.includes('在学吉他，每天练半小时'))
check('日志记录了拒绝原因', logText.includes('拒绝') && logText.includes('找不到逐字原文'))

const state3 = JSON.parse(fs.readFileSync(statePath, 'utf8'))
check('state 推进了读取位置', state3.files[session1File].offset === fs.statSync(session1File).size && state3.files[session2File].offset === fs.statSync(session2File).size)
check('state 记录了写后档案哈希', state3.archiveHash === store.sha256(archiveAfter))
check('state 记录了上次运行状态', state3.lastRunStatus === '成功' && Number.isFinite(state3.lastRunAt))

// 第三轮：没有新消息
const run3 = await pipeline.runOnce(fakeCtx(), cfg, { trigger: 'daily' })
check('第三轮无新增时为成功无变更', run3.status === '成功无变更', run3.status)
check('第三轮不再调用模型', calls.length === 4, '调用 ' + calls.length + ' 次')
check('第三轮档案没有被重复改动', fs.readFileSync(archivePath, 'utf8') === archiveAfter)

// 第四轮：模型失败时整轮不写、读取位置退回
appendSession(session1File, [
  { type: 'user/message', seq: 2, time: now + 9000, data: { id: 'new-3', content: [{ type: 'text', text: '我下周要去杭州' }], source: { kind: 'user' }, role: 'user' } },
])
const badCtx = { llm: { stream: async function* () { throw new Error('模拟网络失败') } } }
const stateBeforeFail = JSON.parse(fs.readFileSync(statePath, 'utf8'))
const run4 = await pipeline.runOnce(badCtx, cfg, { trigger: 'daily' })
check('模型失败时状态为失败', run4.status === '失败', run4.status)
check('模型失败时不改档案', fs.readFileSync(archivePath, 'utf8') === archiveAfter)
const stateAfterFail = JSON.parse(fs.readFileSync(statePath, 'utf8'))
check('模型失败时读取位置退回', stateAfterFail.files[session1File].offset === stateBeforeFail.files[session1File].offset)
check('模型失败时不推进 lastRunAt', Number(stateAfterFail.lastRunAt) === Number(stateBeforeFail.lastRunAt))

// 第五轮：模型恢复，补跑上一轮没处理的消息
const run5 = await pipeline.runOnce(fakeCtx(), cfg, { trigger: 'daily' })
check('失败后下一轮能补跑', run5.status === '成功' && run5.messages === 1, run5.status + ' / ' + run5.messages + ' 条')

fs.rmSync(root, { recursive: true, force: true })

console.log('\n共 ' + checks + ' 项检查，失败 ' + failures.length + ' 项')
if (failures.length > 0) {
  console.log('失败明细：')
  for (const f of failures) console.log(' - ' + f)
  process.exitCode = 1
}
