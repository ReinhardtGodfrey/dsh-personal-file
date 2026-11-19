import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { runRegroup } from '../lib/regroup.js'

const sha = (t) => createHash('sha256').update(t, 'utf8').digest('hex')
let pass = 0
let fail = 0
function check(name, cond) {
  if (cond) { pass += 1; console.log('PASS ' + name) }
  else { fail += 1; console.log('FAIL ' + name) }
}
function fakeCtx(payload) {
  return {
    llm: {
      async *stream() {
        yield { type: 'text-delta', index: 0, text: '```json\n' + JSON.stringify(payload) + '\n```' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }
}

const root = path.join(os.tmpdir(), 'regroup-test-' + process.pid)
const pluginRoot = path.join(root, 'plugin')
const dataDir = path.join(pluginRoot, 'data')
const logDir = path.join(pluginRoot, 'logs')
const backupRoot = path.join(pluginRoot, 'backups')
fs.mkdirSync(dataDir, { recursive: true })

const archivePath = path.join(root, 'AGENTS.md')
const memoryPath = path.join(root, '记忆库.md')
const archiveText = '本文件是测试用户的个人档案。\n\n## 关于我\n\n- 身份：大一\n'
const memoryText = [
  '# 记忆库（次要信息）',
  '',
  '## 自动记录',
  '- 新加了一个「图生图」工作流',
  '- 2026-10-24 在研究 GitHub 项目 IdentityV',
  '2026-10-27 把插件装到 F 盘的插件目录',
  '- 物理课上的是「医用物理学」，讲到黏性流体',
  '- 想给助手做工程化分层，分深层和浅层记忆',
  '',
  '## 旧迁出批（2026-11-18）',
  '- 2026-11-01 从档案迁出的旧条目',
  '',
  '## 主题：设备',
  '- 2026-11-18：装了 dsh-qq-bridge 接 QQ 机器人',
  '',
].join('\n')
fs.writeFileSync(archivePath, archiveText)
fs.writeFileSync(memoryPath, memoryText)
fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ archiveHash: sha(archiveText), memoryHash: sha(memoryText) }, null, 2))
fs.writeFileSync(path.join(dataDir, 'memory-index.json'), JSON.stringify({ entries: [
  { date: '2026-11-18', topic: '设备', kind: 'detail', line: '- 2026-11-18：装了 dsh-qq-bridge 接 QQ 机器人', quote: '', session: 's1', time: '' },
] }, null, 2))

const payload = { items: [
  { i: 1, topic: '生图', kind: 'detail', date: '' },
  { i: 2, topic: '设备', kind: 'detail', date: '2026-10-24' },
  { i: 3, topic: '设备', kind: 'detail', date: '2026-10-27' },
  { i: 4, topic: '学习', kind: 'minor', date: '' },
  { i: 5, topic: 'AI', kind: 'detail', date: '' },
  { i: 6, topic: '设备', kind: 'detail', date: '2026-11-01' },
] }

const cfg = { archivePath, memoryPath, dataDir, logDir, backupRoot, keepBackups: 60, llm: { provider: 'test', model: 'test' } }
const result = await runRegroup(fakeCtx(payload), cfg)
check('status 成功', result.status === '成功')
check('total=6（含无「- 」行首与非主题节的旧条目）', result.total === 6)
check('dated=3', result.dated === 3)
check('undated=3', result.undated === 3)
check('topics=4', result.topics === 4)
check('keptTopics=1', result.keptTopics === 1)

const memoryAfter = fs.readFileSync(memoryPath, 'utf8')
check('自动记录与旧迁出节已移除', !memoryAfter.includes('## 自动记录') && !memoryAfter.includes('## 旧迁出批'))
check('生图主题节', memoryAfter.includes('## 主题：生图'))
check('学习主题节', memoryAfter.includes('## 主题：学习'))
check('原设备节保留并合入', memoryAfter.includes('## 主题：设备') && memoryAfter.includes('- 2026-10-24：在研究 GitHub 项目 IdentityV'))
check('内联日期移到前缀', !memoryAfter.includes('- 2026-10-24 在研究') && memoryAfter.includes('- 2026-10-24：在研究'))
check('无日期条目不带假日期', memoryAfter.includes('- 新加了一个「图生图」工作流'))
check('无「- 」行首的旧条目补成规范条目', memoryAfter.includes('- 2026-10-27：把插件装到 F 盘的插件目录'))
check('原主题条目仍在', memoryAfter.includes('- 2026-11-18：装了 dsh-qq-bridge 接 QQ 机器人'))
check('原节里的条目不丢', memoryAfter.includes('医用物理学') && memoryAfter.includes('工程化分层'))
check('前言保留', memoryAfter.startsWith('# 记忆库（次要信息）'))
check('单尾换行', memoryAfter.endsWith('\n') && !memoryAfter.endsWith('\n\n'))

const indexAfter = JSON.parse(fs.readFileSync(path.join(dataDir, 'memory-index.json'), 'utf8'))
check('索引条数=1+6', indexAfter.entries.length === 7)
check('索引记 legacy 来源', indexAfter.entries.filter((e) => e.session === 'legacy').length === 6)
check('索引带主题', indexAfter.entries.some((e) => e.session === 'legacy' && e.topic === '学习' && e.kind === 'minor'))

const allTexts = ['图生图', 'IdentityV', '把插件装到 F 盘的插件目录', '医用物理学', '工程化分层', '从档案迁出的旧条目']
check('全部旧条目文本都在（无丢失）', allTexts.every((t) => memoryAfter.includes(t)))

const backups = fs.readdirSync(backupRoot)
check('备份目录存在', backups.length === 1)
const backupDir = path.join(backupRoot, backups[0])
check('备份记忆库是写前版', fs.readFileSync(path.join(backupDir, '记忆库.md'), 'utf8') === memoryText)
check('备份索引存在', fs.existsSync(path.join(backupDir, 'memory-index.json')))

const stateAfter = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'))
check('state 记忆库哈希更新', stateAfter.memoryHash === sha(memoryAfter))
check('state 档案哈希不变', stateAfter.archiveHash === sha(archiveText))
check('regroupedAt 已记', typeof stateAfter.regroupedAt === 'number')

check('日志已写', fs.readdirSync(logDir).some((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)))
check('最新变更已写', fs.existsSync(path.join(logDir, '最新变更.md')))
check('结果文件已写', fs.existsSync(path.join(dataDir, 'regroup-result.json')))
check('归档后档案未动', fs.readFileSync(archivePath, 'utf8') === archiveText)

// 外部改动保护：改了记忆库但没更新哈希就该拒绝
fs.writeFileSync(memoryPath, memoryAfter + '- 手改一行\n')
const cfg2 = { ...cfg }
let rejected = false
try {
  await runRegroup(fakeCtx(payload), cfg2)
} catch (error) {
  rejected = /外部修改/.test(String(error && error.message))
}
check('外部改动被拒绝', rejected)

fs.rmSync(root, { recursive: true, force: true })
console.log(`regroup-test: ${pass} pass, ${fail} fail`)
process.exit(fail === 0 ? 0 : 1)
