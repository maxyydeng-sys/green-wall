# Green Wall · 自动刷库系统

每天自动生成一份仓库运行记录并提交到默认分支。提供初始化、健康检查、运行、状态查询、失败补推和 GitHub Actions 定时调度，零第三方依赖，Node >= 20。

默认每天生成一份记录；同日重复运行不重复提交。所有自动提交保留 `[auto]` 标记，回填日期明确标注。

## 当前配置

- GitHub 账号：`maxyydeng-sys`
- 提交邮箱：`maxyydeng@gmail.com`（用户提供，需在 GitHub Settings → Emails 中确认已验证）
- 时区：`Asia/Shanghai`
- 计划调度：北京时间 **11:17 / 15:17**；第二次为幂等容错
- 当前项目路径：`/Users/yyd/Documents/ChatGPT/11 _ 自动刷仓`

本地配置就绪不代表线上已启用。必须把项目推到实际 GitHub 仓库默认分支，并在 Actions 中完成一次演练及真实运行验收。

## 快速使用

本机可直接使用 `./green-wall`。若 Node 不在 PATH，启动器会尝试本机 Codex 提供的 Node；其他电脑可安装 Node >= 20 后运行 `node scripts/green-wall.mjs`，命令等价。

```sh
./green-wall --help
./green-wall status
./green-wall doctor --network
./green-wall run --dry-run
./green-wall run --no-push
./green-wall run
./green-wall test
./green-wall test --network
```

本项目已经配置好账号和邮箱。新建其他仓库时初始化一次：

```sh
node scripts/green-wall.mjs init \
  --author-name YOUR_GITHUB_LOGIN \
  --author-email YOUR_VERIFIED_EMAIL \
  --actor YOUR_GITHUB_LOGIN \
  --repo OWNER/REPO
```

`init` 创建配置和运行目录忽略规则，可选添加 origin；不会覆盖已有配置或远端，不提交、不推送。完成后先提交项目文件。`doctor` 检查首次提交、工作区、邮箱、分支、origin 和运行锁；`--network` 额外检查远端读取能力，不能证明写权限或邮箱归属。

## 接入 GitHub

1. 在自己的账号下创建一个独立的普通仓库，建议名为 `green-wall`。仓库应为空，避免同时生成另一份 README。私有或公开可自行选择；请确认提交邮箱会进入提交历史。
2. 将当前项目提交并推送至仓库默认分支（示例使用 main）：

   ```sh
   git remote add origin https://github.com/OWNER/REPO.git
   git push -u origin main
   git remote set-head origin -a
   ```

   如果已经配置 origin，不重复添加。GitHub 登录由 git 凭据管理器或 GitHub CLI 处理，勿把 token 写入配置或远端 URL。
3. 仓库的 Actions 页面允许工作流运行。项目工作流请求 `contents: write`；组织策略或分支保护仍可能阻止直接推送，需要仓库管理员配置。
4. **Actions → auto-commit → Run workflow**，选择默认分支，先保留 `dry_run=true` 演练。
5. 再取消 dry_run 实际执行，核对提交作者、日期、文件和运行摘要；确认推送成功后定时调度即可工作。本地电脑不必一直开机。

共享模板时，修改 `green-wall.config.json` 为自己的身份，也可设置仓库 Actions Variables：`GIT_AUTHOR_EMAIL` 和 `GIT_AUTHOR_NAME`，它们优先于配置文件。配置不允许保存任何 token 或密钥。

GitHub 贡献统计还取决于邮箱关联、默认分支及仓库类型；私有贡献是否显示取决于个人主页设置。请以提交页面实际归属为准，不承诺执行成功即一定显示贡献。

## 配置与暂停

`green-wall.config.json` 是唯一的业务配置；`.codex/config.toml` 仅供开发工具使用。

| 字段 | 作用 |
| --- | --- |
| `version` | 配置版本，目前为 1 |
| `enabled` | false 时暂停生成和推送，手动和定时均适用 |
| `timezone` | 日期时区，默认 Asia/Shanghai |
| `dataDir` | 仓库内相对目录，默认 data/daily，拒绝符号链接和 Git 元数据目录 |
| `pushAttempts` | 推送尝试次数，1–5，默认 3 |
| `author.name / email / actor` | 提交显示名、邮箱、GitHub 用户名 |

暂停：将 `enabled` 改为 false 并提交推送；恢复改为 true。Actions 仍会按时间唤起并报告 paused；要停止唤起可在 GitHub Actions 中禁用工作流。

运行参数可覆盖配置。邮箱优先级：命令行参数 > GIT_AUTHOR_EMAIL 环境变量/Actions Variable > 项目配置 > GitHub API 推导。API 推导只是兜底，无法证明邮箱已关联到你。

## 运行、回填与恢复

```sh
# 演练不生成记录、不提交、不推送，也不写本地运行日志
./green-wall run --dry-run --json

# 仅本地提交；之后直接 run 可补推，无需再造一个提交
./green-wall run --no-push
./green-wall run

# 明确标记回填；单次仍最多一个提交
./green-wall run --date 2026-10-20 --dry-run

# 机器可读状态
./green-wall status --json
```

生成记录包括日期、生成时间、触发方式、仓库累计提交数和回填标记。提交身份会在推送前核对；拦截平台和机器人邮箱，不会修改全局 git 身份。

推送暂时失败时会有限重试并返回失败。本地提交会保留，用相同日期重跑可核对远端并补推；只补推 author 一致、带 `[auto]` 标记且仅涉及每日记录的提交。若混有人工提交、远端分叉或权限拒绝，系统明确报错，保留现场供手动处理。GitHub 的第二次定时任务在全新检出中重跑，若第一次没有推送记录，会重新生成该日记录。

核心脚本仍可单独运行：

```sh
node scripts/auto-commit.mjs --help
node scripts/author.mjs --verify-last-commit
```

高级参数 `--force-dirty` 仍只提交生成记录，保留无关暂存内容；`--empty` 会显式生成空提交并保留用户索引。日常使用不需要这些参数。系统不批量循环补历史，也不 force push、rebase 或自动合并冲突。

## 观察运行结果

- `./green-wall status`：当前配置、今日是否已提交本地记录、记录数、最近一次本机运行结果。
- `.green-wall/last-run.json`：最近一次本机真实运行摘要。
- `.green-wall/runs/`：最近 30 次本机真实运行，独立文件；整个目录被 git 忽略。
- **Actions 运行摘要**：线上结果、目标日期、分支、是否推送和错误原因；诊断 JSON 作为 artifact 保留 14 天，包含演练与暂停结果。

本机状态不会伪装成 GitHub Actions 的实时状态。查看线上成功与否请以 Actions 日志及远端提交为准。

## 常见故障

| 错误 | 处理 |
| --- | --- |
| `DIRTY_WORKTREE` | 先提交或 stash 工作区改动；不要让系统带走人工工作 |
| `NOT_DEFAULT_BRANCH / BRANCH_MISMATCH` | 切回默认分支；--branch 不负责替你切分支 |
| `DEFAULT_BRANCH_UNKNOWN` | 检查 origin 和网络，运行 git remote set-head origin -a |
| `AUTHOR_UNRESOLVED / AUTHOR_REJECTED` | 配置自己的已验证邮箱；平台邮箱会被拦截 |
| `UNSAFE_DATA_PATH` | 改用真实的仓库内目录，移除符号链接路径 |
| `RECORD_NOT_COMMITTED` | 上次提交失败留下记录，检查并手动处理后重跑，不会覆盖现有文件 |
| `RUN_LOCKED` | 等其他运行结束；崩溃后先确认进程已结束，再删除错误中指出的临时锁文件 |
| `UNSAFE_PENDING_COMMITS / REMOTE_DIVERGED` | 检查 git log 与远端，手动处理同步后重试 |
| 推送失败 | 检查网络、凭据、写权限和分支保护；修好后用相同日期重跑 |

GitHub 定时不是精确时钟，可能延迟或被停用。每日第二次运行是容错，不是可用性保证。失败由 GitHub Actions 自身通知策略通知仓库所有者；项目不会向第三方发送消息。

## 开发与验证

先搜索 GitHub 同类项目，再决定复用或迭代；本次参考、实现入口和许可证见 [同类研究](docs/research.md)。

```sh
./green-wall test             # 离线回归
./green-wall test --network   # 加 GitHub API 推导测试
```

自测全部在一次性临时 Git 仓库运行，不会修改你的真实仓库历史。CI 会在 Node 20 和 24 上运行离线回归；联网测试供手动使用。

项目级 Codex 配置是否加载受项目受信任状态影响，实际权限也受会话环境约束。不要把配置文件存在等同于已生效。本项目不读取或修改全局 Codex 配置、MCP 密钥。
