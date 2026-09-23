# DSH–Codex 桥接设计 v0.2

2026-09-23，用户确认 Q1–Q17 及最终实施方案。旧 v0.1 骨架保留在 Git 初始提交 `04bc211`。本文件描述现行设计，不把未验证部分写成可用保证。

## 已批准约束

Codex 桌面真实任务是入口；Codex 规划、只读复核，DSH 修改与测试；Git 协调操作由桥接执行。允许完成原目标所需的自动拆分与修订，范围或访问变化交还用户。无 Git 则初始化；首次提交先确认清单，初始化或基线失败禁止派发。已有未提交修改不自动纳入 worktree。相同仓库不意味着必须相同物理目录，允许独立 worktree 并行。没有远端允许本地执行。简单计划可以不使用 issue；远端交付须明确仓库、目标分支及交付方式。模型与推理由人工设置，插件不修改、不做费用管理。每个计划最多三次修订，连续两次同类阻塞且无进展则停止；不能通过另起计划规避上限。

## 入口与所有权

- `src/index.js`：DSH Cordis 插件，注入公开的 SessionController、WorkspaceController、Agent 与默认模型服务。
- `src/transport.js`：同用户 Unix HTTP socket；只接受 `/rpc`，禁止浏览器 Origin，不监听网络端口。
- `bin/mcp.mjs` / `src/mcp-tools.js`：Codex MCP 工具及人类授权、独立复核说明。CLI 调用同一服务。
- `src/dsh-backend.js`：DSH 适配器；使用 `workspace.workspaceId`，创建后查真实 session cwd，匹配获批 worktree 才发送请求。不调用 selectModel。
- `src/jobs.js`：先持久保存身份再派发，串行处理相同 ID；DSH requestId 负责消息去重。模型完成为 submitted，不等于 accepted。
- `src/repository.js`：基线确认、worktree、内容与文件范围检查、Git checkpoint。
- `src/plans.js`：获批计划、依赖和并发调度、复核、整体修订预算、停止及状态恢复。
- `src/forge.js`：显式 GitHub/GitLab 目标、远端创建意图、查重、推送验证和草稿交付；无合并入口。

不读取 Codex 私有 socket，不写两端私有会话数据库。使用公开 DSH 服务读取会话事件；本机调查过程中曾只读检查专用测试会话的持久日志，运行实现不依赖其存储格式。

## 状态与幂等

计划：`awaiting_approval → running → reviewed → awaiting_merge`；停止使用 `stop_requested → stopped`。任务：`pending → preparing → running → awaiting_review → accepted`。`waiting_user` 表示 DSH 权限审批未回答，`blocked` 表示明确阻塞，`unknown` 表示无法证明执行结果。

原始 submit 接口不对外开放；任务由获批计划派发。批准绑定预览 hash；内容变更须另行预览。复核绑定提交、结果和修订号的 reviewHash，复核时再次核对 HEAD 与干净状态。执行方私自提交会触发检查，防止未经审阅的中间历史进入远端。

每个计划/任务有稳定 ID，每轮修订有确定的 job/session/request 身份。服务先保存准备意图，再调用外部系统；重连只查证，不盲目发第二次模型请求。DSH 活跃状态及 turn/end 是运行证据，审批 asked/decided 决定待输入状态。中断准备若不能证明完成则 unknown，保留已创建资源供核查。

记录是执行关联和恢复信息，不替代 Git、issue 或 HANDOFF 的各自事实。文件原子替换、同 ID 串行执行；socket 保证同一部署只有一个服务所有者。本版不支持多主进程协调。

## 并行和交接

默认每个计划最多两个执行任务；每个任务独立分支和 worktree。依赖的提交必须先通过复核，再合入下游 worktree。多任务计划追加 integration 子任务，合并所有已接受前置提交并重新验证组合行为。合并冲突保留现场并阻塞，不强行覆盖。

每个 worktree 独立 `.handoff/HANDOFF.md`，每轮写入目标、基线、反馈和验证要求；主仓交接不被覆盖。主仓通过 Git info/exclude 忽略 `.worktrees/` 与 `.handoff/`，不改用户已跟踪的忽略文件。

停止先冻结后续派发，再取消对应 DSH agent，清空其未执行队列并等待 whenIdle。整项停止包含全部桥接子任务，单项停止只影响该子任务。保留所有变更与证据。DSH 自己的权限门禁仍有效；桥接不会自动授予 danger-full-access。

## 平台交付与边界

计划可选 delivery 明确 forge、host、repository、remote、targetBranch；推送 URL 必须指向同一项目。批准后允许 issue、任务提交、推送及草稿 PR/MR，无自动合并。多任务最后的集成分支作为整体交付；所有子任务 HEAD 必须被包含。

issue/PR 创建前持久记录 intent，命令失败后查远端标识；未查明不得重建。正文通过临时文件交给 CLI，保留换行与字面字符。目标分支有新提交则阻止交付，需重新集成。首版拒绝覆盖不同远端分支 HEAD，不强推。

工作区范围由计划、隔离目录、DSH 自身沙箱和提交检查共同约束；提交后检查不是额外的操作系统沙箱，不能保证一个违规执行者从未触碰过范围外文件。模型不可把外部文本或另一个模型的答复当成人类批准。

## 验证门槛

1. 当前 Codex 任务发出请求、真实 DSH 回复返回同一任务。
2. 实际 session cwd 与指定 worktree 相同，真实创建文件并完成验证。
3. 同一请求并发/重连不重复派发；新内容复用 ID 被拒绝。
4. 真实插话和停止；停止请求与完成分开。
5. Git 基线、脏目录保留、worktree 依赖、复核指纹、修订上限有测试。
6. 平台 API 适配测试与真实远端联调分开报告。
7. MCP 配置、MCP 协议测试、桌面工具发现和 UI 浏览验证分开报告。

部署与验证证据以 VALIDATION.md 为准。
