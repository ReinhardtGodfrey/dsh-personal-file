import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { runReclassify } from '../lib/reclassify.js'

const sha = (t) => createHash('sha256').update(t, 'utf8').digest('hex')
let pass = 0
let fail = 0
function check(name, cond) {
  if (cond) { pass += 1; console.log('PASS ' + name) }
  else { fail += 1; console.log('FAIL ' + name) }
}
function fakeCtx(scores) {
  return {
    llm: {
      async *stream() {
        yield { type: 'text-delta', index: 0, text: '```json\n' + JSON.stringify(scores) + '\n```' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }
}

const root = path.join(os.tmpdir(), 'reclassify-test-' + process.pid)
const pluginRoot = path.join(root, 'plugin')
const dataDir = path.join(pluginRoot, 'data')
const logDir = path.join(pluginRoot, 'logs')
const backupRoot = path.join(pluginRoot, 'backups')
fs.mkdirSync(dataDir, { recursive: true })
fs.mkdirSync(logDir, { recursive: true })

const archivePath = path.join(root, 'AGENTS.md')
const memoryPath = path.join(root, '记忆库.md')
const archiveText = [
  '本文件是测试用户的个人档案。',
  '',
  '## 关于我',
  '',
  '### 身份与关系',
  '- 身份：大一临床工程技术专业',
  '- 朋友：小明（QQ 123456789）',
  '',
  '### 项目：PPT',
  '- 改稿要逐条列页码、改前原句、改后新句',
  '- 用 PowerPoint 2024 手动改',
  '',
].join('\n')
const memoryText = '# 记忆库（次要信息）\n\n## 自动记录\n- 已有条目\n'
fs.writeFileSync(archivePath, archiveText)
fs.writeFileSync(memoryPath, memoryText)

const state = { archiveHash: sha(archiveText), memoryHash: sha(memoryText), installedAt: 1 }
fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify(state, null, 2))

const cfg = {
  archivePath,
  memoryPath,
  pluginRoot,
  keepBackups: 60,
  llm: { provider: 'test', model: 'test' },
}
const ctx = fakeCtx({ scores: [
  { index: 1, weight: 5 },
  { index: 2, weight: 4 },
  { index: 3, weight: 3 },
  { index: 4, weight: 2 },
] })

const result = await runReclassify(ctx, cfg)
check('status 成功', result.status === '成功')
check('total=4', result.total === 4)
check('kept=1', result.kept === 1)
check('moved=2', result.moved === 2)
check('dropped=1', result.dropped === 1)

const archiveAfter = fs.readFileSync(archivePath, 'utf8')
check('身份保留', archiveAfter.includes('- 身份：大一临床工程技术专业'))
check('朋友迁出', !archiveAfter.includes('小明'))
check('改稿迁出', !archiveAfter.includes('改稿要逐条列'))
check('手动改删除', !archiveAfter.includes('PowerPoint 2024'))
check('空节不剩', !archiveAfter.includes('### 项目：PPT'))
check('前言仍在', archiveAfter.includes('本文件是测试用户的个人档案。'))
check('单尾换行', archiveAfter.endsWith('\n') && !archiveAfter.endsWith('\n\n'))

const memoryAfter = fs.readFileSync(memoryPath, 'utf8')
check('记忆库含朋友', memoryAfter.includes('小明'))
check('记忆库含改稿', memoryAfter.includes('改稿要逐条列'))
check('记忆库不含删除项', !memoryAfter.includes('PowerPoint 2024'))
check('迁出节标题', memoryAfter.includes('## 档案重新归类迁出（'))

const backups = fs.readdirSync(backupRoot)
check('备份目录存在', backups.length === 1)
const backupDir = path.join(backupRoot, backups[0])
check('备份档案是写前版', fs.readFileSync(path.join(backupDir, 'AGENTS.md'), 'utf8') === archiveText)
check('备份记忆库是写前版', fs.readFileSync(path.join(backupDir, '记忆库.md'), 'utf8') === memoryText)

const stateAfter = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'))
check('state 档案哈希更新', stateAfter.archiveHash === sha(archiveAfter))
check('state 记忆库哈希更新', stateAfter.memoryHash === sha(memoryAfter))
check('state reclassifiedAt 有值', Number(stateAfter.reclassifiedAt) > 0)

const resultJson = JSON.parse(fs.readFileSync(path.join(dataDir, 'reclassify-result.json'), 'utf8'))
check('结果文件 4 条', resultJson.items.length === 4)
check('结果文件含 action', resultJson.items.map((i) => i.action).join(',') === 'keep,move,move,drop')

const daily = fs.readdirSync(logDir).filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n))
check('日档只有一份', daily.length === 1)
check('日志含重新归类', fs.readFileSync(path.join(logDir, daily[0]), 'utf8').includes('重新归类'))
check('摘要含迁入', fs.readFileSync(path.join(logDir, '最新变更.md'), 'utf8').includes('迁入记忆库'))

// 外部改动保护
fs.appendFileSync(archivePath, '- 外部新增一行\n')
try {
  await runReclassify(ctx, cfg)
  check('外部改动应当抛错', false)
} catch (error) {
  check('外部改动被拒绝', String(error.message).includes('外部改动'))
}

console.log(JSON.stringify({ pass, fail }))
process.exit(fail === 0 ? 0 : 1)
