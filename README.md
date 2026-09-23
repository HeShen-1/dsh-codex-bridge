# DSH Codex Bridge

Codex 桌面端规划与复核，DSH 实施与验证。个人同机插件，使用 Git worktree 隔离任务；模型和推理设置完全由用户在两端管理。

## 当前能力

- 预览计划 → 一次批准目标、文件范围、验收及可选远端交付 → DSH 执行 → Codex 独立复核。
- 每个子任务独立 worktree；默认同一计划最多 2 个并行执行。依赖任务等待前置复核通过。多任务计划自动增加组合后的集成验证。
- 没有 Git 就初始化；首次提交需要确认文件清单和内容指纹。原目录未提交修改保持原样，worktree 基于已提交 HEAD。
- 稳定任务 ID 和 DSH requestId 去重；持久保存派发意图，未知执行状态先查证，禁止盲目重发。
- 支持插话、整项计划或单子任务停止；确认 DSH 空闲后才标记停止。
- 首次实施后整个计划最多 3 次自动修订；连续两次同类阻塞无进展即停。不会通过换任务 ID 重置限制。
- GitHub / GitLab 可选 issue、任务分支推送、草稿 PR/MR；不合并，不自动创建远端仓库。
- DSH 审批仍遵守其原有策略；桥接状态会显示待审批。到 DSH 回答后继续，或在 Codex 停止任务。插件不会自动批准完整访问权限。

实现与验证等级见 [docs/VALIDATION.md](docs/VALIDATION.md)。第三方平台的真实发布、桌面 MCP 工具自动发现和 UI 可见性分别记录，不能由本地测试替代。

## 连接方式

```text
Codex 当前桌面任务
  └─ MCP 工具（或本任务中的 CLI）
       └─ 当前用户私有 Unix socket
            └─ DSH Web profile 内的桥接插件
                 └─ SessionController / Agent / Git worktree
```

Codex 的结果通过当前工具调用返回原任务。无需另建 Codex 会话、启动 Codex app-server、使用桌面私有 IPC 或写两端私有会话存储。

桥接记录按任务关联执行身份，不把一个 Codex 会话固定绑定一个 DSH 会话。两端可继续用原有 UI；插件不替换它们。Codex 必须保持协调轮次，通过 `dsh_plan_wait` 等待和复核；关闭或结束 Codex 任务后，插件不会自行唤醒模型或伪造用户消息。

## 本机安装

需要 Node >=22.16、Git、已启动的 DSH Web profile。本版对 DSH `0.1.7-alpha.2` 的 SessionController / WorkspaceController API 做过运行验证；其他版本先核对接口。

```sh
npm test
node scripts/install-local.mjs
node bin/bridge.mjs hello
codex mcp add dsh-codex-bridge -- node /absolute/path/dsh-codex-bridge/bin/mcp.mjs
```

安装器只替换 profile 中带标记的桥接挂载块，并保存配置备份；源代码复制为不可变版本路径以避免 ESM 缓存残留。profile 必须启用 `patchReload: live`。更新前先完成或明确停止活跃桥接计划。没有自动重启 DSH 的后备路径。

Codex 安装后需要让应用重新加载 MCP 配置；当前任务若未发现新工具，可以使用同一服务的 CLI。**配置存在不等于应用已加载工具**。

socket 默认 `~/.dsh/codex-bridge/bridge.sock`，权限 0600；记录目录权限 0700。可用 `DSH_HOME` 或 `DSH_CODEX_BRIDGE_SOCKET` 指定路径，MCP 客户端与插件必须一致。不要在多个 DSH 进程中共用同一 socket。

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

## 恢复与卸载

`plan.list` 找到任务后查 `plan.status`。`unknown`、中断的准备阶段、冲突和范围越界需要检查已有文件、分支及远端事实；本版保守停止，不自动回滚或再次执行不明操作。不要删记录后重发来绕过去重。

卸载前停止活跃任务，再移除 profile 中 `BEGIN/END dsh-codex-bridge managed mount` 块，并执行 `codex mcp remove dsh-codex-bridge`。已产生的 worktree、提交、执行记录和配置备份保留，供人工处理。
