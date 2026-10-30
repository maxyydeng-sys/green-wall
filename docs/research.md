# GitHub 同类项目研究（2026-10-26）

开发前阅读了以下项目的 README、关键实现与许可证。仅参考设计思路，本项目实现仍只使用 Node 内置模块，未复制第三方源码。

| 项目 | 许可证 / 阅读入口 | 借鉴的做法 | 本项目的选择 |
| --- | --- | --- | --- |
| [stefanzweifel/git-auto-commit-action](https://github.com/stefanzweifel/git-auto-commit-action) | [MIT](https://github.com/stefanzweifel/git-auto-commit-action/blob/master/LICENSE)、[entrypoint.sh](https://github.com/stefanzweifel/git-auto-commit-action/blob/master/entrypoint.sh) | 明确提交范围、默认分支检出、区分是否提交与是否推送 | 保留单文件提交和机器摘要；不会自动合并或强推 |
| [EndBug/add-and-commit](https://github.com/EndBug/add-and-commit) | [MIT](https://github.com/EndBug/add-and-commit/blob/main/LICENSE)、[src/main.ts](https://github.com/EndBug/add-and-commit/blob/main/src/main.ts) | 有界重试、演练模式、独立运行结果 | 推送默认最多尝试 3 次；重复运行可补推已有系统记录；拒绝夹带人工提交 |

没有直接接入这些 Action：它们用于通用文件提交，本项目需要额外保证邮箱归属检查、每日幂等、回填标记、符号链接边界与暂存区保留；现有实现已经具备相应基础。

## 一手文档核对

- [Git commit](https://git-scm.com/docs/git-commit)：空提交使用 `--allow-empty --only`，忽略已有暂存内容。
- [GitHub workflow_dispatch](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch)：手动触发的 ref 可以是指定分支或标签，不等于默认分支。
- [GitHub schedule](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)：UTC 定时、默认分支运行、调度可能延迟。采用 03:17 / 07:17 UTC，留出跨日前缓冲。
- [GitHub email reference](https://docs.github.com/en/account-and-profile/reference/email-addresses-reference)：邮箱格式检查无法替代账号中的实际验证。

## 后续开发流程

每次新项目或实质性迭代，先检索 GitHub 的同类项目与相关问题，阅读实现和许可证，记录采用与不采用的原因；再做最小必要改动并验证。GitHub 无法访问时明确说明限制，继续可独立完成的工作。

## 每日资料升级研究（2026-10-30）

- [eudoxia0/hashcards](https://github.com/eudoxia0/hashcards)：阅读 README、默认分支的 src/parser.rs 和 LICENSE，许可证为 Apache-2.0。借鉴纯文本显式问答、来源定位与确定性处理；不引入其 Rust/数据库/复习调度依赖，不复制代码。
- [hassaanz/repo-report](https://github.com/hassaanz/repo-report)：阅读 README 与 simple-report.sh，借鉴按时间窗口输出项目活动报告的结构。README 声明 MIT，但仓库根目录列表未见独立 LICENSE；仅参考设计，不复用源码或上传脚本。
- GitHub 官方 [Issues API](https://docs.github.com/en/rest/issues/issues#list-repository-issues) 明确 Issue 接口包含 PR，因此本系统按 pull_request 字段分别统计。
- 使用官方 [Commits API](https://docs.github.com/en/rest/commits/commits#list-commits) 和 [Latest Release API](https://docs.github.com/en/rest/releases/releases#get-the-latest-release)，保留来源、分页截断标记和采集时间。Latest Release 不作为 LTS 判定。

用户确认的来源为 notes/、maxyydeng-sys/green-wall 与 nodejs/node 最新发布信息。报告结构化快照嵌入单个每日 Markdown；不覆盖历史、不为纯刷新再造当日提交。
