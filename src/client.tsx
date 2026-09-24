import { useEffect, useRef, useState } from "react";

type Review = {
  id: string;
  sessionId: string;
  summary: string;
  checks: string[];
  kind?: "review" | "task";
  state: string;
  createdAt: string;
  planId?: string | null;
  taskId?: string | null;
  response?: { accepted: boolean; feedback: string; evidence: string[] };
};
type BridgeSnapshot = {
  session: { id: string; cwd: string; workspace: { id: string; title: string; path: string } | null };
  codexHeartbeat: { threadId: string; taskStatus: string; checkedAt: string } | null;
  repositoryReady: boolean;
  plans: Array<{
    id: string; goal: string; state: string; sourceTask: string | null;
    tasks: Array<{ id: string; title: string; state: string; sessionId: string | null; cwd: string | null }>;
  }>;
  requests: Review[];
};
type RpcResult = { ok: true; value: unknown } | { ok: false; error: { message: string } };
type ClientContext = {
  effect(register: () => unknown, label?: string): void;
  sidebarRightTabs: { register(definition: object): () => void };
  slots: {
    inject(name: string, register: () => void): void;
    register(definition: object, component: unknown): void;
  };
};
type TabProps = { sessionId?: string; useTabInfo?: () => { tab: { visible: boolean } } };

const ID = "dsh-codex-bridge";
const KIND = "codex-bridge";
export const name = ID;
export const inject = ["sidebarRightTabs", "slots"];

async function call(endpoint: string, payload: unknown): Promise<RpcResult> {
  const response = await fetch("/api/codex-bridge", {
    method: "POST", headers: { "Content-Type": "application/json" },
    credentials: "same-origin", body: JSON.stringify({ endpoint, payload }),
  });
  if (!response.ok) throw new Error(`DSH API ${response.status}`);
  return response.json() as Promise<RpcResult>;
}

function BridgeBody({ sessionId, useTabInfo }: TabProps) {
  const visible = useTabInfo?.().tab.visible ?? true;
  const [data, setData] = useState<BridgeSnapshot | null>(null);
  const [error, setError] = useState("");
  const [kind, setKind] = useState<"review" | "task">("task");
  const [summary, setSummary] = useState("");
  const [checks, setChecks] = useState("");
  const [sending, setSending] = useState(false);
  const retry = useRef<{ key: string; id: string } | null>(null);

  async function load() {
    if (!sessionId) return;
    try {
      const result = await call("snapshot", { sessionId });
      if (result.ok === false) throw new Error(result.error.message);
      setData(result.value as BridgeSnapshot);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  useEffect(() => {
    if (!visible || !sessionId) return;
    void load();
    const timer = window.setInterval(() => { void load(); }, 4000);
    return () => window.clearInterval(timer);
  }, [visible, sessionId]);

  async function send() {
    if (!sessionId) return;
    const items = checks.split("\n").map((x) => x.trim()).filter(Boolean);
    const trimmed = summary.trim();
    if (!trimmed || (kind === "review" && (items.length < 1 || items.length > 8))) {
      setError(kind === "review" ? "请填写完成摘要和 1–8 条已执行的自检结果。" : "请填写请求内容。");
      return;
    }
    const key = JSON.stringify([kind, trimmed, kind === "review" ? items : []]);
    if (retry.current?.key !== key)
      retry.current = { key, id: crypto.randomUUID() };
    setSending(true);
    try {
      const assigned = data?.plans.flatMap((plan) => plan.tasks.map((task) =>
        ({ planId: plan.id, taskId: task.id, sessionId: task.sessionId })))
        .find((task) => task.sessionId === sessionId);
      const result = await call("request-review", {
        sessionId, requestId: retry.current.id, summary: trimmed, checks: kind === "review" ? items : [], kind,
        ...(assigned ? { planId: assigned.planId, taskId: assigned.taskId } : {}),
      });
      if (result.ok === false) throw new Error(result.error.message);
      setSummary("");
      setChecks("");
      retry.current = null;
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  }

  return <div className="dcb-panel">
    <header className="dcb-header"><strong>Codex 桥接</strong><button onClick={() => void load()}>刷新</button></header>
    <p className="dcb-note">请求存入本机收件箱；Codex 每分钟定时检查。桌面状态是最近核验结果，不是实时连接。</p>
    {error && <p className="dcb-error" role="alert">{error}</p>}
    {data && <>
      <section><h3>Codex 桌面任务核验</h3>
        {data.codexHeartbeat ? <p>任务：{data.codexHeartbeat.threadId}<br />
          最近核验：{new Date(data.codexHeartbeat.checkedAt).toLocaleString()}<br />
          {Date.now() - Date.parse(data.codexHeartbeat.checkedAt) > 120000 ? "状态已过期，请检查定时任务" : `核验时状态：${data.codexHeartbeat.taskStatus}`}</p>
          : <p className="dcb-muted">尚无 Codex 核验记录。</p>}
      </section>
      <section><h3>当前 DSH 会话</h3>
        <dl><dt>会话</dt><dd>{data.session.id}</dd><dt>工作目录</dt><dd>{data.session.cwd}</dd>
          <dt>工作区</dt><dd>{data.session.workspace ? <>{data.session.workspace.title}<br />{data.session.workspace.id}</> : "未登记到 DSH 工作区"}</dd></dl>
      </section>
      {!data.repositoryReady && <p className="dcb-error">当前目录还没有 Git 初始提交；请先确认基线，之后才能送审或执行桥接任务。</p>}
      <section><h3>桥接计划与任务</h3>
        {data.plans.length === 0 ? <p className="dcb-muted">此仓库暂无桥接计划。</p> : data.plans.map((plan) =>
          <article key={plan.id} className="dcb-card"><strong>{plan.goal}</strong>
            <p>{plan.id} · {plan.state}</p>
            <p>来源 Codex 任务：{plan.sourceTask || "未记录"}</p>
            {plan.tasks.map((task) => <div key={task.id} className="dcb-task">
              <b>{task.title}</b> · {task.state}<br />
              DSH 会话：{task.sessionId || "未创建"}<br />
              工作目录：{task.cwd || "未创建"}
            </div>)}
          </article>)}
      </section>
      <section><h3>请求与验收收件箱</h3>
        {data.requests.length === 0 ? <p className="dcb-muted">没有请求。</p> : [...data.requests].reverse().map((item) =>
          <details key={item.id} className="dcb-card">
            <summary><strong>{item.kind === "task" ? "请求" : "验收"} · {item.summary.slice(0, 100)}{item.summary.length > 100 ? "…" : ""}</strong><br />{item.state} · {new Date(item.createdAt).toLocaleString()}</summary>
            {item.summary.length > 100 && <p>完整内容：{item.summary}</p>}
            <p>DSH 会话：{item.sessionId}</p>
            <ul>{item.checks.map((check, i) => <li key={i}>{check}</li>)}</ul>
            {item.response && <p>Codex 回复：{item.response.accepted ? (item.kind === "task" ? "已受理" : "验收通过") : "退回"} · {item.response.feedback}</p>}
            {item.planId && <p>计划任务：{item.planId} / {item.taskId}</p>}
          </details>)}
      </section>
    </>}
    <section><h3>向 Codex 发请求</h3>
      <p className="dcb-muted">请求进入本机收件箱，需 Codex 主动读取；送达不等于受理或验收。</p>
      <label>请求类型<select value={kind} onChange={(e) => { setKind(e.target.value as "review" | "task"); retry.current = null; }}><option value="task">新任务 / 问题</option><option value="review">完成后申请验收</option></select></label>
      <label>{kind === "review" ? "完成摘要" : "请求内容"}<textarea value={summary} maxLength={2000} onChange={(e) => setSummary(e.target.value)} /></label>
      {kind === "review" && <label>自检结果（每行一条，最多 8 条）<textarea value={checks} onChange={(e) => setChecks(e.target.value)} /></label>}
      <button disabled={sending || !sessionId || data?.repositoryReady === false} onClick={() => void send()}>{sending ? "提交中…" : kind === "review" ? "提交验收请求" : "发送新请求"}</button>
    </section>
  </div>;
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: ID, kind: KIND, title: () => "Codex 桥接",
    guide: [{ id: ID, order: 40, title: () => "Codex 桥接", description: () => "任务、会话与双向请求" }],
  }), "codex-bridge tab");
  ctx.effect(() => {
    const style = document.createElement("style");
    style.textContent = `.dcb-panel{padding:16px;overflow:auto;height:100%;font:inherit;color:inherit}.dcb-header{display:flex;align-items:center;justify-content:space-between}.dcb-panel section{border-top:1px solid var(--border-color,#7774);margin-top:16px;padding-top:12px}.dcb-panel h3{font-size:14px;margin:0 0 10px}.dcb-panel p{margin:6px 0;overflow-wrap:anywhere}.dcb-panel dl{display:grid;grid-template-columns:76px 1fr;gap:6px;font-size:12px}.dcb-panel dd{margin:0;overflow-wrap:anywhere}.dcb-card{border:1px solid var(--border-color,#7774);border-radius:8px;padding:10px;margin:8px 0}.dcb-card summary{cursor:pointer;font-size:12px;overflow-wrap:anywhere}.dcb-card summary strong{font-size:13px}.dcb-task{padding:6px 0;border-top:1px solid var(--border-color,#7774);font-size:12px;overflow-wrap:anywhere}.dcb-note,.dcb-muted{opacity:.72;font-size:12px}.dcb-error{color:#b34040}.dcb-panel label{display:block;font-size:12px;margin:10px 0}.dcb-panel select{display:block;width:100%;margin-top:5px;background:transparent;color:inherit;border:1px solid var(--border-color,#7777);border-radius:6px;padding:7px}.dcb-panel textarea{display:block;width:100%;min-height:70px;box-sizing:border-box;margin-top:5px;background:transparent;color:inherit;border:1px solid var(--border-color,#7777);border-radius:6px;padding:7px;font:inherit}.dcb-panel button{border:1px solid var(--border-color,#7777);border-radius:6px;background:transparent;color:inherit;padding:6px 10px;cursor:pointer}.dcb-panel button:disabled{opacity:.5;cursor:default}`;
    document.head.append(style);
    return () => style.remove();
  }, "codex-bridge styles");
  ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () =>
    ctx.slots.register({ name: "sidebar.right.pane.tab", key: ID },
      (props: TabProps) => <BridgeBody {...props} />)
  ), "codex-bridge body");
}
