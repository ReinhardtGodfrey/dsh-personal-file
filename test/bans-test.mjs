/**
 * 禁令待审：validateOps 的 ban 分支 + bans.js 的落盘、去重、审批删除。
 * 运行：node test/bans-test.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)
const caseDir = path.join(here, '_tmp', 'bans-case')
const dataDir = path.join(caseDir, 'data')

if (fs.existsSync(caseDir)) fs.rmSync(caseDir, { recursive: true, force: true })
fs.mkdirSync(dataDir, { recursive: true })

const { validateOps, buildPrompt } = await import(pathToFile(path.join(root, 'lib', 'ops.js')))
const { appendBans, readBans, promoteBans, bansPrompt, formatBan } = await import(pathToFile(path.join(root, 'lib', 'bans.js')))

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

const messages = [
  { text: '以后别在没打招呼的情况下装插件，先问我', session: 'sess-a', timeText: '2026-11-19 10:00', source: 'user' },
  { text: '隐私的东西不要发到群里', session: 'sess-a', timeText: '2026-11-19 10:01', source: 'user' },
]

const archive = '# 个人档案\n\n## 关于我\n- 身份：学生\n'
const memory = '# 记忆库\n\n## 主题：插件\n- 2026-11-18：插件装在 F 盘\n'

check('ban add 进 bans，不进档案和记忆库', () => {
  const out = validateOps(
    [{ target: 'ban', op: 'add', banWeight: 5, line: '- 别在没打招呼的情况下装插件', quote: '以后别在没打招呼的情况下装插件', session: 'sess-a', time: '2026-11-19 10:00' }],
    { archive, memory, messages },
  )
  assert.equal(out.bans.length, 1)
  assert.equal(out.bans[0].banWeight, 5)
  assert.equal(out.archive.length, 0)
  assert.equal(out.memory.length, 0)
  assert.equal(out.rejected.length, 0)
})

check('ban 缺 banWeight 默认 4', () => {
  const out = validateOps(
    [{ target: 'ban', op: 'add', line: '- 隐私的东西别发群里', quote: '隐私的东西不要发到群里', session: 'sess-a', time: '2026-11-19 10:01' }],
    { archive, memory, messages },
  )
  assert.equal(out.bans[0].banWeight, 4)
})

check('ban 档位夹在 1–5', () => {
  const out = validateOps(
    [{ target: 'ban', op: 'add', banWeight: 9, line: '- 隐私的东西别发群里', quote: '隐私的东西不要发到群里', session: 'sess-a', time: '2026-11-19 10:01' }],
    { archive, memory, messages },
  )
  assert.equal(out.bans[0].banWeight, 5)
})

check('quote 对不上的 ban 被拒', () => {
  const out = validateOps(
    [{ target: 'ban', op: 'add', banWeight: 5, line: '- 虚构的禁令', quote: '这句话不在消息里', session: 'sess-a', time: '2026-11-19 10:00' }],
    { archive, memory, messages },
  )
  assert.equal(out.bans.length, 0)
  assert.equal(out.rejected.length, 1)
})

check('ban 只接受 add', () => {
  const out = validateOps(
    [{ target: 'ban', op: 'replace', old: '- 旧禁令', line: '- 新禁令', quote: '以后别在没打招呼的情况下装插件', session: 'sess-a', time: '2026-11-19 10:00' }],
    { archive, memory, messages },
  )
  assert.equal(out.bans.length, 0)
  assert.equal(out.rejected.length, 1)
})

check('ban 的 line 不能为空', () => {
  const out = validateOps(
    [{ target: 'ban', op: 'add', banWeight: 5, line: '  ', quote: '以后别在没打招呼的情况下装插件', session: 'sess-a', time: '2026-11-19 10:00' }],
    { archive, memory, messages },
  )
  assert.equal(out.bans.length, 0)
})

check('appendBans 首次写入建文件并带头', () => {
  const res = appendBans(dataDir, [{ banWeight: 5, line: '- 别在没打招呼的情况下装插件', quote: '以后别在没打招呼的情况下装插件', session: 'sess-a', time: '2026-11-19 10:00' }], true)
  assert.equal(res.added.length, 1)
  const { text, entries } = readBans(dataDir)
  assert.match(text, /^# 禁令待审/)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].banWeight, 5)
  assert.equal(entries[0].session, 'sess-a')
})

check('appendBans 同一条重复不重复写', () => {
  const res = appendBans(dataDir, [{ banWeight: 5, line: '- 别在没打招呼的情况下装插件', quote: '以后别在没打招呼的情况下装插件', session: 'sess-a', time: '2026-11-19 10:02' }], true)
  assert.equal(res.added.length, 0)
  assert.equal(res.skipped, 1)
  assert.equal(readBans(dataDir).entries.length, 1)
})

check('appendBans 近似但不同的话照收', () => {
  const res = appendBans(dataDir, [{ banWeight: 5, line: '- 隐私的东西别发群里 ', quote: '隐私的东西不要发到群里', session: 'sess-a', time: '2026-11-19 10:01' }], true)
  assert.equal(res.added.length, 1)
  assert.equal(readBans(dataDir).entries.length, 2)
})

check('formatBan 带档位与依据', () => {
  const line = formatBan({ banWeight: 3, line: '- 尽量别熬夜', quote: '别熬太晚', session: 'sess-b', time: '2026-11-19 10:03' })
  assert.match(line, /^- \[3\] - 尽量别熬夜 ｜依据：别熬太晚 ｜会话：sess-b ｜时间：2026-11-19 10:03$/)
})

check('bansPrompt 给提示词用', () => {
  const text = bansPrompt(dataDir)
  assert.match(text, /\[5\]/)
})

check('promoteBans 删掉审批通过的那条', () => {
  const removed = promoteBans(dataDir, ['- 别在没打招呼的情况下装插件'], true)
  assert.equal(removed, 1)
  const { entries } = readBans(dataDir)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].line, '- 隐私的东西别发群里')
})

check('提示词含禁令档位与待审段落', () => {
  const prompt = buildPrompt({ archive, memory, messages, bans: ['- [5] 别在没打招呼的情况下装插件'] })
  assert.match(prompt, /【禁令待审】/)
  assert.match(prompt, /banWeight = 5/)
  assert.match(prompt, /规则类内容（插件用法、工具流程、路径、记账规则）/)
})

fs.rmSync(caseDir, { recursive: true, force: true })

console.log('bans-test: ' + pass + ' pass, ' + fail + ' fail')
if (fail > 0) process.exitCode = 1
