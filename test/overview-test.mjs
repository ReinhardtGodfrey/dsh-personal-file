import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildOverview } from '../lib/overview.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-overview-'))
const dataDir = path.join(tmp, 'data')
fs.mkdirSync(dataDir, { recursive: true })
const archivePath = path.join(tmp, 'AGENTS.md')
const memoryPath = path.join(dataDir, '记忆库.md')

fs.writeFileSync(
  archivePath,
  '# 个人档案\n\n## 身份与关系\n- 身份：上海健康医学院大一\n\n### 学业\n- 作息：白天上课\n',
  'utf8',
)
fs.writeFileSync(
  memoryPath,
  '# 记忆库（次要信息）\n\n## 主题：工具\n- 2026-11-18：装了 anatomy 技能并挂上\n- 2026-11-17：想把插件公开到 GitHub\n\n## 自动记录\n- 老条目，没有日期\n',
  'utf8',
)
fs.writeFileSync(
  path.join(dataDir, 'memory-index.json'),
  JSON.stringify({
    entries: [
      { date: '2026-11-18', topic: '工具', kind: 'detail', line: '- 2026-11-18：装了 anatomy 技能并挂上', quote: '下载进去然后挂上', session: 's1', time: '2026-11-18 17:29:00' },
      { date: '2026-11-17', topic: '工具', kind: 'identity', line: '- 2026-11-17：想把插件公开到 GitHub', quote: '我想公开这个插件', session: 's2', time: '' },
      { date: '', topic: '', kind: 'minor', line: '- 老条目，没有日期', quote: '随口一句', session: 's3', time: '' },
    ],
  }) + '\n',
  'utf8',
)
fs.writeFileSync(path.join(dataDir, '待确认.md'), '# 待确认\n\n- 一件事｜依据\n- 另一件事｜依据\n', 'utf8')
fs.writeFileSync(
  path.join(dataDir, 'last-run.json'),
  JSON.stringify({ status: '成功', startedAt: 1795011936703, messages: 55, sessions: 8 }) + '\n',
  'utf8',
)

const overview = buildOverview({ archivePath, memoryPath }, { now: 1795012200000 })

assert.equal(overview.ok, true)
assert.equal(overview.archive.count, 2)
assert.equal(overview.archive.sections.length, 2)
assert.equal(overview.archive.sections[0].title, '身份与关系')
assert.equal(overview.archive.sections[1].title, '学业')
assert.equal(overview.memory.total, 3)
assert.equal(overview.memory.counts[5], 1)
assert.equal(overview.memory.counts[4], 1)
assert.equal(overview.memory.counts[3], 1)
assert.equal(overview.memory.topics.length, 2)
assert.equal(overview.memory.topics[0].name, '工具')
assert.equal(overview.memory.topics[0].items.length, 2)
assert.equal(overview.memory.topics[0].items[0].date, '2026-11-18')
assert.equal(overview.memory.topics[0].items[0].weight, 4)
assert.equal(overview.memory.topics[0].items[0].text, '装了 anatomy 技能并挂上')
assert.equal(overview.memory.topics[0].items[0].quote, '下载进去然后挂上')
assert.equal(overview.memory.topics[0].items[1].weight, 5)
assert.equal(overview.memory.topics[1].name, '自动记录')
assert.equal(overview.memory.topics[1].items[0].weight, 3)
assert.equal(overview.pending.count, 2)
assert.equal(overview.lastRun.status, '成功')
assert.equal(overview.lastRun.messages, 55)
assert.match(overview.generatedAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)

fs.rmSync(tmp, { recursive: true, force: true })
console.log('overview-test: 23 pass, 0 fail')
