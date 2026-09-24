# 验证记录

## 2026-09-24：Codex 桌面定时跟进与心跳

当前 Codex 桌面任务已创建并启用每分钟本地定时跟进（自动化 ID `dsh`），使用已持久化的 DSH 收件箱；无待处理请求时保持安静。新增 `codex.report` / `codex.status` 将最近核验时的桌面任务 ID、状态、时间按 Git 仓库存储；侧栏超过两分钟显示过期。此机制依赖 Codex 桌面应用与 DSH Web 运行，不提供瞬时状态或立即推送。对 DSH 新请求的实际下一次定时唤醒与状态回写，仍待真实 DSH Web Host 重启后验证。

`pnpm run typecheck` 和 `pnpm test` 28/28 通过，新增测试覆盖心跳持久化、非法状态拒绝与 MCP 工具目录。独立启动的公开 Codex app-server 在 `mcpServerStatus/list` 中发现 `dsh-codex-bridge` 的 17 个工具，包括 `dsh_review_inbox`、`dsh_codex_status`、`dsh_codex_report`；这是新 app-server 进程的发现证据。**本条正在运行的 Codex 桌面任务工具清单仍只有旧 12 项**，尚不能声称当前桌面任务动态刷新成功；需桌面任务重新加载工具后复核。

## 2026-09-24：v0.4 原生插件、侧栏与 TypeScript

DSH `0.1.7-alpha.2` 的 Web profile 已通过 `dsh plugin --profile web add` 登记 `dsh-codex-bridge` 组合包，旧的直接 Cordis 挂载已卸载。用户手动重启 DSH Web 后，真实插件页显示“已安装”的 `dsh-codex-bridge`，会话右侧栏显示“Codex 桥接”入口，并显示该仓库真实会话、目录、收件箱及历史回复。此时版本 0.4.0 的真实 Web 加载与插件可见性得到验证。未向用户的仓库提交测试送审请求。

随后补充的工作区注册表映射与“一般请求 / 完成验收”双入口，在**隔离 DSH_HOME** 启动的 Web 中先验证原生插件加载；侧栏从真实 `WorkspaceRegistry.resolveByPath` 显示默认工作区名称、ID、会话和目录；无 Git 基线目录禁止发送。隔离页面确认两种表单切换、自检输入及无 Git 时的禁用状态。用户再次手动重启真实 Web 后，插件页仍列为“已安装”；`dsh-codex-bridge` 工作区侧栏显示真实工作区名称、ID、会话和仓库目录，三条历史收件箱卡片默认折叠。

真实页面往返：从该工作区新会话 `session-4564a749-983c-495e-90e4-bf0762bcad71` 在右侧栏发送明确限于连通性的“一般任务 / 问题”请求；Codex CLI 从同一持久收件箱读到 `request-b48c25d828fc6599b6a6e0df542f5725`，核对 `kind=task`、session ID 和 cwd 后回复。侧栏随后显示 `responded` 与“已受理”，反馈明确**未执行新代码任务、未验收本轮代码**。最后的收件箱命名与长摘要截断由页面重新加载客户端包后在真实 Web 复核：三条卡片默认折叠，摘要约 100 字预览，展开可读完整内容。这证明当前真实 Web 的 UI→收件箱→Codex 读取与回复→UI 链路；尚未验证 Codex 桌面任务实时状态或任务自动唤醒。持久收件箱一般请求的去重、分类、DSH Tool 来源身份与回复后代码变化容忍另由单元测试验证。

生产逻辑与测试已迁至 TypeScript/TSX；两条 `bin/*.mjs` 和 `scripts/build.mjs` 保留为 Node 构建与启动引导。当前 `tsconfig` 非 strict，类型检查通过不代表每处动态 DSH 服务都获得静态类型保证。`pnpm test` 27/27、`pnpm run typecheck` 通过；`pnpm pack` 包含预构建 `lib/src/` 与 `lib/client.js`，不打包测试文件。GitHub/GitLab 真实远端发布以及 Codex 桌面新增 MCP 工具动态发现仍未在此轮验证。本轮代码尚未提交或推送。

## 2026-09-24：双端送审与同工作区多会话

本机版本升级为 0.3.0。项目原有的两个入口现已明确：DSH Cordis 插件注册 `request_codex_review` / `check_codex_review`，Codex MCP 暴露 `dsh_review_inbox` / `dsh_review_respond`。普通 DSH 会话的请求附真实 session ID、cwd、Git HEAD 和变更文件内容指纹；同一 requestId 幂等。计划内送审必须来自对应执行会话，正式复核继续走 `plan.review`。

真实联调：在唯一的 `dsh-codex-bridge` DSH 工作区下并行创建 A/B 两个会话，二者实际 cwd 均为当前仓库。A 只读核对 package.json，B 只读核对 README.md；两者都调用 DSH 原生 Tool 主动送审。Codex 从 MCP 同源收件箱读到两份请求，独立读取文件、核对 Git 指纹后记录仅针对本次联调的 accepted 回复；两个原 DSH 会话又调用 `check_codex_review` 并读回各自结果。两个会话均完成两轮 turn，未产生测试代码修改。[完整联调证据](evidence/shared-workspace-bidirectional.json)，[最终安装与 MCP 链路证据](evidence/installation-v0.3.json)。

截图中的六个 `bridge-real-*` 测试工作区确由上轮测试按每个 Git worktree 分别注册。已用 DSH 官方 WorkspaceRegistry 归档其中四个会话、删除六条测试工作区**注册**；目录、Git 分支、提交及会话日志均保留。原有 `dsh-codex-bridge` 工作区保留并含新 A/B 会话。DSH 要求一个工作区的会话 cwd 与其路径完全一致，因此需要独立 cwd 的并行改代码任务仍会有独立工作区；同工作区多会话联调属于共享目录的只读任务。

`npm test` 25 项通过，包括新增的请求去重、会话来源、快照变化拦截和计划复核门禁。当前 Codex 桌面任务已可直接调用原先注册的 12 个 MCP 工具，`dsh_bridge_status` 经桌面 MCP 返回 v0.3 构建；新增加的 3 个验收工具尚未在本轮任务的工具清单中动态刷新。真实收件箱与回复联调由当前任务的 CLI 调用同一已安装服务完成，待新任务加载后再验证新增 MCP 工具发现。已推送的 GitHub `origin/main` 只用于核对远端存在，本轮新增代码未推送，真实 GitHub/GitLab issue 与 PR/MR 联调仍未执行。

## 2026-09-23：v0.2 原始验证

当日本机可运行版本：0.2.0。**本地实现与真实 DSH 运行已验证；GitHub/GitLab 的真实远端发布、Codex 桌面新 MCP 工具发现及 UI 可见性未验证。**

## 已验证

| 项目           | 证据及结论                                                                                                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 原任务往返     | 当前 Codex 桌面任务通过 CLI 调用同一个插件服务，真实 DSH 回复 `DSH_CODEX_BRIDGE_OK` 返回本任务。未另建 Codex 任务                                                                                            |
| 运行中插话     | 专用 DSH 会话收到 steer 后返回 `DSH_STEER_OK`                                                                                                                                                                |
| 停止           | 真实 DSH agent 取消、等待 whenIdle、持久 flush 后返回 stopped；两个受阻测试计划也通过 plan.stop 确认停止                                                                                                     |
| 单任务闭环     | `real-e2e-fixed-20260923`：实际 cwd 等于独立 worktree；DSH 实现 math.mjs/math.test.mjs；桥接提交 `871ec1b6bcde96086c62385781aa06f63a7d272d`；Codex 独立读取并重跑测试 3/3，通过同一 reviewHash 后为 reviewed |
| 并行与依赖     | `real-parallel-20260923`：alpha、beta 两个不同 DSH 会话同时 running，各自独立 worktree。分别复核后才启动 integration，会话实际 cwd 均正确                                                                    |
| 组合验收       | 集成提交 `735b867242e746227a7e11533ef18426f92a0e68` 包含两个子任务提交；Codex 独立逐字读取 alpha/beta 文件、验证祖先关系及干净状态后接受，计划为 reviewed                                                    |
| Git 与调度回归 | `npm test` 23 项通过；包括并发去重、未知状态不重发、基线内容变化拦截、用户原目录修改保留、依赖与组合验证、停止门禁、审批状态、范围越界、过期复核、三次修订上限、连续同类阻塞停止                             |
| Forge 适配回归 | GitHub/GitLab 的 lost-ack issue 查重使用受控 CLI 测试替身；Git 推送使用本地 bare remote 实际执行并比对 ref；验证只创建草稿 PR、不合并。**不等于真实平台认证/API 联调**                                       |
| MCP 协议       | 独立 stdio 客户端验证 initialize、tools/list、tools/call 及参数错误；另经真实 MCP → 已安装 DSH 服务往返，返回构建与源码一致；Codex config 已注册 bin/mcp.mjs                                                 |

原始证据：

- [单任务证据](evidence/real-e2e.json)：模型设置、实际会话目录、提交、文件 SHA-256、独立测试输出及 DSH 原始回复。
- [并行启动](evidence/parallel-start.json)：同一时点两个执行会话均为 running，集成任务 pending。
- [并行与集成证据](evidence/parallel-e2e.json)：三个会话、各自目录、提交及复核记录。
- [最终安装核对](evidence/installation.json)：安装构建、当前源码指纹和 MCP 配置核验。

DSH 自述中的“验收通过”不是最终判定。以上 reviewed 状态来自 Codex 读取实际产物与执行验证后的独立复核。

## 保留的失败与修正

1. 原骨架假定的 Codex app-server daemon socket 不存在。改为 Codex 当前任务调用 DSH 插件的 Unix socket，不使用 Codex 私有 IPC，不写会话数据库。
2. `real-e2e-20260923` 放在 `/tmp`，DSH 沙箱中的 tmpfs 看不到该 worktree；已停止，未提高权限。
3. `real-e2e-local-20260923` 暴露了适配错误：误读 `WorkspaceView.id`，实际字段为 `workspaceId`，会话回退到 DSH 默认目录。已停止。执行记录显示只读检查后，尝试在**测试 worktree**改 HANDOFF 被目录权限阻挡，随后权限请求被取消；没有批准 danger-full-access。
4. 修正为 `workspace.workspaceId`，并在发出任何 prompt 前查持久 session cwd 与 worktree 是否相同；缺字段或不一致直接拒绝。新增回归测试。之后的单任务和并行测试均验证实际 cwd。
5. 热替换插件模块时旧 socket 可能暂时存活；安装器改成空闲时先卸载旧挂载，确认关闭后再挂载不可变版本，并处理卸载期间 ECONNRESET/EPIPE。活跃计划拒绝更新。
6. 执行方只允许修改任务文件时不应自行改 HANDOFF；明确由桥接维护其 consumed 状态。

没有删除上述失败计划、执行记录或测试分支，也没有把失败测试改写成通过。

## 尚未验证／使用限制

- 当日项目没有指定 GitHub/GitLab 远端测试仓库，因此未真实创建远端 issue、推送远端或创建 PR/MR。
- Codex MCP 配置已安装，协议测试通过；本轮桌面任务的工具清单没有动态刷新，所以真实运行使用 CLI 调用了同一服务。需在应用重新加载配置后核实 `dsh_*` 工具出现；安装配置本身不算桌面发现验收。
- 应用内浏览器访问 `http://127.0.0.1:3080` 返回 `ERR_BLOCKED_BY_CLIENT`，没有取得 DSH UI 截图。会话已通过正式 WorkspaceController/SessionController 创建，但未声称已做视觉验收。
- 遇到 DSH 审批或 ask_user_question 会暴露 waiting_user，仍在 DSH 原界面回答；插件不自动批准权限，Codex 可停止该任务。
- Git 合并冲突、执行状态不明、中断准备和不同远端分支 HEAD 保守阻塞，保留现场供人工处理，不强制回滚或自动覆盖。
- Codex 需保持协调轮次以等待及复核。插件不会在 Codex 任务已经结束后自行唤醒模型。
- 范围检查在提交阶段执行，不能替代 DSH 自身沙箱；不承诺能够从操作系统层阻止所有范围外触碰。

## 本地变更与安装

- 初始 12 个项目文件和 .gitignore 经用户逐项范围确认后提交为 `04bc211`。
- 实施代码、文档和测试位于当前工作区；未替用户发布或推送项目。
- DSH Web profile 新增带 BEGIN/END 标记的桥接挂载块；修改前均保存备份。原 DSH 服务未重启，其他插件和模型配置未改。
- Codex 增加 `dsh-codex-bridge` MCP，配置修改前保存备份，未改模型、推理或原有服务器。
