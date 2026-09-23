# 验证记录 — 2026-09-23

本机可运行版本：0.2.0。**本地实现与真实 DSH 运行已验证；GitHub/GitLab 的真实远端发布、Codex 桌面新 MCP 工具发现及 UI 可见性未验证。**

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
| MCP 协议       | 独立 stdio 客户端验证 initialize、tools/list、tools/call 及参数错误；另经真实 MCP → 已安装 DSH 服务往返，返回构建与源码一致；Codex config 已注册 bin/mcp.mjs                                                                                                 |

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

- 当前项目没有指定 GitHub/GitLab 远端测试仓库，本轮没有真实创建远端 issue、推送远端或创建 PR/MR。
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
