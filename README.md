# 个人档案（dsh-personal-file）

DSH 插件。它自己读 DSH 的会话日志，挑出本人说过的、值得长期记住的话，按类别分档写进个人档案和记忆库。只写不读：档案每个会话自动加载，记忆库留在插件目录里备用，不注入对话。

- 插件包名：`dsh-profile-keeper`（安装标识，不要改）
- 人格档案：DSH 指令加载器指向的那份 `AGENTS.md`，默认 `~/.agents/AGENTS.md`，只收最高一档（identity/5 分）
- 记忆库：插件目录下 `data/记忆库.md`，收 detail(4) 与 minor(3)；更低档只留日志
- 默认干跑：`data/mode.txt` 写成 `live` 才开始真写

## 安装

1. 把整个目录放到 DSH 的插件目录，例如 `F:\dsh-plugins\个人档案`。
2. 编辑当前 profile 的 `package.json`（通常是 `~/.dsh/profiles/<名字>/package.json`）：
   - `dependencies` 里加一行：`"dsh-profile-keeper": "link:<插件绝对路径>"`（Windows 路径用正斜杠）
   - `dsh.profile.bundles` 数组末尾加 `"dsh-profile-keeper"`
3. 重启 DSH。插件会注册两个能力：`agent/turn-stopping` 钩子和每天一次的 13:00 定时任务。
4. 第一次启动是基线轮：只记下会话文件的当前长度，不写任何内容。
5. 想先看效果，就保持干跑：运行一轮后读 `logs/<日期>.md`，里面会列「本来会写什么」。确认没问题再写 `live` 到 `data/mode.txt`。

## 配置

配置写在插件注册项里（`cordis.patch.yml` 的 `config`），也可以直接改 profile 对应的条目：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `archivePath` | `~/.agents/AGENTS.md` | 档案路径，要和 DSH 指令加载器指向的同一份 |
| `memoryPath` | `data/记忆库.md` | 记忆库位置 |
| `dshHome` | `~/.dsh` 或环境变量 `DSH_HOME` | 找会话日志和 QQ 桥绑定文件 |
| `sessionsRoot` | `<dshHome>/sessions` | 会话日志根目录 |
| `ownQq` | 空 | 本人 QQ 号。留空则只认本机 `user` 通道，QQ 消息一律不写 |
| `runHour` | `13` | 每天几点做当日批处理（本地时间） |
| `keepBackups` | `60` | 写前备份保留多少份 |
| `maxTokens` | `8000` | 单次判断调用的输出上限 |
| `llm.provider` / `llm.model` / `llm.reasoningEffort` | 空 | 留空用宿主默认模型；要指定就填 |

## 它写什么、不写什么

- 来源：只读 `user/message` 事件。本机 `user` 通道直接算本人；`qq` 通道按 `qq-bridge-config.json`（含历史备份）里的绑定号码判定，只有号码等于 `ownQq` 才算本人；群消息从正文前缀 `昵称（QQ号）：` 取号码；判不出身份的一律丢弃。
- 分档按类别：identity=5、detail=4、minor=3、temp=2。落在边界上的新增会再问一次模型，两次取较低档，宁可少写。
- 每次写都需逐字核对的原话片段（quote）、会话与时间；核对不过的操作直接拒绝。
- 档案每批最多改 12 条、删 3 条、单行 200 字、总量 60000 字节；超了就不写。
- 档案或记忆库在运行中被外部改过（哈希不符）时，这一轮整体跳过。

## 数据与日志

| 内容 | 路径 |
| --- | --- |
| 每日修改日志（一次运行一段，按日期追加） | `logs/YYYY-MM-DD.md` |
| 最新变更摘要 | `logs/最新变更.md` |
| 每次运行的摘要留档（不自动清理） | `logs/变更历史/<日期>-<时分秒>.md` |
| 写前备份（档案与记忆库原文） | `backups/<时间戳>/` |
| 待确认条目 | `data/待确认.md` |
| 记忆库索引（哪天、哪个会话、哪句原话） | `data/memory-index.json` |
| 读取位置、上次运行结果 | `data/state.json`、`data/last-run.json` |

这些目录都在插件的 `.gitignore` 里，不会随仓库发布。

## 隐私

插件不联网，不上传任何内容。它只做三件事：读本机会话日志、写本机 `archivePath` 指定的那一份档案、写插件目录里的记忆库与日志。所有判断调用走 DSH 宿主已配置的模型。

## 测试

需要 Node 22+（自带 zstd）。在插件目录下：

```
node test/selftest.mjs
node test/pipeline-test.mjs
node test/backfill-test.mjs
node test/reclassify-test.mjs
```

后三个用临时目录造会话，不碰真实数据。`selftest.mjs` 会读本机 `$DSH_HOME/sessions` 做解码校验，没有会话目录时会报一条失败。

## 卸载与回滚

1. 从 profile 的 `dependencies` 删掉 `dsh-profile-keeper`，从 `dsh.profile.bundles` 删掉同名条目，重启 DSH。
2. 档案里由插件写进去的行，用 `backups/<时间戳>/` 里的原文回滚，或按 `logs/` 里的「旧行」手工还原。
3. 删插件目录前先把 `data/` 和 `backups/` 复制出去，记忆库只在那里。

实现细节见 [docs/DETAIL.md](docs/DETAIL.md)。
