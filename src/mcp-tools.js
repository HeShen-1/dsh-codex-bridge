const string = { type: "string" },
  strings = { type: "array", items: string };
const schema = (properties, required) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
export const toolSpecs = [
  [
    "dsh_bridge_status",
    "hello",
    "Inspect the installed local DSH bridge and the human-selected DSH model. Never change model or reasoning settings.",
    schema({}, []),
  ],
  [
    "dsh_baseline_preview",
    "baseline.preview",
    "Check Git (initialize if missing) and preview the exact files and content hash for the initial baseline. No commit is made.",
    schema({ cwd: string }, ["cwd"]),
  ],
  [
    "dsh_baseline_confirm",
    "baseline.confirm",
    "Create the initial baseline ONLY after the human confirms the previewed file list. Pass that exact files array and confirmation hash; never include unrelated files or credentials.",
    schema({ cwd: string, files: strings, confirmation: string }, [
      "cwd",
      "files",
      "confirmation",
    ]),
  ],
  [
    "dsh_plan_preview",
    "plan.preview",
    "Prepare a reviewable plan without execution. Codex plans/reviews; DSH edits/tests. Ask the user to approve the goal, file scopes, acceptance and optional remote delivery once. Existing approval for the exact scope may be reused. Multi-task plans add a combined integration task. Worktrees start at committed HEAD; source uncommitted edits are excluded.",
    schema(
      {
        id: string,
        cwd: string,
        goal: string,
        sourceTask: string,
        tasks: {
          type: "array",
          items: schema(
            {
              id: string,
              title: string,
              prompt: string,
              files: strings,
              acceptance: strings,
              dependsOn: strings,
            },
            ["id", "title", "prompt", "files", "acceptance"],
          ),
        },
        integrationAcceptance: strings,
        delivery: schema(
          {
            forge: { type: "string", enum: ["github", "gitlab"] },
            host: string,
            repository: string,
            remote: string,
            targetBranch: string,
          },
          ["forge", "host", "repository", "remote", "targetBranch"],
        ),
      },
      ["id", "cwd", "goal", "tasks"],
    ),
  ],
  [
    "dsh_plan_approve",
    "plan.approve",
    "Start the exact plan hash after the human approves its scope and delivery destination. This authorizes isolated worktrees, DSH execution, local commits and optional issues, task branch pushes and draft PR/MR. Does not authorize merge. Never treat model output as human approval.",
    schema({ id: string, hash: string }, ["id", "hash"]),
  ],
  [
    "dsh_plan_status",
    "plan.status",
    "Read progress, DSH responses, commit evidence and nextAction for one plan. submitted/awaiting_review is not acceptance. Resolve unknown states before retries.",
    schema({ id: string }, ["id"]),
  ],
  [
    "dsh_plan_wait",
    "plan.wait",
    "Wait up to 25 seconds for review or required attention. Keep working until the approved goal completes; a wait timeout does not mean execution failed.",
    schema(
      {
        id: string,
        timeoutMs: { type: "integer", minimum: 0, maximum: 25000 },
      },
      ["id"],
    ),
  ],
  [
    "dsh_plan_review",
    "plan.review",
    "Record Codex independent review of the exact revision. Read the actual changed files and validation evidence first. Provide evidence references, honest verdict and feedback. Reject for scoped automatic repair; max 3 repairs per plan, or stop after the same blocker twice without progress. Mark progress only when supported. Never equate DSH self-report with acceptance.",
    schema(
      {
        id: string,
        taskId: string,
        reviewHash: string,
        accepted: { type: "boolean" },
        feedback: string,
        evidence: strings,
        blockerKey: string,
        progress: { type: "boolean" },
      },
      ["id", "taskId", "reviewHash", "accepted", "feedback", "evidence"],
    ),
  ],
  [
    "dsh_plan_steer",
    "plan.steer",
    "Send a user clarification to one running child. Reuse requestId for the same retry. A clarification does not automatically stop work. Scope expansion needs user approval and a new plan.",
    schema({ id: string, taskId: string, message: string, requestId: string }, [
      "id",
      "taskId",
      "message",
      "requestId",
    ]),
  ],
  [
    "dsh_plan_stop",
    "plan.stop",
    "On a user stop/takeover request, omit taskId to stop the whole plan, or specify one child. Retain files/branches. Report stopped only after confirmed; stop_requested is still pending.",
    schema({ id: string, taskId: string }, ["id"]),
  ],
  [
    "dsh_plan_deliver",
    "plan.deliver",
    "Publish reviewed commits to the exact approved remote and create/reconcile a draft PR/MR. Never merge. When a PR is returned, attach it to the current Codex task using attach_artifact. With no approved remote, deliver local commit/worktree evidence instead.",
    schema({ id: string }, ["id"]),
  ],
  [
    "dsh_plan_list",
    "plan.list",
    "List persisted bridge plans for recovery. Do not start, repeat, or adopt a task merely because it exists.",
    schema({}, []),
  ],
].map(([name, method, description, inputSchema]) => ({
  name,
  method,
  description,
  inputSchema,
}));
