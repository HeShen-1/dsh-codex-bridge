# dsh-codex-bridge

DSH ⇄ Codex 桥: Codex 规划, DeepSeek 执行, 两边可以互相讨论。

走 **Codex app-server JSON-RPC 协议**(`codex app-server`, 协议有官方 schema 可生成),
不是 MCP, 不是 `codex exec`, 不碰私有 socket。设计与证据见 [docs/DESIGN.md](docs/DESIGN.md)。

## 状态

Skeleton / v0.1 — 设计已定型, 协议常量全部从生成 schema 固化。实现进度:

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | client 握手 + Thread/start + Turn/start + 收文本 | 已写, 待实测 |
| P1 | `codex_plan` / `codex_ask` 工具 | 已写, 待实测 |
| P2 | 实时计划 + `codex_steer` | 接口已定义, 行为待接 |
| P3 | `mode: daemon` 接桌面端 | 参数已支持, 未联调 |
| P4 | 审批转 DSH 提问 + GUI 面板 + 审计 | 未开始 |

## 四个工具

| 工具 | 作用 | 关键参数 |
|---|---|---|
| `codex_plan` | 让 Codex 只出计划, 不执行 | `prompt`, `cwd?` |
| `codex_ask` | 自由问答 / 让 Codex 复核 | `prompt`, `cwd?` |
| `codex_steer` | 对正在跑的 turn 插话 | `threadId`, `turnId`, `message` |
| `codex_status` | 桥状态 / 线程列表 | `listThreads?` |

Codex 在这条桥上永远以 `sandbox: read-only` + `approvalPolicy: never` 运行:
它只能看和说, 不能写。计划回到 DSH 后, 写不写由 DSH 侧决定。

## 安装(三步)

1. 复制并链接插件:
   ```bash
   cp -r dsh-codex-bridge ~/.dsh/local-plugins/
   ln -s ../../../local-plugins/dsh-codex-bridge ~/.dsh/profiles/web/node_modules/dsh-codex-bridge
   ```
2. 链接两个运行时依赖(`dsh-tools`, `schemastery`), 命令见 [cordis.patch.yml](cordis.patch.yml) 顶部注释。
3. 在 `~/.dsh/profiles/web/cordis.patch.yml` 追加 mount 行, 见 [cordis.patch.yml](cordis.patch.yml) 末尾。

`mode` 选择:

- `private`(默认): 插件自己 spawn `codex app-server`, Codex 会话不出现在桌面端。
- `daemon`: 走 `codex app-server proxy --sock $CODEX_HOME/app-server-control/app-server-control.sock`,
  接入桌面端正在跑的 daemon, 会话在 Codex GUI 可见 → **讨论/围观模式用这个**。

## 验证

```bash
node test/verify.mjs            # 静态自检: ESM 语法 + 清单 + 协议常量 (37 项)
node test/verify.mjs --schema <schema目录>   # 追加: 与生成的 schema 交叉核对
node test/load.mjs              # 工具定义自检, 需要能解析 @deepseek-ai/dsh-tools
node test/smoke.mjs             # 握手 + Thread/list
node test/smoke.mjs --turn      # 跑一个只读 turn, 断言回复含 BRIDGE_OK
bash scripts/check-protocol.sh  # Codex 升级后跑, 检查协议是否漂移
```

当前状态(2026-09-23): `test/verify.mjs --schema` 全绿 37 项; `scripts/check-protocol.sh`
对 Codex 0.154.0 全绿(9 methods + 5 notifications)。
`test/smoke.mjs` 与 `test/load.mjs` 尚未在 DSH 宿主进程里跑过 —— 见「下一步」。

**必须在普通 shell 里跑**, 不要在 DSH 的沙箱 bash 工具里跑:
沙箱内 `codex app-server` 无法写 `$CODEX_HOME`, 启动即失败
(`failed to initialize sqlite state runtime under /home/river/.codex`)。
本工作区本身是 FUSE 只读挂载(`portal on /run/user/1000/doc type fuse.portal (ro…)`),
`bwrap` 也无法 bind mount 它, 所以 DSH 沙箱里连 `node --check` 都可能报
`sandbox mode "workspace-write" is requested but no sandbox backend is usable`。

## 下一步(P0 收尾)

1. 按 `cordis.patch.yml` 顶部注释链接插件与两个依赖。
2. 在普通 shell 里跑 `node test/load.mjs` → 确认 `dsh-tools` 能解析、四个工具注册成功。
3. `node test/smoke.mjs --turn` → 确认 `BRIDGE_OK`。
4. 把 mount 行加进 `~/.dsh/profiles/web/cordis.patch.yml`, 重启 DSH, 在对话里调 `codex_status`。


## 已知约束

1. app-server 协议标 `[experimental]`; 升级 Codex 后先跑 `scripts/check-protocol.sh`。
2. 桥必须跑在 DSH 宿主进程内, 不能经由沙箱 bash 调用。
3. 桌面端只在启动时读 `config.toml`; 若给 Codex 侧加 MCP server 需重启桌面端。
4. MVP 策略: 一律拒绝 Codex 发来的审批请求(安全默认), 后续改为转成 DSH 的提问。
