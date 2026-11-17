import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

export function exists(file) {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/** 原子写：先写同目录临时文件再改名，避免半截文件。 */
export function atomicWrite(file, text) {
  ensureDir(path.dirname(file))
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now()
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}

export function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

export function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

export function localDate(ms = Date.now()) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

export function localTime(ms = Date.now()) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
}

/** 以本地时间生成备份目录名，例如 2026-11-17T13-00-05。 */
export function stamp(ms = Date.now()) {
  return localDate(ms) + 'T' + localTime(ms).replaceAll(':', '-')
}

/** 把文件复制进 backups/<stamp>/，返回目标路径；源不存在时返回 null。 */
export function backupFile(file, backupRoot, stampName = stamp()) {
  if (!exists(file)) return null
  const dir = path.join(backupRoot, stampName)
  ensureDir(dir)
  const dest = path.join(dir, path.basename(file))
  fs.copyFileSync(file, dest)
  return dest
}

/** 只保留最近 keep 份备份目录。 */
export function pruneBackups(backupRoot, keep) {
  let entries = []
  try {
    entries = fs.readdirSync(backupRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return 0
  }
  entries.sort()
  const extra = entries.slice(0, Math.max(0, entries.length - keep))
  for (const name of extra) {
    try {
      fs.rmSync(path.join(backupRoot, name), { recursive: true, force: true })
    } catch {
      // 清理失败不影响主流程
    }
  }
  return extra.length
}

/** 追加当天的运行日志（一天一个文件）。 */
export function appendDailyLog(logDir, text) {
  ensureDir(logDir)
  const file = path.join(logDir, localDate() + '.md')
  fs.appendFileSync(file, text, 'utf8')
  return file
}

/** 读目录里的文件名（不存在时返回空数组）。 */
export function listFiles(dir) {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}
