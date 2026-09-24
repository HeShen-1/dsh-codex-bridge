import { realpath } from "node:fs/promises";
// DSH's public SessionController/Agent services own the agent loop and settings.
export class DshBackend {
  ctx: any;
  constructor(ctx) {
    this.ctx = ctx;
  }
  async create(sessionId, cwd) {
    const workspace = await this.ctx.workspaceController.create({ path: cwd });
    const workspaceId = workspace.workspace?.workspaceId;
    if (!workspaceId)
      throw new Error(
        "DSH workspace response has no workspaceId; refusing default directory fallback",
      );
    const created = await this.ctx.sessionController.create({
      sessionId,
      workspaceId,
    });
    const inspection = await this.ctx.sessionController.inspect(sessionId);
    if (
      !inspection.meta?.cwd ||
      (await realpath(inspection.meta.cwd)) !== (await realpath(cwd))
    )
      throw new Error(
        "DSH session cwd does not match the approved worktree; no prompt was sent",
      );
    return created;
  }
  async send(sessionId, requestId, text, mode = "queue") {
    return this.ctx.sessionController.prompt(
      { sessionId, requestId, mode, content: [{ type: "text", text }] },
      new AbortController().signal,
    );
  }
  async inspect(sessionId) {
    const inspection = await this.ctx.sessionController.inspect(sessionId);
    const agent = this.ctx.agents.get(sessionId);
    const decided = new Set(
      inspection.events
        .filter((e) => e.type === "approval/decided")
        .map((e) => e.data.id),
    );
    const pendingApprovals = inspection.events
      .filter((e) => e.type === "approval/asked" && !decided.has(e.data.id))
      .map((e) => e.data);
    const completedCalls = new Set(
      inspection.events
        .filter((e) => e.type === "tool/result")
        .map((e) => e.data.message?.callId),
    );
    const pendingQuestions = inspection.events
      .filter(
        (e) =>
          e.type === "tool/call" &&
          e.data?.name === "ask_user_question" &&
          !completedCalls.has(e.data.callId),
      )
      .map((e) => ({ callId: e.data.callId, arguments: e.data.arguments }));
    return {
      pendingQuestions,
      pendingApprovals,
      cwd: inspection.meta?.cwd,
      events: inspection.events,
      running: agent?.status === "running",
      attached: Boolean(agent),
    };
  }
  async stop(sessionId) {
    const agent = this.ctx.agents.get(sessionId);
    if (!agent) return false;
    agent.cancel({ kind: "user" });
    await agent.whenIdle();
    await this.ctx.sessions.flush(agent.session);
    return true;
  }
  async model() {
    return this.ctx.agentDefaultModel.currentSelection();
  }
}
export function outcome(events, requestId) {
  const input = events.find(
    (e) => e.type === "user/message" && e.data?.source?.rpcId === requestId,
  );
  if (!input) return null;
  const start = events
    .filter((e) => e.type === "turn/start" && e.seq <= input.seq)
    .at(-1);
  if (!start) return null;
  const turn = start.data.turn;
  const end = events.find(
    (e) => e.type === "turn/end" && e.data?.turn === turn && e.seq > input.seq,
  );
  const messages = events.filter(
    (e) => e.type === "assistant/message" && e.data?.turn === turn,
  );
  const text = messages
    .flatMap((e) => e.data.message?.content || [])
    .filter((x) => x.type === "text")
    .map((x) => x.text)
    .join("\n");
  return {
    turn,
    text,
    reason: end?.data.reason,
    finished: Boolean(end),
    lastSeq: end?.seq ?? events.at(-1)?.seq,
  };
}
