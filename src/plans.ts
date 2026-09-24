import { readdir, realpath, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Jobs, digest, fail, git } from "./jobs.js";
import {
  repository,
  makeWorktree,
  checkpoint,
  validPath,
  changed,
} from "./repository.js";
const safeId = (x) => typeof x === "string" && /^[a-zA-Z0-9_-]{1,40}$/.test(x);
const text = (x) => typeof x === "string" && x.trim().length > 0;
export class Plans extends Jobs {
  jobs: Jobs;
  maxParallel: number;
  forge: any;
  timer: ReturnType<typeof setInterval> | null;
  constructor(jobs, dataDir, { maxParallel = 2, forge }: { maxParallel?: number; forge?: any } = {}) {
    super(null, dataDir);
    if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 8)
      fail("INVALID_PARALLELISM", "maxParallel must be between 1 and 8");
    this.jobs = jobs;
    this.maxParallel = maxParallel;
    this.forge = forge;
    this.timer = null;
  }
  async preview(input) {
    if (
      !safeId(input.id) ||
      !text(input.goal) ||
      !Array.isArray(input.tasks) ||
      !input.tasks.length ||
      input.tasks.length > 16
    )
      fail("INVALID_PLAN", "Plan needs id, goal and 1–16 explicit tasks");
    const repo = await repository(input.cwd);
    if (!repo.base)
      fail(
        "BASELINE_REQUIRED",
        "Confirm initial baseline before planning execution",
      );
    const ids = new Set();
    const tasks = input.tasks.map((t) => {
      if (
        !safeId(t.id) ||
        t.id === "integration" ||
        ids.has(t.id) ||
        !text(t.title) ||
        !text(t.prompt) ||
        !Array.isArray(t.files) ||
        !t.files.length ||
        !t.files.every(validPath) ||
        !Array.isArray(t.acceptance) ||
        !t.acceptance.length ||
        !t.acceptance.every(text)
      )
        fail(
          "INVALID_TASK",
          "Each task needs a unique id, title, prompt, relative file scopes and acceptance criteria",
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
        revision: 0,
      };
    });
    for (const t of tasks)
      if (
        !Array.isArray(t.dependsOn) ||
        !t.dependsOn.every((id) => ids.has(id) && id !== t.id)
      )
        fail(
          "INVALID_DEPENDENCY",
          "Dependencies must refer to other tasks in this plan",
        );
    const visited = new Set(),
      active = new Set();
    const walk = (t) => {
      if (active.has(t.id)) fail("DEPENDENCY_CYCLE", "Task dependency cycle");
      if (visited.has(t.id)) return;
      active.add(t.id);
      t.dependsOn.forEach((id) => walk(tasks.find((x) => x.id === id)));
      active.delete(t.id);
      visited.add(t.id);
    };
    tasks.forEach(walk);
    if (
      input.integrationAcceptance !== undefined &&
      (!Array.isArray(input.integrationAcceptance) ||
        !input.integrationAcceptance.length ||
        !input.integrationAcceptance.every(text))
    )
      fail(
        "INVALID_ACCEPTANCE",
        "Integration acceptance must be a non-empty list",
      );
    if (tasks.length > 1)
      tasks.push({
        id: "integration",
        title: "组合后集成验证",
        prompt:
          "验证全部已接受子任务组合后的行为，执行完整的相关验证；必要修订必须仍在本计划文件范围内。",
        files: [...new Set(tasks.flatMap((t) => t.files))],
        acceptance:
          input.integrationAcceptance || tasks.flatMap((t) => t.acceptance),
        dependsOn: tasks.map((t) => t.id),
        state: "pending",
        revision: 0,
        synthetic: true,
      });
    const spec = {
      id: input.id,
      cwd: repo.cwd,
      base: repo.base,
      goal: input.goal,
      sourceTask: input.sourceTask || "",
      tasks,
      delivery: input.delivery || null,
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
            "Plan id already belongs to different specification",
          );
        return old;
      }
      return this.save({
        ...spec,
        hash,
        state: "awaiting_approval",
        repairRounds: 0,
        createdAt: new Date().toISOString(),
        dirtySource: await git(repo.cwd, "status", "--porcelain"),
      });
    });
  }
  async approve({ id, hash }) {
    const plan = await this.exclusive(id, async () => {
      const plan = await this.read(id);
      if (plan.hash !== hash)
        fail("PLAN_CHANGED", "Approve the exact preview hash");
      if (plan.state !== "awaiting_approval") return plan;
      if ((await git(plan.cwd, "rev-parse", "HEAD")) !== plan.base)
        fail(
          "BASELINE_CHANGED",
          "Base commit changed; create a new reviewed plan",
        );
      plan.state = "running";
      plan.approvedAt = new Date().toISOString();
      return this.save(plan);
    });
    await this.tick(id);
    return this.read(plan.id);
  }
  prompt(plan, task) {
    return `你是 DSH 执行方，Codex 负责规划与独立复核。已批准计划 ${plan.id}，目标：${plan.goal}\n子任务：${task.title}\n工作目录：${task.worktree.path}\n允许修改的路径（目录以 / 结尾）：${task.files.join(", ")}\n任务要求：\n${task.prompt}\n验收：\n${task.acceptance.map((x) => "- " + x).join("\n")}\n${task.feedback ? "修订要求：" + task.feedback + "\n" : ""}先读取本 worktree 的 .handoff/HANDOFF.md 和项目规则。交接文件由桥接管理，执行方只读，不需要修改 consumed 标记。只在当前 worktree 内修改和验证。不要自行创建额外会话、worktree、提交、推送、发布 issue/PR、合并或更改模型设置；这些由桥接协调。遇到范围、权限变化或无法继续的阻塞，停止并明确报告。最终逐项报告修改文件、验证命令及结果、未解决问题；没有证据不得声称验收通过。完成自检后调用 request_codex_review，requestId 使用 ${plan.id}-${task.id}-${task.revision}，附上 planId=${plan.id}、taskId=${task.id}、摘要和实际检查结果；请求仅是送审，不代表 Codex 已接受。`;
  }
  async tick(id) {
    return this.exclusive(id, async () => {
      const plan = await this.read(id);
      if (plan.state !== "running") return plan;
      for (const task of plan.tasks.filter(
        (t) =>
          ["running", "waiting_user", "unknown"].includes(t.state) && t.jobId,
      )) {
        const job = await this.jobs.status({ id: task.jobId });
        task.execution = job;
        if (job.state === "submitted") {
          try {
            task.evidence = await checkpoint(plan, task);
            await writeFile(
              join(task.worktree.path, ".handoff/HANDOFF.md"),
              (
                await readFile(
                  join(task.worktree.path, ".handoff/HANDOFF.md"),
                  "utf8",
                )
              ).replace("status: active", "status: consumed"),
            );
            task.state = "awaiting_review";
            task.reviewHash = digest({
              head: task.evidence.head,
              result: job.result,
              revision: task.revision,
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
      let capacity =
        this.maxParallel -
        plan.tasks.filter((t) =>
          ["running", "waiting_user", "preparing", "unknown"].includes(t.state),
        ).length;
      for (const task of plan.tasks) {
        if (capacity <= 0) break;
        if (
          task.state !== "pending" ||
          !task.dependsOn.every(
            (id) => plan.tasks.find((t) => t.id === id).state === "accepted",
          )
        )
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
                message: error.message,
              };
              await this.save(plan);
            }
          }
          if (!task.worktree)
            task.worktree = await makeWorktree(
              plan,
              task,
              task.dependsOn.map(
                (id) => plan.tasks.find((t) => t.id === id).evidence.head,
              ),
            );
          const clean = (x) =>
            String(x)
              .replace(/[\r\n]/g, " ")
              .slice(0, 1200);
          await writeFile(
            join(task.worktree.path, ".handoff/HANDOFF.md"),
            `updated: ${new Date().toISOString()}\nstatus: active\nfrom-agent: codex\n\n1. 当前目标: ${clean(task.title)}\n2. 下一步动作: ${task.revision ? "根据修订反馈完成修正" : "实施本子任务"}并验证，提交证据供 Codex 复核。\n3. 已完成+验证状态: ${task.evidence ? "已有提交 " + task.evidence.head + "；尚未通过本轮复核" : "工作区基线已准备；尚未实施"}\n4. 关键决策: ${plan.id}/${task.id}；修订 ${task.revision}；模型人工配置。\n5. 已试过且失败: ${clean(task.feedback || "无")}\n6. 文件地图: ${task.files.join(", ")}\n7. 未决问题: 超出范围或需用户决定时停止并报告。\n8. 需跑的命令: 按任务验收要求执行并保存输出。\n9. 环境状态: ${task.worktree.branch}；独立 worktree。\n`,
            { mode: 0o600 },
          );
          task.jobId =
            "job-" +
            digest({
              plan: plan.id,
              task: task.id,
              revision: task.revision,
            }).slice(0, 32);
          await this.save(plan);
          task.execution = await this.jobs.submit({
            id: task.jobId,
            cwd: task.worktree.path,
            prompt: this.prompt(plan, task),
            sourceTask: plan.sourceTask,
          });
          task.state =
            task.execution.state === "running"
              ? "running"
              : task.execution.state;
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
    p.nextAction =
      p.state === "awaiting_approval"
        ? "approve"
        : p.tasks.some((t) => t.state === "waiting_user")
          ? "answer_in_dsh"
          : p.tasks.some((t) => t.state === "awaiting_review")
            ? "review"
            : p.tasks.some((t) => t.state === "running")
              ? "wait"
              : p.tasks.some((t) =>
                    ["blocked", "unknown", "preparing"].includes(t.state),
                  )
                ? "resolve_blocker"
                : p.state === "reviewed"
                  ? p.delivery
                    ? "deliver"
                    : "local_delivery"
                  : "none";
    return p;
  }
  async wait({ id, timeoutMs = 20000 }) {
    const first = await this.status({ id });
    if (first.nextAction !== "wait") return first;
    const until =
      Date.now() + Math.min(Math.max(Number(timeoutMs) || 0, 0), 25000);
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
    progress = false,
  }) {
    if (
      typeof accepted !== "boolean" ||
      !text(feedback) ||
      !Array.isArray(evidence) ||
      !evidence.length ||
      !evidence.every(text)
    )
      fail(
        "REVIEW_REQUIRED",
        "Review needs explicit verdict, evidence references and feedback",
      );
    await this.exclusive(id, async () => {
      const plan = await this.read(id),
        task = plan.tasks.find((t) => t.id === taskId);
      if (!task) fail("UNKNOWN_TASK", "Unknown task");
      if (task.reviewHash !== reviewHash)
        fail(
          "STALE_REVIEW",
          "Review must match current head and execution result",
        );
      const prior = task.reviews?.find((r) => r.reviewHash === reviewHash);
      if (prior) {
        if (prior.accepted === accepted && prior.feedback === feedback) return;
        fail("REVIEW_CONFLICT", "This revision already has a different review");
      }
      if (plan.state !== "running" || task.state !== "awaiting_review")
        fail("NOT_REVIEWABLE", "Task is not awaiting review in a running plan");
      if (
        (await git(task.worktree.path, "rev-parse", "HEAD")) !==
          task.evidence.head ||
        (await changed(task.worktree.path)).length
      )
        fail(
          "WORKTREE_CHANGED",
          "Worktree changed since evidence was captured",
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
        at: new Date().toISOString(),
      });
      if (accepted) task.state = "accepted";
      else {
        const previous = task.reviews.at(-2);
        if (
          plan.repairRounds >= 3 ||
          (blockerKey &&
            previous?.blockerKey === blockerKey &&
            !progress &&
            !previous.progress)
        ) {
          task.state = "blocked";
          task.error =
            plan.repairRounds >= 3
              ? "repair limit reached"
              : "same blocker without progress twice";
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
  async stop({ id, taskId }: { id: string; taskId?: string }) {
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
    await Promise.allSettled(jobs.map((id) => this.jobs.stop({ id })));
    return this.exclusive(id, async () => {
      const plan = await this.read(id);
      for (const task of plan.tasks.filter(
        (t) => t.state === "stop_requested" && t.jobId,
      )) {
        const job = await this.jobs.status({ id: task.jobId });
        if (["stopped", "submitted", "failed"].includes(job.state))
          task.state = "stopped";
      }
      if (
        !taskId &&
        plan.tasks.every((t) => ["stopped", "accepted"].includes(t.state))
      )
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
      files
        .filter((f) => f.endsWith(".json"))
        .map((f) => this.read(f.slice(0, -5))),
    );
  }
  async recover() {
    for (const p of await this.list())
      await this.exclusive(p.id, async () => {
        const plan = await this.read(p.id);
        for (const t of plan.tasks)
          if (t.state === "preparing") {
            t.state = "unknown";
            t.error =
              "Interrupted preparation; inspect existing worktree/issue/job before resuming";
          }
        await this.save(plan);
      });
  }
  start() {
    const run = async () => {
      for (const plan of await this.list())
        await this.tick(plan.id).catch(() => {});
    };
    let busy = false;
    this.timer = setInterval(() => {
      if (!busy) {
        busy = true;
        run()
          .catch(() => {})
          .finally(() => {
            busy = false;
          });
      }
    }, 1500);
    this.timer.unref();
    return () => clearInterval(this.timer);
  }
}
