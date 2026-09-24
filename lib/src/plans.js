import { readdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Jobs, digest, fail, git } from "./jobs.js";
import {
  repository,
  makeWorktree,
  checkpoint,
  validPath,
  changed
} from "./repository.js";
const safeId = (x) => typeof x === "string" && /^[a-zA-Z0-9_-]{1,40}$/.test(x);
const text = (x) => typeof x === "string" && x.trim().length > 0;
class Plans extends Jobs {
  jobs;
  maxParallel;
  forge;
  timer;
  constructor(jobs, dataDir, { maxParallel = 2, forge } = {}) {
    super(null, dataDir);
    if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 8)
      fail("INVALID_PARALLELISM", "maxParallel must be between 1 and 8");
    this.jobs = jobs;
    this.maxParallel = maxParallel;
    this.forge = forge;
    this.timer = null;
  }
  async preview(input) {
    if (!safeId(input.id) || !text(input.goal) || !Array.isArray(input.tasks) || !input.tasks.length || input.tasks.length > 16)
      fail("INVALID_PLAN", "Plan needs id, goal and 1\u201316 explicit tasks");
    const repo = await repository(input.cwd);
    if (!repo.base)
      fail(
        "BASELINE_REQUIRED",
        "Confirm initial baseline before planning execution"
      );
    const ids = /* @__PURE__ */ new Set();
    const tasks = input.tasks.map((t) => {
      if (!safeId(t.id) || t.id === "integration" || ids.has(t.id) || !text(t.title) || !text(t.prompt) || !Array.isArray(t.files) || !t.files.length || !t.files.every(validPath) || !Array.isArray(t.acceptance) || !t.acceptance.length || !t.acceptance.every(text))
        fail(
          "INVALID_TASK",
          "Each task needs a unique id, title, prompt, relative file scopes and acceptance criteria"
        );
      ids.add(t.id);
      return {
        id: t.id,
        title: t.title,
        prompt: t.prompt,
        files: t.files,
        acceptance: t.acceptance,
        dependsOn: t.dependsOn || [],
        state: "pending",
        revision: 0
      };
    });
    for (const t of tasks)
      if (!Array.isArray(t.dependsOn) || !t.dependsOn.every((id) => ids.has(id) && id !== t.id))
        fail(
          "INVALID_DEPENDENCY",
          "Dependencies must refer to other tasks in this plan"
        );
    const visited = /* @__PURE__ */ new Set(), active = /* @__PURE__ */ new Set();
    const walk = (t) => {
      if (active.has(t.id)) fail("DEPENDENCY_CYCLE", "Task dependency cycle");
      if (visited.has(t.id)) return;
      active.add(t.id);
      t.dependsOn.forEach((id) => walk(tasks.find((x) => x.id === id)));
      active.delete(t.id);
      visited.add(t.id);
    };
    tasks.forEach(walk);
    if (input.integrationAcceptance !== void 0 && (!Array.isArray(input.integrationAcceptance) || !input.integrationAcceptance.length || !input.integrationAcceptance.every(text)))
      fail(
        "INVALID_ACCEPTANCE",
        "Integration acceptance must be a non-empty list"
      );
    if (tasks.length > 1)
      tasks.push({
        id: "integration",
        title: "\u7EC4\u5408\u540E\u96C6\u6210\u9A8C\u8BC1",
        prompt: "\u9A8C\u8BC1\u5168\u90E8\u5DF2\u63A5\u53D7\u5B50\u4EFB\u52A1\u7EC4\u5408\u540E\u7684\u884C\u4E3A\uFF0C\u6267\u884C\u5B8C\u6574\u7684\u76F8\u5173\u9A8C\u8BC1\uFF1B\u5FC5\u8981\u4FEE\u8BA2\u5FC5\u987B\u4ECD\u5728\u672C\u8BA1\u5212\u6587\u4EF6\u8303\u56F4\u5185\u3002",
        files: [...new Set(tasks.flatMap((t) => t.files))],
        acceptance: input.integrationAcceptance || tasks.flatMap((t) => t.acceptance),
        dependsOn: tasks.map((t) => t.id),
        state: "pending",
        revision: 0,
        synthetic: true
      });
    const spec = {
      id: input.id,
      cwd: repo.cwd,
      base: repo.base,
      goal: input.goal,
      sourceTask: input.sourceTask || "",
      tasks,
      delivery: input.delivery || null
    };
    if (spec.delivery) await this.forge.validate(spec);
    const hash = digest(spec);
    return this.exclusive(input.id, async () => {
      const old = await this.read(input.id).catch((e) => {
        if (e.code !== "ENOENT") throw e;
      });
      if (old) {
        if (old.hash !== hash)
          fail(
            "IDEMPOTENCY_CONFLICT",
            "Plan id already belongs to different specification"
          );
        return old;
      }
      return this.save({
        ...spec,
        hash,
        state: "awaiting_approval",
        repairRounds: 0,
        createdAt: (/* @__PURE__ */ new Date()).toISOString(),
        dirtySource: await git(repo.cwd, "status", "--porcelain")
      });
    });
  }
  async approve({ id, hash }) {
    const plan = await this.exclusive(id, async () => {
      const plan2 = await this.read(id);
      if (plan2.hash !== hash)
        fail("PLAN_CHANGED", "Approve the exact preview hash");
      if (plan2.state !== "awaiting_approval") return plan2;
      if (await git(plan2.cwd, "rev-parse", "HEAD") !== plan2.base)
        fail(
          "BASELINE_CHANGED",
          "Base commit changed; create a new reviewed plan"
        );
      plan2.state = "running";
      plan2.approvedAt = (/* @__PURE__ */ new Date()).toISOString();
      return this.save(plan2);
    });
    await this.tick(id);
    return this.read(plan.id);
  }
  prompt(plan, task) {
    return `\u4F60\u662F DSH \u6267\u884C\u65B9\uFF0CCodex \u8D1F\u8D23\u89C4\u5212\u4E0E\u72EC\u7ACB\u590D\u6838\u3002\u5DF2\u6279\u51C6\u8BA1\u5212 ${plan.id}\uFF0C\u76EE\u6807\uFF1A${plan.goal}
\u5B50\u4EFB\u52A1\uFF1A${task.title}
\u5DE5\u4F5C\u76EE\u5F55\uFF1A${task.worktree.path}
\u5141\u8BB8\u4FEE\u6539\u7684\u8DEF\u5F84\uFF08\u76EE\u5F55\u4EE5 / \u7ED3\u5C3E\uFF09\uFF1A${task.files.join(", ")}
\u4EFB\u52A1\u8981\u6C42\uFF1A
${task.prompt}
\u9A8C\u6536\uFF1A
${task.acceptance.map((x) => "- " + x).join("\n")}
${task.feedback ? "\u4FEE\u8BA2\u8981\u6C42\uFF1A" + task.feedback + "\n" : ""}\u5148\u8BFB\u53D6\u672C worktree \u7684 .handoff/HANDOFF.md \u548C\u9879\u76EE\u89C4\u5219\u3002\u4EA4\u63A5\u6587\u4EF6\u7531\u6865\u63A5\u7BA1\u7406\uFF0C\u6267\u884C\u65B9\u53EA\u8BFB\uFF0C\u4E0D\u9700\u8981\u4FEE\u6539 consumed \u6807\u8BB0\u3002\u53EA\u5728\u5F53\u524D worktree \u5185\u4FEE\u6539\u548C\u9A8C\u8BC1\u3002\u4E0D\u8981\u81EA\u884C\u521B\u5EFA\u989D\u5916\u4F1A\u8BDD\u3001worktree\u3001\u63D0\u4EA4\u3001\u63A8\u9001\u3001\u53D1\u5E03 issue/PR\u3001\u5408\u5E76\u6216\u66F4\u6539\u6A21\u578B\u8BBE\u7F6E\uFF1B\u8FD9\u4E9B\u7531\u6865\u63A5\u534F\u8C03\u3002\u9047\u5230\u8303\u56F4\u3001\u6743\u9650\u53D8\u5316\u6216\u65E0\u6CD5\u7EE7\u7EED\u7684\u963B\u585E\uFF0C\u505C\u6B62\u5E76\u660E\u786E\u62A5\u544A\u3002\u6700\u7EC8\u9010\u9879\u62A5\u544A\u4FEE\u6539\u6587\u4EF6\u3001\u9A8C\u8BC1\u547D\u4EE4\u53CA\u7ED3\u679C\u3001\u672A\u89E3\u51B3\u95EE\u9898\uFF1B\u6CA1\u6709\u8BC1\u636E\u4E0D\u5F97\u58F0\u79F0\u9A8C\u6536\u901A\u8FC7\u3002\u5B8C\u6210\u81EA\u68C0\u540E\u8C03\u7528 request_codex_review\uFF0CrequestId \u4F7F\u7528 ${plan.id}-${task.id}-${task.revision}\uFF0C\u9644\u4E0A planId=${plan.id}\u3001taskId=${task.id}\u3001\u6458\u8981\u548C\u5B9E\u9645\u68C0\u67E5\u7ED3\u679C\uFF1B\u8BF7\u6C42\u4EC5\u662F\u9001\u5BA1\uFF0C\u4E0D\u4EE3\u8868 Codex \u5DF2\u63A5\u53D7\u3002`;
  }
  async tick(id) {
    return this.exclusive(id, async () => {
      const plan = await this.read(id);
      if (plan.state !== "running") return plan;
      for (const task of plan.tasks.filter(
        (t) => ["running", "waiting_user", "unknown"].includes(t.state) && t.jobId
      )) {
        const job = await this.jobs.status({ id: task.jobId });
        task.execution = job;
        if (job.state === "submitted") {
          try {
            task.evidence = await checkpoint(plan, task);
            await writeFile(
              join(task.worktree.path, ".handoff/HANDOFF.md"),
              (await readFile(
                join(task.worktree.path, ".handoff/HANDOFF.md"),
                "utf8"
              )).replace("status: active", "status: consumed")
            );
            task.state = "awaiting_review";
            task.reviewHash = digest({
              head: task.evidence.head,
              result: job.result,
              revision: task.revision
            });
          } catch (error) {
            task.state = "blocked";
            task.error = error.message;
          }
        } else if (job.state === "waiting_user") {
          task.state = "waiting_user";
        } else if (job.state === "running") {
          task.state = "running";
        } else if (["failed", "stopped", "unknown"].includes(job.state)) {
          task.state = job.state === "unknown" ? "unknown" : "blocked";
          task.error = job.error || job.result?.reason || job.state;
        }
      }
      let capacity = this.maxParallel - plan.tasks.filter(
        (t) => ["running", "waiting_user", "preparing", "unknown"].includes(t.state)
      ).length;
      for (const task of plan.tasks) {
        if (capacity <= 0) break;
        if (task.state !== "pending" || !task.dependsOn.every(
          (id2) => plan.tasks.find((t) => t.id === id2).state === "accepted"
        ))
          continue;
        task.state = "preparing";
        await this.save(plan);
        try {
          if (plan.delivery) {
            try {
              await this.forge.issue(plan, task, () => this.save(plan));
              delete task.deliveryError;
            } catch (error) {
              task.deliveryError = {
                code: error.code || "FORGE_ERROR",
                message: error.message
              };
              await this.save(plan);
            }
          }
          if (!task.worktree)
            task.worktree = await makeWorktree(
              plan,
              task,
              task.dependsOn.map(
                (id2) => plan.tasks.find((t) => t.id === id2).evidence.head
              )
            );
          const clean = (x) => String(x).replace(/[\r\n]/g, " ").slice(0, 1200);
          await writeFile(
            join(task.worktree.path, ".handoff/HANDOFF.md"),
            `updated: ${(/* @__PURE__ */ new Date()).toISOString()}
status: active
from-agent: codex

1. \u5F53\u524D\u76EE\u6807: ${clean(task.title)}
2. \u4E0B\u4E00\u6B65\u52A8\u4F5C: ${task.revision ? "\u6839\u636E\u4FEE\u8BA2\u53CD\u9988\u5B8C\u6210\u4FEE\u6B63" : "\u5B9E\u65BD\u672C\u5B50\u4EFB\u52A1"}\u5E76\u9A8C\u8BC1\uFF0C\u63D0\u4EA4\u8BC1\u636E\u4F9B Codex \u590D\u6838\u3002
3. \u5DF2\u5B8C\u6210+\u9A8C\u8BC1\u72B6\u6001: ${task.evidence ? "\u5DF2\u6709\u63D0\u4EA4 " + task.evidence.head + "\uFF1B\u5C1A\u672A\u901A\u8FC7\u672C\u8F6E\u590D\u6838" : "\u5DE5\u4F5C\u533A\u57FA\u7EBF\u5DF2\u51C6\u5907\uFF1B\u5C1A\u672A\u5B9E\u65BD"}
4. \u5173\u952E\u51B3\u7B56: ${plan.id}/${task.id}\uFF1B\u4FEE\u8BA2 ${task.revision}\uFF1B\u6A21\u578B\u4EBA\u5DE5\u914D\u7F6E\u3002
5. \u5DF2\u8BD5\u8FC7\u4E14\u5931\u8D25: ${clean(task.feedback || "\u65E0")}
6. \u6587\u4EF6\u5730\u56FE: ${task.files.join(", ")}
7. \u672A\u51B3\u95EE\u9898: \u8D85\u51FA\u8303\u56F4\u6216\u9700\u7528\u6237\u51B3\u5B9A\u65F6\u505C\u6B62\u5E76\u62A5\u544A\u3002
8. \u9700\u8DD1\u7684\u547D\u4EE4: \u6309\u4EFB\u52A1\u9A8C\u6536\u8981\u6C42\u6267\u884C\u5E76\u4FDD\u5B58\u8F93\u51FA\u3002
9. \u73AF\u5883\u72B6\u6001: ${task.worktree.branch}\uFF1B\u72EC\u7ACB worktree\u3002
`,
            { mode: 384 }
          );
          task.jobId = "job-" + digest({
            plan: plan.id,
            task: task.id,
            revision: task.revision
          }).slice(0, 32);
          await this.save(plan);
          task.execution = await this.jobs.submit({
            id: task.jobId,
            cwd: task.worktree.path,
            prompt: this.prompt(plan, task),
            sourceTask: plan.sourceTask
          });
          task.state = task.execution.state === "running" ? "running" : task.execution.state;
          capacity--;
        } catch (error) {
          task.state = "blocked";
          task.error = error.message;
        }
        await this.save(plan);
      }
      if (plan.tasks.every((t) => t.state === "accepted"))
        plan.state = "reviewed";
      return this.save(plan);
    });
  }
  async status({ id }) {
    await this.tick(id);
    const p = await this.read(id);
    p.nextAction = p.state === "awaiting_approval" ? "approve" : p.tasks.some((t) => t.state === "waiting_user") ? "answer_in_dsh" : p.tasks.some((t) => t.state === "awaiting_review") ? "review" : p.tasks.some((t) => t.state === "running") ? "wait" : p.tasks.some(
      (t) => ["blocked", "unknown", "preparing"].includes(t.state)
    ) ? "resolve_blocker" : p.state === "reviewed" ? p.delivery ? "deliver" : "local_delivery" : "none";
    return p;
  }
  async wait({ id, timeoutMs = 2e4 }) {
    const first = await this.status({ id });
    if (first.nextAction !== "wait") return first;
    const until = Date.now() + Math.min(Math.max(Number(timeoutMs) || 0, 0), 25e3);
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 500));
      const p = await this.status({ id });
      if (p.nextAction !== "wait") return p;
    }
    return this.status({ id });
  }
  async review({
    id,
    taskId,
    reviewHash,
    accepted,
    feedback,
    evidence,
    blockerKey = "",
    progress = false
  }) {
    if (typeof accepted !== "boolean" || !text(feedback) || !Array.isArray(evidence) || !evidence.length || !evidence.every(text))
      fail(
        "REVIEW_REQUIRED",
        "Review needs explicit verdict, evidence references and feedback"
      );
    await this.exclusive(id, async () => {
      const plan = await this.read(id), task = plan.tasks.find((t) => t.id === taskId);
      if (!task) fail("UNKNOWN_TASK", "Unknown task");
      if (task.reviewHash !== reviewHash)
        fail(
          "STALE_REVIEW",
          "Review must match current head and execution result"
        );
      const prior = task.reviews?.find((r) => r.reviewHash === reviewHash);
      if (prior) {
        if (prior.accepted === accepted && prior.feedback === feedback) return;
        fail("REVIEW_CONFLICT", "This revision already has a different review");
      }
      if (plan.state !== "running" || task.state !== "awaiting_review")
        fail("NOT_REVIEWABLE", "Task is not awaiting review in a running plan");
      if (await git(task.worktree.path, "rev-parse", "HEAD") !== task.evidence.head || (await changed(task.worktree.path)).length)
        fail(
          "WORKTREE_CHANGED",
          "Worktree changed since evidence was captured"
        );
      task.reviews ||= [];
      task.reviews.push({
        reviewHash,
        revision: task.revision,
        accepted,
        feedback,
        evidence,
        blockerKey,
        progress,
        at: (/* @__PURE__ */ new Date()).toISOString()
      });
      if (accepted) task.state = "accepted";
      else {
        const previous = task.reviews.at(-2);
        if (plan.repairRounds >= 3 || blockerKey && previous?.blockerKey === blockerKey && !progress && !previous.progress) {
          task.state = "blocked";
          task.error = plan.repairRounds >= 3 ? "repair limit reached" : "same blocker without progress twice";
        } else {
          plan.repairRounds++;
          task.revision++;
          task.feedback = feedback;
          task.state = "pending";
        }
      }
      await this.save(plan);
    });
    return this.status({ id });
  }
  async steer({ id, taskId, message, requestId }) {
    const plan = await this.read(id);
    if (plan.state !== "running") fail("NOT_RUNNING", "Plan is not running");
    const task = plan.tasks.find((t) => t.id === taskId);
    if (!task || task.state !== "running")
      fail("NOT_RUNNING", "Task is not running");
    return this.jobs.steer({ id: task.jobId, message, requestId });
  }
  async stop({ id, taskId }) {
    let jobs = [];
    await this.exclusive(id, async () => {
      const plan = await this.read(id);
      if (taskId && !plan.tasks.some((t) => t.id === taskId))
        fail("UNKNOWN_TASK", "Unknown task");
      if (!taskId) plan.state = "stop_requested";
      for (const task of plan.tasks.filter((t) => !taskId || t.id === taskId)) {
        if (["accepted", "stopped"].includes(task.state)) continue;
        task.state = "stop_requested";
        if (task.jobId) jobs.push(task.jobId);
        else task.state = "stopped";
      }
      await this.save(plan);
    });
    await Promise.allSettled(jobs.map((id2) => this.jobs.stop({ id: id2 })));
    return this.exclusive(id, async () => {
      const plan = await this.read(id);
      for (const task of plan.tasks.filter(
        (t) => t.state === "stop_requested" && t.jobId
      )) {
        const job = await this.jobs.status({ id: task.jobId });
        if (["stopped", "submitted", "failed"].includes(job.state))
          task.state = "stopped";
      }
      if (!taskId && plan.tasks.every((t) => ["stopped", "accepted"].includes(t.state)))
        plan.state = "stopped";
      return this.save(plan);
    });
  }
  async deliver({ id }) {
    return this.exclusive(id, async () => {
      const plan = await this.read(id);
      return this.forge.deliver(plan, () => this.save(plan));
    });
  }
  async list() {
    const files = await readdir(this.dataDir).catch((e) => {
      if (e.code !== "ENOENT") throw e;
      return [];
    });
    return Promise.all(
      files.filter((f) => f.endsWith(".json")).map((f) => this.read(f.slice(0, -5)))
    );
  }
  async recover() {
    for (const p of await this.list())
      await this.exclusive(p.id, async () => {
        const plan = await this.read(p.id);
        for (const t of plan.tasks)
          if (t.state === "preparing") {
            t.state = "unknown";
            t.error = "Interrupted preparation; inspect existing worktree/issue/job before resuming";
          }
        await this.save(plan);
      });
  }
  start() {
    const run = async () => {
      for (const plan of await this.list())
        await this.tick(plan.id).catch(() => {
        });
    };
    let busy = false;
    this.timer = setInterval(() => {
      if (!busy) {
        busy = true;
        run().catch(() => {
        }).finally(() => {
          busy = false;
        });
      }
    }, 1500);
    this.timer.unref();
    return () => clearInterval(this.timer);
  }
}
export {
  Plans
};
