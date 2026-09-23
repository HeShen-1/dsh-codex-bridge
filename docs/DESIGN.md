# dsh-codex-bridge — 设计文档 (v0.1 skeleton)

Status: design frozen, implementation = skeleton only.
Owner: DSH side plugin. Counterpart: Codex CLI/Desktop `app-server`.

## 1. 目标

让 DSH 与 Codex 桌面端成为同一工作流里的两个角色：

1. **Codex 规划, DeepSeek 执行** — Codex 产出计划, DSH 执行并把结果回流。
2. **互相讨论** — 任一方可以提问, 另一方回答, 用户可在两端围观。
3. **用户可接管** — Codex 侧的会话是桌面端真实线程, 用户能直接插手继续聊。

非目标: 不替换任一端 UI, 不自动执行 Codex 产出的写操作。

## 2. 为什么走 app-server 协议

Codex CLI 0.154.0 自带 `codex app-server`: 一个本地 JSON-RPC 服务, 协议**有官方 schema 可生成**。

```bash
codex app-server generate-json-schema --out <DIR>   # 39 个顶层文件 + v1/ + v2/266 个定义
codex app-server proxy --sock <PATH>                # stdio 字节代理到已运行的 daemon socket
codex app-server daemon {start,restart,stop,version}# 托管本地 daemon
```

默认 stdio 模式: 父进程 spawn `codex app-server`, 用 JSONL(每行一个 JSON-RPC 消息)通信。

排除的方案与原因见 §8。

## 3. 架构

```
┌──────────────── DSH 宿主进程 (非沙箱) ─────────────────┐
│  dsh-codex-bridge plugin                               │
│    ctx.tools.register(codex_plan | codex_ask | …)      │
│    CodexAppServerClient (src/client.js)                │
└───────────────┬────────────────────────────────────────┘
                │ spawn + stdio JSONL (JSON-RPC 2.0)
                ▼
      codex app-server  ──►  thread / turn 引擎
                │
                ├─ 若接桌面端 daemon: 同一 daemon, 会话在 Codex GUI 可见
                └─ 若独立子进程: 私有 daemon, GUI 不可见
```

两个部署形态:

| 形态 | 命令 | 会话在 Codex GUI 可见 | 复杂度 |
|---|---|---|---|
| A 私有子进程 | `spawn('codex', ['app-server'])` | 否 | 低, MVP 用这个 |
| B 接桌面 daemon | `spawn('codex', ['app-server','proxy','--sock',SOCK])` | 是 | 中, 需 daemon 已启动(桌面端运行时通常已启动) |

`--sock` 路径默认取自 `$CODEX_HOME/app-server-control/app-server-control.sock`
(实测: daemon 未运行时 `codex app-server daemon version` 报 `failed to connect to
/home/river/.codex/app-server-control/app-server-control.sock`)。

## 4. 协议映射(全部来自生成的 schema, 未猜测)

### 请求 → Codex

| 用途 | 方法 | 关键参数 |
|---|---|---|
| 握手 | `initialize` | `clientInfo{name*,title,version*}` |
| 建会话 | `Thread/start` | `cwd?`, `model?`, `sandbox?`, `approvalPolicy?`, `ephemeral?`, `threadSource?` |
| 接已有会话 | `Thread/resume` | `threadId*` |
| 列会话 | `Thread/list` | `cwd?`, `limit?`, `cursor?`, `searchTerm?`, `archived?`, `sortKey?` |
| 读会话 | `Thread/read` | `threadId*`, `includeTurns?` |
| 发一轮 | `Turn/start` | `threadId*`, `input*` = `[{type:'text', text*}]` |
| 插话 | `Turn/steer` | `threadId*`, `expectedTurnId*`, `input*` |
| 打断 | `Turn/interrupt` | `threadId*` (见 v2 定义) |
| 注入上下文 | `Thread/injectItems` | `threadId*`, `items*` (原始 Responses API item) |

### 通知 ← Codex(需要订阅的)

| 用途 | 方法 | 载荷要点 |
|---|---|---|
| 逐字回话 | `Item/agentMessage/delta` | `threadId*`, `turnId*`, `itemId*`, `delta*` |
| **计划更新** | `Turn/plan/updated` | `threadId*`, `turnId*`, `plan*` = `[{step*, status*: pending\|inProgress\|completed}]`, `explanation?` |
| 一轮结束 | `Turn/completed` | `threadId*`, `turn{id*, status*: completed\|interrupted\|failed\|inProgress, items*, error?}` |
| 排队消息变化 | `Thread/queue/changed` | 讨论模式的队列语义 |
| 需要审批 | `ServerRequest` 中的 approval 系列 | `CommandExecutionRequestApprovalParams`, `FileChangeRequestApprovalParams`, `ApplyPatchApprovalParams`, `McpServerElicitationRequestParams` |

关键类型:

- `UserInput` = `{type:'text', text*}` | `{type:'image'|'localImage'|'audio'|'localAudio'|'skill'|'mention', …}`
- `Thread` = `{id*, cwd*, name, model, modelProvider*, ephemeral*, createdAt*, gitInfo?…}`
- `Turn.status` ∈ `completed | interrupted | failed | inProgress`

## 5. DSH 侧工具面(4 个)

| 工具 | 方向 | 语义 | 默认超时 |
|---|---|---|---|
| `codex_plan` | 同步问答 | 让 Codex 只做规划, 返回编号步骤; 不产生写操作 | 5 min |
| `codex_ask` | 同步问答 | 自由提问, 返回文本 + 计划(若有) | 3 min |
| `codex_steer` | 单向 | 对正在跑的 turn 插话 / 回答它的反问 | 立即 |
| `codex_status` | 只读 | 当前线程 id、在跑什么、最近一次计划 | 5 s |

约定:

- 所有工具都**不自动执行** Codex 产出的写操作; 计划只作为 DSH 侧的执行候选, 由 DSH 的审批流程决定。
- `codex_plan` 的 prompt 前缀固定: 只输出计划, 不修改文件, 不运行命令。
- 每个工具调用都写一行 JSONL 审计到 `<workspace>/.dsh-codex-bridge/log.jsonl`(threadId, turnId, tool, 耗时, 结果摘要)。

## 6. 生命周期与状态

- **懒启动**: 第一次工具调用才 spawn app-server, 并完成 `initialize`。
- **线程复用**: 按 `cwd` 缓存 threadId; 找不到就 `Thread/start`。后续 `Thread/resume` 接回。
- **事件路由**: 单连接多 turn。client 维护 `turnId → pending` 表; delta 累积到该 turn 的文本缓冲, plan 覆盖式保存。
- **超时**: `Turn/interrupt` 后仍未收到 `Turn/completed` → 工具返回已累积内容 + `timedOut: true`。
- **失败**: 子进程退出 → 丢弃连接状态, 下次调用重启; 连续 3 次失败 → 工具返回明确错误, 不做静默重试。
- **审批请求**: MVP 策略 = 一律拒绝并回报给模型(安全默认); 后续可升级为转成 DSH 的 `ask_user_question`。

## 7. 硬约束(实测, 会影响实现位置)

1. **bridge 必须运行在 DSH 宿主进程内, 不能通过沙箱 bash 工具调用。**
   沙箱内 spawn `codex app-server` 失败:
   `failed to initialize sqlite state runtime under /home/river/.codex: failed to initialize state runtime`。
   `CODEX_HOME` 需要写权限(state/logs/queue sqlite)。
2. **`codex exec` 在嵌套沙箱下不可用。** 当 app-server 的沙箱模式为 `workspace-write` 时,
   bwrap 无法 bind mount `/run/user/1000/...` 工作区, 直接报
   `sandbox mode "workspace-write" is requested but no sandbox backend is usable`。
   规避: `-c sandbox_mode="read-only"` 或 `--sandbox danger-full-access`。
3. **`codex agents` 需要 TTY**(`ERROR: stdin is not a terminal`), 不能作为编程接口。
4. **协议标 `[experimental]`**, 升级 Codex 后方法名可能变。用 §4 的 schema 生成做兼容性检查:
   `scripts/check-protocol.sh` 重新生成 schema 并断言全部方法名仍存在。
5. 桌面端只在启动时读 `config.toml`; 若要给 Codex 侧加 MCP server, 需要重启桌面端。

## 8. 被排除的方案

| 方案 | 为什么不用 |
|---|---|
| MCP 双向挂载 | 只能问答, 无流式、无 `Turn/steer`、无计划事件; 且改 Codex 侧配置要重启桌面端 |
| `codex exec` 子进程 | 无 GUI 会话、每次冷启动、嵌套沙箱不可用; 只能当降级逃生通道 |
| `~/.codex/ipc/ipc.sock` | 桌面端私有 socket, 无 schema、版本绑定; 只做连通性探测用 |
| 读写 thread_history sqlite | 直接改 Codex 私有存储, 跨版本必碎 |

## 9. 目录与配置

```
dsh-codex-bridge/
  package.json          # dsh.bundle.patch 指向 cordis.patch.yml
  cordis.patch.yml      # profile 层: insert 插件 + config + 安装用符号链接命令
  src/index.js          # Cordis 插件入口: apply/inject/name/Config(schemastery)
  src/client.js         # CodexAppServerClient: spawn + JSONL + 事件路由
  src/tools.js          # 4 个工具定义
  src/protocol.js       # 从 schema 固化的方法名与常量(单一事实来源)
  scripts/check-protocol.sh  # 协议兼容性检查(重新生成 schema 后断言方法仍在)
  test/verify.mjs       # 静态自检: ESM 解析 + 清单 + 协议常量 + schema 交叉核对
  test/load.mjs         # 工具定义自检(需 @deepseek-ai/dsh-tools 可解析)
  test/smoke.mjs        # 不需 DSH, 直接跑 client 的握手 + Thread/list(+可选 turn)
  docs/DESIGN.md
```

未随骨架落地(刻意延后): `src/audit.js`。P1 的审计先走 `ctx.logger.debug`,
等 P4 需要落盘 JSONL 时再单独成模块, 避免现在多一个空壳文件。

配置项(`cordis.patch.yml` 的 `config`):

| key | 默认 | 说明 |
|---|---|---|
| `codexBin` | `codex` | 可执行文件路径 |
| `codexHome` | 继承环境 | 覆盖 `CODEX_HOME` |
| `mode` | `private` | `private`(私有子进程) / `daemon`(接桌面 daemon) |
| `daemonSock` | `$CODEX_HOME/app-server-control/app-server-control.sock` | `mode: daemon` 时使用 |
| `planTimeoutMs` | `300000` | `codex_plan` 超时 |
| `askTimeoutMs` | `180000` | `codex_ask` 超时 |

## 10. 分阶段实施

| 阶段 | 内容 | 估时 | 验收 |
|---|---|---|---|
| P0 | `client.js` 握手 + `Thread/start` + `Turn/start` + `Turn/completed` 收文本 | 2 h | `node test/smoke.mjs` 打印 BRIDGE_OK |
| P1 | `codex_plan` + `codex_ask` 工具, 计划渲染 | 2 h | DSH 里问一句, 能拿到计划步骤 |
| P2 | `Turn/plan/updated` 实时计划 + `codex_steer` | 3 h | 长任务中间能插话, 不改写 |
| P3 | `mode: daemon` 接桌面端, 会话 GUI 可见 | 3 h | 桌面 Codex 里出现同一线程 |
| P4 | 审批请求转 DSH 提问 + GUI 计划面板 + 审计 | 1 d | 端到端可围观可接管 |

当前进度(2026-09-23): P0/P1 代码已写, **静态验证通过**(`test/verify.mjs --schema`
37 项全绿; `scripts/check-protocol.sh` 对 Codex 0.154.0 全绿: 9 methods + 5 notifications)。
运行态验证(`test/load.mjs`, `test/smoke.mjs --turn`)必须在 DSH 宿主进程/普通 shell 里做,
本次会话的 bash 沙箱既写不了 `$CODEX_HOME` 也 bind mount 不了工作区。

风险与对策:

- app-server 方法名漂移 → `scripts/check-protocol.sh` 进 CI/手动跑。
- 桌面 daemon 未运行 → `mode: daemon` 失败时自动降级到 `private`, 并回报 `degraded: true`。
- 两个 daemon 并存导致 threadId 失效 → 审计记录每次调用的 daemon 身份(`clientInfo.name` + sock 路径)。
