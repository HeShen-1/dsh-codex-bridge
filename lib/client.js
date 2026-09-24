window.__ModuleLoader__.load({id:"dsh-codex-bridge",factory:(require)=>{var module={exports:{}};var exports=module.exports;var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client.tsx
var client_exports = {};
__export(client_exports, {
  apply: () => apply,
  inject: () => inject,
  name: () => name
});
module.exports = __toCommonJS(client_exports);
var import_react = require("react");
var import_jsx_runtime = require("react/jsx-runtime");
var ID = "dsh-codex-bridge";
var KIND = "codex-bridge";
var name = ID;
var inject = ["sidebarRightTabs", "slots"];
async function call(endpoint, payload) {
  const response = await fetch("/api/codex-bridge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ endpoint, payload })
  });
  if (!response.ok) throw new Error(`DSH API ${response.status}`);
  return response.json();
}
function BridgeBody({ sessionId, useTabInfo }) {
  const visible = useTabInfo?.().tab.visible ?? true;
  const [data, setData] = (0, import_react.useState)(null);
  const [error, setError] = (0, import_react.useState)("");
  const [kind, setKind] = (0, import_react.useState)("task");
  const [summary, setSummary] = (0, import_react.useState)("");
  const [checks, setChecks] = (0, import_react.useState)("");
  const [sending, setSending] = (0, import_react.useState)(false);
  const retry = (0, import_react.useRef)(null);
  async function load() {
    if (!sessionId) return;
    try {
      const result = await call("snapshot", { sessionId });
      if (result.ok === false) throw new Error(result.error.message);
      setData(result.value);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  (0, import_react.useEffect)(() => {
    if (!visible || !sessionId) return;
    void load();
    const timer = window.setInterval(() => {
      void load();
    }, 4e3);
    return () => window.clearInterval(timer);
  }, [visible, sessionId]);
  async function send() {
    if (!sessionId) return;
    const items = checks.split("\n").map((x) => x.trim()).filter(Boolean);
    const trimmed = summary.trim();
    if (!trimmed || kind === "review" && (items.length < 1 || items.length > 8)) {
      setError(kind === "review" ? "\u8BF7\u586B\u5199\u5B8C\u6210\u6458\u8981\u548C 1\u20138 \u6761\u5DF2\u6267\u884C\u7684\u81EA\u68C0\u7ED3\u679C\u3002" : "\u8BF7\u586B\u5199\u8BF7\u6C42\u5185\u5BB9\u3002");
      return;
    }
    const key = JSON.stringify([kind, trimmed, kind === "review" ? items : []]);
    if (retry.current?.key !== key)
      retry.current = { key, id: crypto.randomUUID() };
    setSending(true);
    try {
      const assigned = data?.plans.flatMap((plan) => plan.tasks.map((task) => ({ planId: plan.id, taskId: task.id, sessionId: task.sessionId }))).find((task) => task.sessionId === sessionId);
      const result = await call("request-review", {
        sessionId,
        requestId: retry.current.id,
        summary: trimmed,
        checks: kind === "review" ? items : [],
        kind,
        ...assigned ? { planId: assigned.planId, taskId: assigned.taskId } : {}
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
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dcb-panel", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("header", { className: "dcb-header", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: "Codex \u6865\u63A5" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { onClick: () => void load(), children: "\u5237\u65B0" })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dcb-note", children: "\u8BF7\u6C42\u5B58\u5165\u672C\u673A\u6536\u4EF6\u7BB1\uFF1BCodex \u6BCF\u5206\u949F\u5B9A\u65F6\u68C0\u67E5\u3002\u684C\u9762\u72B6\u6001\u662F\u6700\u8FD1\u6838\u9A8C\u7ED3\u679C\uFF0C\u4E0D\u662F\u5B9E\u65F6\u8FDE\u63A5\u3002" }),
    error && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dcb-error", role: "alert", children: error }),
    data && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { children: "Codex \u684C\u9762\u4EFB\u52A1\u6838\u9A8C" }),
        data.codexHeartbeat ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { children: [
          "\u4EFB\u52A1\uFF1A",
          data.codexHeartbeat.threadId,
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("br", {}),
          "\u6700\u8FD1\u6838\u9A8C\uFF1A",
          new Date(data.codexHeartbeat.checkedAt).toLocaleString(),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("br", {}),
          Date.now() - Date.parse(data.codexHeartbeat.checkedAt) > 12e4 ? "\u72B6\u6001\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u68C0\u67E5\u5B9A\u65F6\u4EFB\u52A1" : `\u6838\u9A8C\u65F6\u72B6\u6001\uFF1A${data.codexHeartbeat.taskStatus}`
        ] }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dcb-muted", children: "\u5C1A\u65E0 Codex \u6838\u9A8C\u8BB0\u5F55\u3002" })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { children: "\u5F53\u524D DSH \u4F1A\u8BDD" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("dl", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("dt", { children: "\u4F1A\u8BDD" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("dd", { children: data.session.id }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("dt", { children: "\u5DE5\u4F5C\u76EE\u5F55" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("dd", { children: data.session.cwd }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("dt", { children: "\u5DE5\u4F5C\u533A" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("dd", { children: data.session.workspace ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
            data.session.workspace.title,
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("br", {}),
            data.session.workspace.id
          ] }) : "\u672A\u767B\u8BB0\u5230 DSH \u5DE5\u4F5C\u533A" })
        ] })
      ] }),
      !data.repositoryReady && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dcb-error", children: "\u5F53\u524D\u76EE\u5F55\u8FD8\u6CA1\u6709 Git \u521D\u59CB\u63D0\u4EA4\uFF1B\u8BF7\u5148\u786E\u8BA4\u57FA\u7EBF\uFF0C\u4E4B\u540E\u624D\u80FD\u9001\u5BA1\u6216\u6267\u884C\u6865\u63A5\u4EFB\u52A1\u3002" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { children: "\u6865\u63A5\u8BA1\u5212\u4E0E\u4EFB\u52A1" }),
        data.plans.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dcb-muted", children: "\u6B64\u4ED3\u5E93\u6682\u65E0\u6865\u63A5\u8BA1\u5212\u3002" }) : data.plans.map((plan) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("article", { className: "dcb-card", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: plan.goal }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { children: [
            plan.id,
            " \xB7 ",
            plan.state
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { children: [
            "\u6765\u6E90 Codex \u4EFB\u52A1\uFF1A",
            plan.sourceTask || "\u672A\u8BB0\u5F55"
          ] }),
          plan.tasks.map((task) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dcb-task", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("b", { children: task.title }),
            " \xB7 ",
            task.state,
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("br", {}),
            "DSH \u4F1A\u8BDD\uFF1A",
            task.sessionId || "\u672A\u521B\u5EFA",
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("br", {}),
            "\u5DE5\u4F5C\u76EE\u5F55\uFF1A",
            task.cwd || "\u672A\u521B\u5EFA"
          ] }, task.id))
        ] }, plan.id))
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { children: "\u8BF7\u6C42\u4E0E\u9A8C\u6536\u6536\u4EF6\u7BB1" }),
        data.requests.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dcb-muted", children: "\u6CA1\u6709\u8BF7\u6C42\u3002" }) : [...data.requests].reverse().map((item) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("details", { className: "dcb-card", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("summary", { children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("strong", { children: [
              item.kind === "task" ? "\u8BF7\u6C42" : "\u9A8C\u6536",
              " \xB7 ",
              item.summary.slice(0, 100),
              item.summary.length > 100 ? "\u2026" : ""
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("br", {}),
            item.state,
            " \xB7 ",
            new Date(item.createdAt).toLocaleString()
          ] }),
          item.summary.length > 100 && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { children: [
            "\u5B8C\u6574\u5185\u5BB9\uFF1A",
            item.summary
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { children: [
            "DSH \u4F1A\u8BDD\uFF1A",
            item.sessionId
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", { children: item.checks.map((check, i) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("li", { children: check }, i)) }),
          item.response && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { children: [
            "Codex \u56DE\u590D\uFF1A",
            item.response.accepted ? item.kind === "task" ? "\u5DF2\u53D7\u7406" : "\u9A8C\u6536\u901A\u8FC7" : "\u9000\u56DE",
            " \xB7 ",
            item.response.feedback
          ] }),
          item.planId && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { children: [
            "\u8BA1\u5212\u4EFB\u52A1\uFF1A",
            item.planId,
            " / ",
            item.taskId
          ] })
        ] }, item.id))
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { children: "\u5411 Codex \u53D1\u8BF7\u6C42" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dcb-muted", children: "\u8BF7\u6C42\u8FDB\u5165\u672C\u673A\u6536\u4EF6\u7BB1\uFF0C\u9700 Codex \u4E3B\u52A8\u8BFB\u53D6\uFF1B\u9001\u8FBE\u4E0D\u7B49\u4E8E\u53D7\u7406\u6216\u9A8C\u6536\u3002" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { children: [
        "\u8BF7\u6C42\u7C7B\u578B",
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("select", { value: kind, onChange: (e) => {
          setKind(e.target.value);
          retry.current = null;
        }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "task", children: "\u65B0\u4EFB\u52A1 / \u95EE\u9898" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "review", children: "\u5B8C\u6210\u540E\u7533\u8BF7\u9A8C\u6536" })
        ] })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { children: [
        kind === "review" ? "\u5B8C\u6210\u6458\u8981" : "\u8BF7\u6C42\u5185\u5BB9",
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("textarea", { value: summary, maxLength: 2e3, onChange: (e) => setSummary(e.target.value) })
      ] }),
      kind === "review" && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { children: [
        "\u81EA\u68C0\u7ED3\u679C\uFF08\u6BCF\u884C\u4E00\u6761\uFF0C\u6700\u591A 8 \u6761\uFF09",
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("textarea", { value: checks, onChange: (e) => setChecks(e.target.value) })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { disabled: sending || !sessionId || data?.repositoryReady === false, onClick: () => void send(), children: sending ? "\u63D0\u4EA4\u4E2D\u2026" : kind === "review" ? "\u63D0\u4EA4\u9A8C\u6536\u8BF7\u6C42" : "\u53D1\u9001\u65B0\u8BF7\u6C42" })
    ] })
  ] });
}
function apply(ctx) {
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: ID,
    kind: KIND,
    title: () => "Codex \u6865\u63A5",
    guide: [{ id: ID, order: 40, title: () => "Codex \u6865\u63A5", description: () => "\u4EFB\u52A1\u3001\u4F1A\u8BDD\u4E0E\u53CC\u5411\u8BF7\u6C42" }]
  }), "codex-bridge tab");
  ctx.effect(() => {
    const style = document.createElement("style");
    style.textContent = `.dcb-panel{padding:16px;overflow:auto;height:100%;font:inherit;color:inherit}.dcb-header{display:flex;align-items:center;justify-content:space-between}.dcb-panel section{border-top:1px solid var(--border-color,#7774);margin-top:16px;padding-top:12px}.dcb-panel h3{font-size:14px;margin:0 0 10px}.dcb-panel p{margin:6px 0;overflow-wrap:anywhere}.dcb-panel dl{display:grid;grid-template-columns:76px 1fr;gap:6px;font-size:12px}.dcb-panel dd{margin:0;overflow-wrap:anywhere}.dcb-card{border:1px solid var(--border-color,#7774);border-radius:8px;padding:10px;margin:8px 0}.dcb-card summary{cursor:pointer;font-size:12px;overflow-wrap:anywhere}.dcb-card summary strong{font-size:13px}.dcb-task{padding:6px 0;border-top:1px solid var(--border-color,#7774);font-size:12px;overflow-wrap:anywhere}.dcb-note,.dcb-muted{opacity:.72;font-size:12px}.dcb-error{color:#b34040}.dcb-panel label{display:block;font-size:12px;margin:10px 0}.dcb-panel select{display:block;width:100%;margin-top:5px;background:transparent;color:inherit;border:1px solid var(--border-color,#7777);border-radius:6px;padding:7px}.dcb-panel textarea{display:block;width:100%;min-height:70px;box-sizing:border-box;margin-top:5px;background:transparent;color:inherit;border:1px solid var(--border-color,#7777);border-radius:6px;padding:7px;font:inherit}.dcb-panel button{border:1px solid var(--border-color,#7777);border-radius:6px;background:transparent;color:inherit;padding:6px 10px;cursor:pointer}.dcb-panel button:disabled{opacity:.5;cursor:default}`;
    document.head.append(style);
    return () => style.remove();
  }, "codex-bridge styles");
  ctx.effect(() => ctx.slots.inject(
    "sidebar.right.pane.tab",
    () => ctx.slots.register(
      { name: "sidebar.right.pane.tab", key: ID },
      (props) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(BridgeBody, { ...props })
    )
  ), "codex-bridge body");
}

return module.exports;}});
