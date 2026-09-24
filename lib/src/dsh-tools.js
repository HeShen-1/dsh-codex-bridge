import { realpath } from "node:fs/promises";
import { fail } from "./jobs.js";
function owner(exec) {
  const sessionId = exec.agent?.session?.id;
  const cwd = exec.agent?.session?.header?.cwd;
  if (!sessionId || !cwd)
    fail(
      "NO_DSH_SESSION",
      "A DSH session with a working directory is required"
    );
  return { sessionId: String(sessionId), cwd };
}
function registerDshTools(ctx, inbox, plans) {
  ctx.tools.register({
    name: "request_codex_review",
    description: "After completing work and self-checks, send a durable review request from this DSH session to the Codex bridge inbox. Codex independently inspects the actual files; this tool does not approve them or wake an ended Codex task. Use a stable requestId on retries. For a bridge-managed task, also provide planId and taskId.",
    parameters: {
      type: "object",
      properties: {
        requestId: { type: "string" },
        summary: { type: "string" },
        checks: { type: "array", items: { type: "string" } },
        planId: { type: "string" },
        taskId: { type: "string" }
      },
      required: ["requestId", "summary", "checks"],
      additionalProperties: false
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }]
    },
    async execute(args, exec) {
      if (exec.signal.aborted) throw exec.signal.reason;
      const item = await inbox.submit(args, owner(exec));
      return JSON.stringify({
        id: item.id,
        state: item.state,
        fingerprint: item.fingerprint
      });
    }
  });
  ctx.tools.register({
    name: "request_codex_task",
    description: "Send a new task or question from this DSH session to the durable Codex inbox. Codex must actively read and decide whether to handle it; this does not wake a desktop task or authorize work. Use a stable requestId on retries. A bridge-managed worker must include its planId and taskId.",
    parameters: {
      type: "object",
      properties: {
        requestId: { type: "string" },
        summary: { type: "string" },
        planId: { type: "string" },
        taskId: { type: "string" }
      },
      required: ["requestId", "summary"],
      additionalProperties: false
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }]
    },
    async execute(args, exec) {
      if (exec.signal.aborted) throw exec.signal.reason;
      const item = await inbox.submit({ ...args, kind: "task" }, owner(exec));
      return JSON.stringify({ id: item.id, state: item.state });
    }
  });
  for (const name of ["check_codex_review", "check_codex_request"])
    ctx.tools.register({
      name,
      description: "Read Codex's response to a request from this same DSH session. A task request accepted by Codex means it was taken up, not that code passed review. Managed plan reviews follow plan.review and its repair limits.",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false
      },
      output: {
        schema: { type: "string" },
        render: (_args, value) => [{ type: "text", text: value }]
      },
      async execute(args, exec) {
        if (exec.signal.aborted) throw exec.signal.reason;
        const item = await inbox.status({ id: args.id });
        const source = owner(exec);
        if (item.sessionId !== source.sessionId || await realpath(item.cwd) !== await realpath(source.cwd))
          fail(
            "NOT_REQUEST_OWNER",
            "This request belongs to another DSH session"
          );
        if (item.planId && item.kind !== "task") {
          const plan = await plans.read(item.planId);
          const task = plan.tasks.find((x) => x.id === item.taskId);
          const review = task?.reviews?.find((r) => r.revision === item.planRevision) || null;
          return JSON.stringify({
            id: item.id,
            state: review ? review.accepted ? "accepted" : "rejected" : task?.state || "unknown",
            review
          });
        }
        return JSON.stringify({
          id: item.id,
          kind: item.kind || "review",
          state: item.state,
          response: item.response || null
        });
      }
    });
}
export {
  registerDshTools
};
