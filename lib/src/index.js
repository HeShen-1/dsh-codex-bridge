import { dirname, join } from "node:path";
import { listen, defaultSocket } from "./transport.js";
import { DshBackend } from "./dsh-backend.js";
import { Jobs, git } from "./jobs.js";
import { Plans } from "./plans.js";
import { Forge } from "./forge.js";
import { baselinePreview, baselineConfirm } from "./repository.js";
import { ReviewInbox } from "./review-inbox.js";
import { CodexHeartbeat } from "./codex-heartbeat.js";
import { registerDshTools } from "./dsh-tools.js";
const name = "dsh-codex-bridge";
const inject = [
  "sessionController",
  "workspaceController",
  "workspaceRegistry",
  "agents",
  "sessions",
  "agentDefaultModel",
  "tools",
  "connection"
];
async function apply(ctx, config = {}) {
  const socketPath = config.socketPath || defaultSocket();
  const backend = new DshBackend(ctx);
  const jobs = new Jobs(
    backend,
    config.dataDir || join(dirname(socketPath), "jobs")
  );
  const plans = new Plans(jobs, join(dirname(socketPath), "plans"), {
    maxParallel: config.maxParallel ?? 2,
    forge: new Forge()
  });
  const inbox = new ReviewInbox(join(dirname(socketPath), "reviews"), plans);
  const heartbeat = new CodexHeartbeat(null, join(dirname(socketPath), "codex-heartbeat"));
  registerDshTools(ctx, inbox, plans);
  const browserRequest = async (endpoint, payload) => {
    try {
      if (!payload || typeof payload !== "object" || !/^[a-zA-Z0-9_-]{1,100}$/.test(payload.sessionId || ""))
        throw new Error("A DSH session ID is required");
      const inspection = await ctx.sessionController.inspect(payload.sessionId);
      const cwd = inspection.meta?.cwd;
      if (!cwd) throw new Error("DSH session has no working directory");
      if (endpoint === "snapshot") {
        const allPlans = await plans.list();
        const repositoryReady = await git(cwd, "rev-parse", "--verify", "HEAD").then(() => true, () => false);
        const ownedWorkspace = await ctx.workspaceRegistry.resolveByPath(cwd);
        const workspace = ownedWorkspace?.sessionIds.includes(payload.sessionId) ? ownedWorkspace : null;
        const related = allPlans.filter((p) => p.cwd === cwd || p.tasks?.some((t) => t.worktree?.path === cwd));
        return { ok: true, value: {
          session: {
            id: payload.sessionId,
            cwd,
            workspace: workspace ? { id: workspace.id, title: workspace.title, path: workspace.path } : null
          },
          plans: related.map((p) => ({
            id: p.id,
            goal: p.goal,
            state: p.state,
            sourceTask: p.sourceTask || null,
            tasks: p.tasks.map((t) => ({
              id: t.id,
              title: t.title,
              state: t.state,
              sessionId: t.execution?.sessionId || null,
              cwd: t.worktree?.path || null
            }))
          })),
          requests: repositoryReady ? await inbox.list({ cwd }) : [],
          repositoryReady,
          codexHeartbeat: repositoryReady ? await heartbeat.getStatus({ cwd }) : null
        } };
      }
      if (endpoint === "request-review") {
        const item = await inbox.submit(payload, { sessionId: payload.sessionId, cwd });
        return { ok: true, value: { id: item.id, state: item.state } };
      }
      return { ok: false, error: { code: "UNKNOWN_ENDPOINT", message: "Unknown bridge endpoint", details: {} } };
    } catch (error) {
      return { ok: false, error: {
        code: error.code || "BRIDGE_ERROR",
        message: error.message,
        details: {}
      } };
    }
  };
  ctx.effect(() => ctx.connection.fetch.register({
    path: "/api/codex-bridge",
    methods: ["POST"],
    requestBody: "buffered",
    async fetch(request) {
      try {
        const body = await request.json();
        return Response.json(await browserRequest(body.endpoint, body.payload));
      } catch (error) {
        return Response.json({ ok: false, error: {
          code: "INVALID_REQUEST",
          message: error.message,
          details: {}
        } }, { status: 400 });
      }
    }
  }));
  const close = await listen(socketPath, async (method, params) => {
    if (method === "hello")
      return {
        name,
        version: "0.5.0",
        build: config.build,
        transport: "unix",
        model: await backend.model(),
        capabilities: [
          "baseline.preview",
          "baseline.confirm",
          "plan.preview",
          "plan.approve",
          "plan.status",
          "plan.wait",
          "plan.review",
          "plan.steer",
          "plan.stop",
          "plan.list",
          "plan.deliver",
          "review.list",
          "review.status",
          "review.respond",
          "codex.status",
          "codex.report"
        ]
      };
    if (method === "codex.status") return heartbeat.getStatus(params);
    if (method === "codex.report") return heartbeat.report(params);
    if (method === "baseline.preview") return baselinePreview(params);
    if (method === "baseline.confirm") return baselineConfirm(params);
    if (["review.list", "review.status", "review.respond"].includes(method))
      return inbox[method.slice(7)](params);
    if (method.startsWith("plan.") && [
      "preview",
      "approve",
      "status",
      "wait",
      "review",
      "steer",
      "stop",
      "list",
      "deliver"
    ].includes(method.slice(5)))
      return plans[method.slice(5)](params);
    throw new Error(
      "Unknown bridge method; task execution requires an approved plan"
    );
  });
  let stopScheduler = () => {
  };
  ctx.effect(() => async () => {
    stopScheduler();
    jobs.stopping = true;
    await close();
  });
  await plans.recover();
  stopScheduler = plans.start();
}
export {
  apply,
  inject,
  name
};
