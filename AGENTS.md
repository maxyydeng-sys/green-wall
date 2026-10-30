# Green Wall 项目规则

## 开发方式

- 实质性开发前，优先检索 GitHub 上的类似项目，阅读 README、关键实现和许可证；说明复用或借鉴的理由。研究记录见 `docs/research.md`。
- 先说明范围，再实施。当前目标：稳定、幂等、可审计的每日自动提交系统。
- 保留用户提供的账号、邮箱和路径上下文；不读写全局 Codex 配置或 MCP 密钥。
- 主开发目录为本仓库。原 QwenWorkCN 交接目录保留，不覆盖其暂存区。

## 结构

- `green-wall`：本机启动器；优先 PATH 上的 Node，其次本机 Codex 捆绑 Node。
- `scripts/green-wall.mjs`：统一入口 init / doctor / status / run / test。
- `scripts/config.mjs`：业务配置校验和身份优先级。
- `scripts/digest.mjs`：学习输入、公开项目活动、Node.js 发布快照及日报渲染。
- `scripts/digest.test.mjs`：离线来源适配、快照比较与 CLI 集成测试，由 selftest 调用。
- `notes/YYYY-MM-DD.md`：用户主动提交的学习输入；禁止扫描其他本地笔记目录。
- `green-wall.config.json`：当前账号配置；禁止 token、密钥及未知字段。
- `scripts/auto-commit.mjs`：单次生成、提交、校验、推送及补推。
- `scripts/repository.mjs`：Git 封装、真实路径校验、默认分支识别、运行锁、推送恢复。
- `scripts/author.mjs`：提交身份与平台/机器人邮箱防线。
- `scripts/summary.mjs`：JSON 转 Actions 运行摘要。
- `scripts/selftest.mjs`：临时仓库中的行为回归；默认离线，--network 额外联网。
- `.github/workflows/auto-commit.yml`：唯一日常调度入口，两次 UTC cron + 手动触发；工作流更新时在默认分支做部署验收。
- `.github/workflows/ci.yml`：Node 20 / 24 离线回归，不把真实数据目录更新算作代码变更。
- `data/daily/YYYY-MM-DD.md`：每日记录，已有文件不覆盖。
- `.green-wall/`：本机摘要和最近 30 次运行，必须被 git 忽略。

## 硬约束

1. Node >= 20，ESM，只用内置模块及全局 fetch，不引入第三方运行依赖。
2. 提交邮箱必须可配置。拒绝 @github.com 平台地址、任何 [bot] 地址和带机器人特征的 noreply 地址。只有 @github.com 员工邮箱可由现有显式开关放行，且不得让 [bot] 绕过拦截。
3. 默认只允许在已确认的远端默认分支运行；--branch 不替用户切分支。workflow_dispatch 的 GITHUB_REF_NAME 是所选 ref，不能作为默认分支依据。
4. 单次最多新建一个提交；禁止循环刷提交、批量补一年或高频调度。日常幂等；--empty 仅作为显式高级选项。
5. 不 force push、不 reset --hard、不 rebase 已推送历史、不直接操作 .git 对象。远端分叉时停止并说明下一步。
6. 自动提交必须带 [auto] 标记，记录生成时间和触发方式；显式历史/未来日期必须标记回填。
7. 工作区有改动默认停止。即使 --force-dirty，也只提交自己的记录；--empty 必须使用 --only，保留用户索引及未暂存内容。
8. 数据路径必须在仓库内，逐级拒绝符号链接、最终文件符号链接和 .git 路径；写入用 wx，禁止覆盖。注意 macOS /var 与 /private/var 的仓库前缀等价。
9. 默认 Asia/Shanghai，按本地自然日计算。Actions cron 为 UTC；当前 03:17 / 07:17 UTC，即北京时间 11:17 / 15:17。
10. 所有 git 调用通过 execFileSync 参数数组，禁止拼接 shell 命令。远端错误不得输出含凭据的 URL。
11. 推送有限重试；同日已有记录时可核对远端并补推，只允许身份匹配的 [auto] 每日记录。禁止补推夹带人工提交。
12. 实际运行必须持有仓库运行锁；演练不创建记录、提交、运行日志或锁。直接使用 --summary-out 是调用者请求的诊断输出例外。
13. --json 的 stdout 只输出一个 JSON 对象，人类日志走 stderr。日志不能伪称本地状态等于 GitHub Actions 实时状态。
14. Actions 外部输入经 env 注入，run 里不直接插入 inputs.* 或 github.* 表达式；默认分支由仓库元数据确认。

15. 日报保留来源和采集时刻；无法采集不能写成零变化。必需外部来源失败时不生成提交，让后续调度重试。
16. 学习卡片只提取明确 Q:/A:，不编造学习内容；公开项目指标与 Node Release 仅保存选定字段，禁止保存响应认证头或 token。
17. 当天已有日报不改写，新格式用 preview 验证。结构化快照保存在同一 Markdown 内，仍然只提交一个每日文件。回填不声称还原历史 Issue/版本状态。

## 验证与完成标准

```sh
./green-wall test
./green-wall test --network
./green-wall status --json
```

- 行为改动必须补有意义的回归用例。先通过全部离线用例；涉及 GitHub API 的改动额外跑 --network。
- 验证工作流用 actionlint；不可用时至少解析 YAML、检查 5 段 cron 和输入插值边界。
- 同步 README 的配置、命令、故障码和调度时间。不要依赖 template.json：GitHub 模板设置需要仓库设置页配置。
- 测试使用一次性本地仓库和 bare 远端，不修改真实项目提交历史。
- 本机缺少 PATH Node 不算代码故障，使用 ./green-wall 或工具返回的捆绑 Node。
- 本地配置完成不等于线上部署。只有关联实际 GitHub 仓库、推送成功并验证 Actions 后，才能报告已启用定时运行。
