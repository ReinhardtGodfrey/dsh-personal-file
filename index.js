import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runOnce } from './lib/pipeline.js'
import { runBackfill } from './lib/backfill.js'
import { runReclassify } from './lib/reclassify.js'
import { exists, readText } from './lib/store.js'

const pluginRoot = path.dirname(fileURLToPath(import.meta.url))
const LOG_PREFIX = '[个人档案]'

const home = os.homedir()
const dshHome = process.env.DSH_HOME || path.join(home, '.dsh')

const DEFAULTS = {
  // 个人档案默认放在 ~/.agents/AGENTS.md；如果 DSH 的指令加载器指向别处，在这里改。
  archivePath: path.join(home, '.agents', 'AGENTS.md'),
  memoryPath: path.join(pluginRoot, 'data', '记忆库.md'),
  dshHome,
  sessionsRoot: path.join(dshHome, 'sessions'),
  // 每天几点做当日批处理（本地时间，0-23）
  runHour: 13,
  keepBackups: 60,
  maxTokens: 8000,
  // 本人 QQ 号：留空则只认本机 user 通道，QQ 消息一律不算
  ownQq: '',
  // 模型：留空就用宿主当前默认模型；要指定就填 provider/model
  llm: {},
}

export const inject = ['timer', 'llm']

export function apply(ctx, config = {}) {
  const cfg = resolveConfig(config)
  const runtime = { running: false, lastFailAt: 0 }

  const run = async (trigger) => {
    if (runtime.running) return
    if (runtime.lastFailAt && Date.now() - runtime.lastFailAt < 5 * 60 * 1000) return
    runtime.running = true
    try {
      const result = await runOnce(ctx, cfg, { trigger })
      runtime.lastFailAt = result.status === '失败' ? Date.now() : 0
      console.info(
        LOG_PREFIX + ' ' + trigger + ' 完成：' + result.status +
          '（' + result.sessions + ' 会话 / ' + result.messages + ' 条消息）',
      )
    } catch (error) {
      runtime.lastFailAt = Date.now()
      console.error(LOG_PREFIX + ' 运行异常：' + (error && error.message ? error.message : String(error)))
    } finally {
      runtime.running = false
    }
  }

  // 历史补扫：data/backfill.request 存在时跑一次。请求文件由人工放置，
  // 成功后连同 .running 标记一起清掉；出错则留下 .failed，避免每分钟重跑烧模型。
  const maybeBackfill = async () => {
    if (runtime.running) return false
    const request = path.join(pluginRoot, 'data', 'backfill.request')
    if (!exists(request)) return false
    runtime.running = true
    const taken = request + '.running'
    try {
      fs.renameSync(request, taken)
    } catch {
      runtime.running = false
      return false
    }
    try {
      const result = await runBackfill(ctx, cfg, { trigger: 'backfill' })
      console.info(
        LOG_PREFIX + ' 历史补扫完成：' + result.status +
          '（' + result.messages + ' 条消息 / ' + result.chunks + ' 批 / 新增 ' + result.added.length +
          ' / 修改 ' + result.replaced.length + ' / 删除 ' + result.deleted.length + '）',
      )
      try {
        fs.rmSync(taken, { force: true })
      } catch {
        // 标记清不掉不影响后面
      }
    } catch (error) {
      console.error(LOG_PREFIX + ' 历史补扫异常：' + (error && error.message ? error.message : String(error)))
      try {
        fs.renameSync(taken, path.join(pluginRoot, 'data', 'backfill.request.failed'))
      } catch {
        // 标记改不动就留着，下次人工处理
      }
    } finally {
      runtime.running = false
    }
    return true
  }

  // 重新归类：data/reclassify.request 存在时按插件自己的权重标准重排档案。
  // 同样用请求文件触发，成功后清掉标记，失败留下 .failed 避免每分钟重跑。
  const maybeReclassify = async () => {
    if (runtime.running) return false
    const request = path.join(pluginRoot, 'data', 'reclassify.request')
    if (!exists(request)) return false
    runtime.running = true
    const taken = request + '.running'
    try {
      fs.renameSync(request, taken)
    } catch {
      runtime.running = false
      return false
    }
    try {
      const result = await runReclassify(ctx, cfg, { trigger: 'reclassify' })
      console.info(
        LOG_PREFIX + ' 重新归类完成：' + result.status +
          '（保留 ' + result.kept + ' / 迁出 ' + result.moved + ' / 删除 ' + result.dropped + '）',
      )
      try {
        fs.rmSync(taken, { force: true })
      } catch {
        // 标记清不掉不影响后面
      }
    } catch (error) {
      console.error(LOG_PREFIX + ' 重新归类异常：' + (error && error.message ? error.message : String(error)))
      try {
        fs.writeFileSync(
          path.join(pluginRoot, 'data', 'reclassify.error.txt'),
          String((error && error.message) || error) + '\n',
          'utf8',
        )
      } catch {
        // 诊断文本写不下就跳过
      }
      try {
        fs.renameSync(taken, path.join(pluginRoot, 'data', 'reclassify.request.failed'))
      } catch {
        // 改不动就留着，下次人工处理
      }
    } finally {
      runtime.running = false
    }
    return true
  }

  const recoverStaleReclassify = () => {
    const request = path.join(pluginRoot, 'data', 'reclassify.request')
    const running = request + '.running'
    if (!exists(running) || exists(request)) return
    let ageMs = 0
    try {
      ageMs = Date.now() - fs.statSync(running).mtimeMs
    } catch {
      return
    }
    if (ageMs < 30 * 60 * 1000) return
    try {
      fs.renameSync(running, request)
    } catch {
      // 改不动就保持原样
    }
  }

  // 上一次进程如果在补扫中途退出/挂死，会留下 .running 标记和过期锁；
  // 下次加载时把它名字改回来，补扫就能重跑（补扫只在最后一次性写入，重跑安全）。
  const recoverStaleBackfill = () => {
    const request = path.join(pluginRoot, 'data', 'backfill.request')
    const running = request + '.running'
    if (!exists(running) || exists(request)) return
    let lockedAt = 0
    try {
      const lockPath = path.join(pluginRoot, 'data', 'lock.json')
      if (exists(lockPath)) lockedAt = Number(JSON.parse(readText(lockPath)).lockedAt) || 0
    } catch {
      lockedAt = 0
    }
    if (lockedAt && Date.now() - lockedAt < 30 * 60 * 1000) return
    try {
      fs.renameSync(running, request)
    } catch {
      // 改不动就保持原样，下次再看
    }
  }
  recoverStaleBackfill()
  recoverStaleReclassify()

  // 启动即补跑一次；日常靠每分钟检查 13:00
  // 延迟 20 秒，等宿主的 llm 凭据/提供方都注册完再跑；太早会报 no credential
  setTimeout(async () => {
    await run('startup')
    await maybeBackfill()
    await maybeReclassify()
  }, 20 * 1000)

  ctx.effect(() => {
    const timer = ctx.timer
    if (!timer || typeof timer.interval !== 'function') {
      console.error(LOG_PREFIX + ' 没有 timer 服务，日常 13:00 调度不可用')
      return () => {}
    }
    return timer.interval(() => {
      try {
        if (exists(path.join(pluginRoot, 'data', 'reclassify.request'))) {
          maybeReclassify()
          return
        }
        if (exists(path.join(pluginRoot, 'data', 'backfill.request'))) {
          maybeBackfill()
          return
        }
        const now = Date.now()
        const due = todayAtHour(now, cfg.runHour)
        const state = readStateForCheck(cfg)
        // 当天失败过就每 5 分钟重试一次，直到成功
        if (
          state.lastRunStatus === '失败' &&
          Number(state.lastAttemptAt) > 0 &&
          localDay(Number(state.lastAttemptAt)) === localDay(now)
        ) {
          run('retry')
          return
        }
        if (now < due) return
        if (state.lastRunAt && Number(state.lastRunAt) >= due) return
        run('daily')
      } catch (error) {
        console.error(LOG_PREFIX + ' 调度检查失败：' + (error && error.message ? error.message : String(error)))
      }
    }, 60 * 1000)
  })
}

/** data/config.json 是本地覆盖配置：不进仓库，用来填这个人的档案路径、QQ 号、模型等。 */
function readLocalConfig() {
  const file = path.join(pluginRoot, 'data', 'config.json')
  try {
    const text = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function resolveConfig(config) {
  const cfg = {}
  for (const [key, value] of Object.entries(DEFAULTS)) cfg[key] = value
  const layers = [readLocalConfig(), config || {}]
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer)) {
      if (value === undefined || value === null) continue
      if (key === 'llm' && typeof value === 'object') {
        cfg.llm = { ...cfg.llm, ...value }
      } else {
        cfg[key] = value
      }
    }
  }
  cfg.pluginRoot = pluginRoot
  return cfg
}

function todayAtHour(now, hour) {
  const d = new Date(now)
  d.setHours(hour, 0, 0, 0)
  return d.getTime()
}

function localDay(ms) {
  const d = new Date(ms)
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()
}

function readStateForCheck(cfg) {
  const file = path.join(cfg.pluginRoot, 'data', 'state.json')
  const text = readText(file)
  if (!text) return {}
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}
