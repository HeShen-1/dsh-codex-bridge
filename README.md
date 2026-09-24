# DSH Codex Bridge

这是一个同时安装在两端的桥接：DSH Cordis 插件提供会话、Agent Tool 和本地服务；Codex MCP 服务器提供规划与独立复核工具。个人同机使用；模型和推理设置由用户在两端管理。

## 当前能力

- 预览计划 → 一次批准目标、文件范围、验收及可选远端交付 → DSH 执行 → Codex 独立复核。
- 每个子任务独立 worktree；默认同一计划最多 2 个并行执行。依赖任务等待前置复核通过。多任务计划自动增加组合后的集成验证。
- 没有 Git 就初始化；首次提交需要确认文件清单和内容指纹。原目录未提交修改保持原样，worktree 基于已提交 HEAD。
- 稳定任务 ID 和 DSH requestId 去重；持久保存派发意图，未知执行状态先查证，禁止盲目重发。
- 支持插话、整项计划或单子任务停止；确认 DSH 空闲后才标记停止。
- 首次实施后整个计划最多 3 次自动修订；连续两次同类阻塞无进展即停。不会通过换任务 ID 重置限制。
- GitHub / GitLab 可选 issue、任务分支推送、草稿 PR/MR；不合并，不自动创建远端仓库。
- DSH 会话可调用 `request_codex_task` 发送新任务或问题，也可调用 `request_codex_review` 把完成摘要与实际自检送入持久收件箱；Codex 通过 `dsh_review_inbox` 查看，DSH 可用 `check_codex_request` 查询一般请求、`check_codex_review` 查询验收回复。一般请求的受理不等于代码验收。
- DSH 审批仍遵守其原有策略；桥接状态会显示待审批。到 DSH 回答后继续，或在 Codex 停止任务。插件不会自动批准完整访问权限。

实现与验证等级见 [docs/VALIDATION.md](docs/VALIDATION.md)。第三方平台的真实发布、桌面 MCP 工具发现和 UI 可见性分别记录，不能由本地测试替代。

## 连接方式

```text
Codex 当前桌面任务
  └─ MCP 工具（或本任务中的 CLI）
       └─ 当前用户私有 Unix socket
            └─ DSH Web profile 内的桥接插件
                 └─ SessionController / Agent / Git worktree
```

Codex 的结果通过当前工具调用返回原任务。无需另建 Codex 会话、启动 Codex app-server、使用桌面私有 IPC 或写两端私有会话存储。

桥接记录按任务关联执行身份，不把一个 Codex 会话固定绑定一个 DSH 会话。两端可继续用原有 UI；插件不替换它们。Codex 用 `dsh_plan_wait` 或 `dsh_review_inbox` 接收并复核。当前桌面任务另设每分钟定时跟进，读取持久收件箱；仅在桌面应用运行且定时任务正常时提供延迟唤醒，不承诺瞬时推送。

DSH 工作区要求会话 `cwd` 与工作区路径完全一致。并行修改使用独立 Git worktree 时，DSH 会显示多个工作区；在一个工作区下测试多个会话，应让这些会话共享该目录，并限定为只读检查或人工明确划分且不会冲突的工作。

## 本机安装

需要 Node >=22.16、Git、已启动的 DSH Web profile。本版对 DSH `0.1.7-alpha.2` 的 SessionController / WorkspaceController API 做过运行验证；其他版本先核对接口。

```sh
pnpm install
pnpm test
pnpm run build
dsh plugin --profile web add /home/river/work/dsh/dsh-codex-bridge
node bin/bridge.mjs hello
codex mcp add dsh-codex-bridge -- node /home/river/work/dsh/dsh-codex-bridge/bin/mcp.mjs
```

DSH 使用原生组合包安装：`dsh.bundle` 将插件登记到 profile 的 `dsh.profile.bundles`，所以会出现在“插件”页；`dsh.client` 提供右侧栏的 Codex 桥接 tab。Git 安装需带已构建的 `lib/`；更新已安装包前需完成或明确停止活跃桥接计划。

Codex 安装后需要让应用重新加载 MCP 配置；当前任务若未发现新工具，可以使用同一服务的 CLI。**配置存在不等于应用已加载工具**。

socket 默认 `~/.dsh/codex-bridge/bridge.sock`，权限 0600；记录目录权限 0700。可用 `DSH_HOME` 或 `DSH_CODEX_BRIDGE_SOCKET` 指定路径，MCP 客户端与插件必须一致。不要在多个 DSH 进程中共用同一 socket。

## DSH 右侧栏

打开任一 DSH 会话，在右侧栏的引导页选择“Codex 桥接”。面板显示当前会话、工作目录和 DSH 工作区登记、此仓库的桥接计划和来源 Codex 任务 ID、相关 DSH 执行会话及 worktree、验收收件箱及回复。可发送新任务/问题；工作完成后填写真实摘要和 1–8 条已执行自检，提交独立验收请求。该请求在本机持久保存，由当前 Codex 任务的每分钟定时跟进读取。面板显示最近一次桌面任务核验时间和当时状态；超过两分钟标为过期，不冒充瞬时在线状态。DSH Web 需重启 Host 插件后才会读到新增心跳接口。

## 使用

向 Codex 描述目标，让它展示计划并取得你的批准。工具描述包含执行、独立复核和停止规则。可直接说：

> 在当前仓库用 DSH 实现这个功能。先列出文件范围、子任务、依赖和验收要求给我确认，完成后回到这里复核。不要发布远端。

CLI 与 MCP 共享接口；参数从 JSON 文件读取，避免 shell 插值：

```sh
node bin/bridge.mjs plan.preview /path/plan.json
node bin/bridge.mjs plan.approve /path/approval.json
node bin/bridge.mjs plan.status /path/id.json
node bin/bridge.mjs plan.wait /path/id.json
node bin/bridge.mjs plan.stop /path/id.json
```

最小计划：

```json
{
  "id": "feature-001",
  "cwd": "/absolute/repository/root",
  "goal": "实现一个已确认的功能",
  "sourceTask": "originating-codex-task-id",
  "tasks": [
    {
      "id": "implementation",
      "title": "实现功能与验证",
      "prompt": "具体要求及约束",
      "files": ["src/example.js", "test/example.test.js"],
      "acceptance": ["运行指定测试并报告结果"],
      "dependsOn": []
    }
  ]
}
```

`files` 是精确相对文件路径，或以 `/` 结尾的目录范围；不支持 glob。计划 ID 在本机桥接记录中唯一。同一 ID 不同内容会被拒绝。批准参数是 `{"id":"feature-001","hash":"预览返回的 hash"}`。`plan.status` 返回 `nextAction`、任务状态、会话、worktree、真实回复及提交证据。

可选 `delivery` 必须在批准前指定完整目标：

```json
{
  "forge": "github",
  "host": "github.com",
  "repository": "owner/repo",
  "remote": "origin",
  "targetBranch": "main"
}
```

GitLab 使用 `"forge":"gitlab"` 和实际 Web/API 主机。沿用已认证的 `gh` / `glab`，不读取或复制密钥。Git 推送目标必须与此仓库一致。没有远端配置的计划仍可本地交付。

复核须传当前 `reviewHash`、判断、反馈和证据引用。执行方自报通过不是验收依据。目标分支推进后会阻止发布，需重新集成与复核。远端创建结果不明时保留意图，不盲目创建第二份 issue/PR。草稿 PR 返回后由 Codex 附加到当前任务；用户自行决定合并。

## 从 DSH 主动请求与送审

新任务或问题可在右侧栏选“新任务 / 问题”，也可由 DSH 会话调用 `request_codex_task`，提供稳定 `requestId` 和 `summary`。Codex 主动读取收件箱后，可用 `dsh_review_respond` 回复；此处的 accepted 只代表受理，不代表代码验收或已完成任务。新的工作范围仍由 Codex 与用户确定。

在 DSH 会话完成工作和自检后调用 `request_codex_review`：提供稳定 `requestId`、`summary` 和 1–8 条具体 `checks`。桥接会记录 DSH 的真实 session ID、工作目录、Git HEAD 与变更文件指纹；重复的同一请求不再创建第二份。计划内任务还需带 `planId` / `taskId`，来源必须是该任务正在运行的 DSH 会话。

Codex 在原任务调用 `dsh_review_inbox`（参数 `cwd` 为仓库根目录），读取请求后检查实际文件和测试证据。独立 DSH 会话可用 `dsh_review_respond` 记录回复；计划内任务必须使用 `dsh_plan_review`，并沿用原修订预算。DSH 用 `check_codex_review` 查询验收结果。送审与自检均不等于 Codex 验收；由 Codex 定时跟进主动读取后，请求才会进入当前任务；本地 Codex 应用需保持运行。

## 恢复与卸载

`plan.list` 找到任务后查 `plan.status`。`unknown`、中断的准备阶段、冲突和范围越界需要检查已有文件、分支及远端事实；本版保守停止，不自动回滚或再次执行不明操作。不要删记录后重发来绕过去重。

卸载前停止活跃任务，再执行 `dsh plugin --profile web remove dsh-codex-bridge` 和 `codex mcp remove dsh-codex-bridge`。已产生的 worktree、提交、执行记录和配置备份保留，供人工处理。
