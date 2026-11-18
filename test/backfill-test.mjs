import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.join(HERE, '..')
const TMP = path.join(HERE, '_tmp', 'backfill-case')
let pass = 0
let fail = 0
function ok(cond, name) {
  if (cond) {
    pass += 1
  } else {
    fail += 1
    console.log('FAIL: ' + name)
  }
}
function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}
function frame(obj) {
  return zlib.zstdCompressSync(Buffer.from(JSON.stringify(obj) + '\n', 'utf8'))
}
function writeSession(root, project, session, header, events) {
  const dir = path.join(root, project, 'session-' + session)
  fs.mkdirSync(dir, { recursive: true })
  const parts = [frame(header)]
  for (const ev of events) parts.push(frame(ev))
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.concat(parts))
}
function msg(id, seq, time, text, kind) {
  return {
    type: 'user/message',
    seq,
    time,
    data: { id, role: 'user', content: [{ type: 'text', text }], source: { kind } },
    surfaceOp: 'append',
  }
}
function title(seq, time, text) {
  return { type: 'session/title', seq, time, data: { title: text, source: { kind: 'user' } } }
}
function reset() {
  fs.rmSync(TMP, { recursive: true, force: true })
  fs.mkdirSync(TMP, { recursive: true })
}

const store = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'store.js')).href)
const { runBackfill } = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'backfill.js')).href)

const ARCHIVE_ORIGINAL = '# 关于我（长期档案）\n\n## 基本情况\n- 生日：2006-09-22\n'
const MEMORY_HEADER = '# 记忆库（次要信息）\n\n## 自动记录\n'

function setupCase(mode) {
  reset()
  const pluginRoot = path.join(TMP, 'plugin')
  fs.mkdirSync(path.join(pluginRoot, 'data'), { recursive: true })
  fs.writeFileSync(path.join(pluginRoot, 'data', 'mode.txt'), mode + '\n')
  const archivePath = path.join(TMP, 'AGENTS.md')
  fs.writeFileSync(archivePath, ARCHIVE_ORIGINAL)
  const memoryPath = path.join(TMP, '记忆库.md')
  const sessionsRoot = path.join(TMP, 'sessions')
  const state = {
    installedAt: 2000,
    archiveHash: sha256(ARCHIVE_ORIGINAL),
    memoryHash: sha256(MEMORY_HEADER),
    files: {},
  }
  fs.writeFileSync(path.join(pluginRoot, 'data', 'state.json'), JSON.stringify(state) + '\n')
  const qqProject = '--F-DeepseekHarness-~5927~80A5~9C7C~63A5~5165qq--'
  const otherProject = '--F-DeepseekHarness-~5B66~4E60--'
  writeSession(sessionsRoot, qqProject, 'A', { type: 'session', version: 4, id: 'session-A', createdAt: 1000, isSeeded: false, delegationDepth: 0 }, [
    title(1, 1100, '朋友A'),
    msg('m-c1', 2, 1400, 'C1', 'qq'),
    msg('m-u1', 3, 1500, 'U1', 'user'),
  ])
  writeSession(sessionsRoot, qqProject, 'B', { type: 'session', version: 4, id: 'session-B', createdAt: 1200, isSeeded: false, delegationDepth: 0 }, [
    title(1, 1210, '本人通道 2'),
    msg('m-q1', 2, 1600, 'Q1', 'qq'),
    msg('m-u2', 3, 1700, 'U2', 'user'),
  ])
  writeSession(sessionsRoot, otherProject, 'C', { type: 'session', version: 4, id: 'session-C', createdAt: 1300, isSeeded: false, delegationDepth: 0 }, [
    title(1, 1310, '学习'),
    msg('m-u3', 2, 1800, 'U3', 'user'),
    msg('m-q2', 3, 1900, 'Q2', 'qq'),
  ])
  writeSession(sessionsRoot, qqProject, 'S', { type: 'session', version: 4, id: 'session-S', createdAt: 1000, isSeeded: true, delegationDepth: 0 }, [
    title(1, 1010, '本人通道'),
    msg('m-u5', 2, 500, 'U5', 'user'),
  ])
  const dshHome = path.join(TMP, 'dsh-home')
  fs.mkdirSync(dshHome, { recursive: true })
  fs.writeFileSync(
    path.join(dshHome, 'qq-bridge-config.json'),
    JSON.stringify({
      绑定: [
        { 类型: '私聊', 号码: '222222222', 会话: 'session-A', 称呼: '朋友A', 门槛: 0 },
        { 类型: '私聊', 号码: '111111111', 会话: 'session-B', 称呼: '本人通道 2', 门槛: 0 },
      ],
    }) + '\n',
  )
  const cfg = {
    pluginRoot,
    dshHome,
    archivePath,
    memoryPath,
    sessionsRoot,
    llm: { provider: 'p', model: 'm' },
    maxTokens: 100,
    keepBackups: 2,
    ownQq: '111111111',
  }
  return { cfg, archivePath, memoryPath, pluginRoot }
}

function fakeCtx(responses) {
  let calls = 0
  return {
    llm: {
      stream: async function* (options) {
        const prompt = options.messages[0].content[0].text
        const reply = responses(calls, prompt)
        calls += 1
        yield { type: 'text-delta', index: 0, text: reply }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    get calls() {
      return calls
    },
  }
}

// 一：live 补扫，过滤 + 写入
{
  const { cfg, archivePath, memoryPath, pluginRoot } = setupCase('live')
  const ctx = fakeCtx((n) => JSON.stringify({ ops: [
    { target: 'archive', op: 'add', anchor: 'append', line: '- 补扫测试：学习计划', weight: 5, quote: 'U3', session: 'session-C', time: '2026-01-01 00:00:00' },
    { target: 'memory', op: 'add', topic: '补扫', line: '- 记忆补扫测试', weight: 3, quote: 'U3', session: 'session-C', time: '2026-01-01 00:00:00' },
  ] }))
  const result = await runBackfill(ctx, cfg, {})
  ok(result.status === '成功', 'live 补扫状态成功（实际 ' + result.status + '）')
  ok(result.messages === 4, '只收历史里的 4 条本人消息（实际 ' + result.messages + '）')
  ok(result.filtered === 2, '过滤掉 2 条（别人的 QQ 会话 + 判不出身份的 QQ 消息，实际 ' + result.filtered + '）')
  ok(result.sessions === 3, '3 个会话（实际 ' + result.sessions + '）')
  ok(ctx.calls === 4, '三个会话各一批，每批抽取、命中边界的再二次打分（实际 ' + ctx.calls + '）')
  ok(result.added.length === 2, '新增 2 条（实际 ' + result.added.length + '）')
  const archive = fs.readFileSync(archivePath, 'utf8')
  ok(archive.includes('- 补扫测试：学习计划'), '档案写入新行')
  ok(fs.existsSync(memoryPath), '记忆库被创建')
  const memory = fs.readFileSync(memoryPath, 'utf8')
    ok(memory.startsWith(MEMORY_HEADER), '记忆库表头正确')
  ok(/^- \d{4}-\d{2}-\d{2}：记忆补扫测试$/m.test(memory), '记忆库写入带日期的新行')
  ok(result.backupPath && fs.existsSync(result.backupPath), '写前备份存在')
  const state = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'data', 'state.json'), 'utf8'))
  ok(state.archiveHash === sha256(archive), 'state 档案哈希已更新')
  ok(state.memoryHash === sha256(memory), 'state 记忆库哈希已更新')
  ok(state.lastBackfillAt === result.startedAt, 'state 记下补扫时间')
  ok(!state.files || Object.keys(state.files).length === 0, '补扫不动日常读取位置')
  const { loadBindings } = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'qq-identity.js')).href)
  const bindings = loadBindings(cfg.dshHome)
  ok(bindings.get('session-A').number === '222222222' && bindings.get('session-B').number === '111111111', '绑定文件按 QQ 号解析成功')
  const backupFiles = fs.existsSync(path.join(pluginRoot, 'backups')) ? fs.readdirSync(path.join(pluginRoot, 'backups')) : []
  ok(backupFiles.length >= 1, '备份目录存在')
}

// 二：重复触发不再补扫
{
  const { cfg } = setupCase('live')
  const ctx = fakeCtx(() => JSON.stringify({ ops: [] }))
  const first = await runBackfill(ctx, cfg, {})
  const callsAfterFirst = ctx.calls
  const second = await runBackfill(ctx, cfg, {})
  ok(first.status === '成功无变更', '第一次无变更（实际 ' + first.status + ' / ' + JSON.stringify(first.errors) + '）')
  ok(second.status === '跳过', '第二次跳过（实际 ' + second.status + ' / ' + JSON.stringify(second.errors) + '）')
  ok(ctx.calls === callsAfterFirst, '第二次没有再调模型')
}

// 三：dry-run 不写文件
{
  const { cfg, archivePath, memoryPath } = setupCase('dry-run')
  const ctx = fakeCtx(() => JSON.stringify({ ops: [
    { target: 'archive', op: 'add', anchor: 'append', line: '- 干跑测试行', weight: 5, quote: 'U1', session: 'session-A', time: 't' },
  ] }))
  const result = await runBackfill(ctx, cfg, {})
  ok(result.status === '干跑（有变更）', '干跑状态（实际 ' + result.status + '）')
  ok(fs.readFileSync(archivePath, 'utf8') === ARCHIVE_ORIGINAL, '干跑不改档案')
  ok(!fs.existsSync(memoryPath), '干跑不创建记忆库')
}

console.log('backfill-test: ' + pass + ' pass, ' + fail + ' fail')
process.exit(fail === 0 ? 0 : 1)

