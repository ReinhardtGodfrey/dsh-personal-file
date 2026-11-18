# 档案员（dsh-personal-file）

DSH 插件：从会话日志里只提取噗噗本人的原话，按权重维护人格档案与记忆库。写前备份，改动可回看。

- 仓库名 `dsh-personal-file`；插件包名仍是 `dsh-profile-keeper`（已装 bundle 保持原名，避免重装风险）。
- 档案：`C:\Users\Godfrey\.agents\AGENTS.md`（权重 5）
- 记忆库：`C:\Users\Godfrey\.agents\记忆库.md`（权重 3–4）；权重 ≤2 只留日志
- 不碰 `C:\Users\Godfrey\.dsh\AGENTS.md`
- 默认干跑；`data\mode.txt` 写 `live` 才实写
- 日志：`logs\YYYY-MM-DD.md`；变更摘要：`logs\最新变更.md`；备份：`backups\<时间戳>\`

实现细节见 [docs/DETAIL.md](docs/DETAIL.md)。
