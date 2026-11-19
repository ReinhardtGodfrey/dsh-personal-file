/**
 * 设置页禁令审批：insertApprovedBans 写进规则文件的「明确禁令」节、decideBans 备份与删除待审条目。
 * 运行：node test/bans-approve-test.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)
const caseDir = path.join(here, '_tmp', 'bans-approve-case')
const dataDir = path.join(caseDir, 'data')
const backupsDir = path.join(caseDir, 'backups')

if (fs.existsSync(caseDir)) fs.rmSync(caseDir, { recursive: true, force: true })
fs.mkdirSync(dataDir, { recursive: true })
fs.mkdirSync(backupsDir, { recursive: true })

const { decideBans, insertApprovedBans, readBans } = await import(pathToFile(path.join(root, 'lib', 'bans.js')))

function pathToFile(p) {
  return 'file:///' + p.replace(/\\/g, '/')
}

let pass = 0
let fail = 0
function check(name, fn) {
  try {
    fn()
    pass += 1
  } catch (error) {
    fail += 1
    console.log('FAIL ' + name + '：' + (error && error.message ? error.message : error))
  }
}

const RULES = [
  '本文件是硬性规则。',
  '',
  '<!-- DSH-BAN-RULE v1 -->',
  '## 明确禁令（经审批）',
  '',
  '暂时没有经审批的禁令。',
  '新禁令先落 `data\\禁令待审.md`，审批通过后按 5 / 4 / 3 档追加到本节。',
  '',
  '<!-- DSH-WRITING-RULE v1 -->',
  '## 写作规则',
  '- 每段都要有具体信息。',
  '',
].join('\n')

const PENDING = [
  '# 禁令待审（等你审批）',
  '',
  '格式：- [档位] 禁令内容 ｜依据：原话 ｜会话：会话标识 ｜时间：消息时间',
  '',
  '- [5] 别在没打招呼的情况下装插件 ｜依据：以后别在没打招呼的情况下装插件 ｜会话：sess-a ｜时间：2026-11-19 10:00',
  '- [4] 发文件到群里之前先问 ｜依据：发文件到群里之前先问一声 ｜会话：sess-a ｜时间：2026-11-19 10:05',
  '',
].join('\n')

function writeFixture() {
  fs.writeFileSync(path.join(caseDir, 'AGENTS.md'), RULES, 'utf8')
  fs.writeFileSync(path.join(dataDir, '禁令待审.md'), PENDING, 'utf8')
}

writeFixture()

function cfg() {
  return {
    memoryPath: path.join(dataDir, '记忆库.md'),
    rulesPath: path.join(caseDir, 'AGENTS.md'),
    pluginRoot: caseDir,
  }
}

const firstBan = { banWeight: 5, line: '- 别在没打招呼的情况下装插件' }
const secondBan = { banWeight: 4, line: '发文件到群里之前先问' }

check('insertApprovedBans 删掉占位说明并写成一档一行', () => {
  const text = insertApprovedBans(RULES, [firstBan], '2026-11-19')
  assert.ok(!text.includes('暂时没有经审批的禁令'), '占位说明没删掉')
  assert.ok(!text.includes('新禁令先落'), '占位说明没删掉')
  assert.ok(text.includes('- [5] 2026-11-19：别在没打招呼的情况下装插件'), '没有写入带档位和日期的行')
  assert.ok(text.includes('<!-- DSH-WRITING-RULE v1 -->'), '后面的节丢了')
  const sectionIndex = text.indexOf('## 明确禁令（经审批）')
  const banIndex = text.indexOf('别在没打招呼的情况下装插件')
  const writingIndex = text.indexOf('## 写作规则')
  assert.ok(banIndex > sectionIndex && banIndex < writingIndex, '禁令插错位置')
})

check('insertApprovedBans 多条按传入顺序写、正文行首 - 被去掉', () => {
  const text = insertApprovedBans(RULES, [firstBan, secondBan], '2026-11-19')
  assert.ok(text.includes('- [4] 2026-11-19：发文件到群里之前先问'), '第二条没写对')
  assert.ok(!text.includes('- [- '), '正文里留了多余的 -')
})

check('insertApprovedBans 找不到节时报错', () => {
  assert.throws(() => insertApprovedBans('# 别的文件\n', [firstBan]), /找不到「明确禁令」节/)
})

check('decideBans 通过一条：写规则、备份、待审剩下另一条', () => {
  writeFixture()
  const result = decideBans(cfg(), { approve: ['别在没打招呼的情况下装插件'], stampName: 'test-stamp' })
  assert.equal(result.approved.length, 1)
  assert.ok(result.backupPath, '没有返回备份路径')
  assert.ok(fs.existsSync(result.backupPath), '备份文件不存在')
  const rules = fs.readFileSync(path.join(caseDir, 'AGENTS.md'), 'utf8')
  assert.ok(rules.includes('- [5] ') && rules.includes('别在没打招呼的情况下装插件'), '规则文件里没有这条')
  const bans = readBans(dataDir).entries
  assert.equal(bans.length, 1)
  assert.ok(bans[0].line.includes('发文件到群里之前先问'))
})

check('decideBans 驳回一条：不碰规则文件，待审也删掉', () => {
  writeFixture()
  const before = fs.readFileSync(path.join(caseDir, 'AGENTS.md'), 'utf8')
  const result = decideBans(cfg(), { reject: ['发文件到群里之前先问'], stampName: 'test-stamp' })
  assert.equal(result.rejected.length, 1)
  assert.equal(result.backupPath, null, '只驳回不该备份规则文件')
  assert.equal(fs.readFileSync(path.join(caseDir, 'AGENTS.md'), 'utf8'), before, '规则文件被改了')
  const bans = readBans(dataDir).entries
  assert.equal(bans.length, 1)
  assert.ok(bans[0].line.includes('别在没打招呼的情况下装插件'))
})

check('decideBans 两条都通过：规则里两档都在，待审清空', () => {
  writeFixture()
  const result = decideBans(cfg(), {
    approve: ['别在没打招呼的情况下装插件', '发文件到群里之前先问'],
    stampName: 'test-stamp',
  })
  assert.equal(result.approved.length, 2)
  const rules = fs.readFileSync(path.join(caseDir, 'AGENTS.md'), 'utf8')
  assert.ok(rules.includes('- [5] ') && rules.includes('- [4] '), '两档没都写进去')
  assert.equal(readBans(dataDir).entries.length, 0)
})

check('decideBans 匹配不到任何条目：什么都不改', () => {
  writeFixture()
  const before = fs.readFileSync(path.join(caseDir, 'AGENTS.md'), 'utf8')
  const result = decideBans(cfg(), { approve: ['这条不在清单里'] })
  assert.equal(result.approved.length, 0)
  assert.equal(result.backupPath, null)
  assert.equal(fs.readFileSync(path.join(caseDir, 'AGENTS.md'), 'utf8'), before)
  assert.equal(readBans(dataDir).entries.length, 2)
})

check('decideBans live=false 只返回决定、不写盘', () => {
  writeFixture()
  const before = fs.readFileSync(path.join(caseDir, 'AGENTS.md'), 'utf8')
  const result = decideBans(cfg(), { approve: ['别在没打招呼的情况下装插件'], live: false })
  assert.equal(result.approved.length, 1)
  assert.equal(result.backupPath, null)
  assert.equal(fs.readFileSync(path.join(caseDir, 'AGENTS.md'), 'utf8'), before)
  assert.equal(readBans(dataDir).entries.length, 2)
})

console.log(JSON.stringify({ pass, fail }))
if (fail) process.exitCode = 1

