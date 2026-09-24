import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { Jobs, digest, fail, git } from "./jobs.js";
import { changed, repository } from "./repository.js";

const nonempty = (x, max) =>
  typeof x === "string" && x.trim().length > 0 && x.length <= max;

async function snapshot(cwd) {
  const repo = await repository(cwd);
  if (!repo.base) fail("BASELINE_REQUIRED", "Confirm a Git baseline first");
  const commonDir = await realpath(
    await git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"),
  );
  const paths = await changed(cwd);
  if (paths.length > 100)
    fail("SNAPSHOT_TOO_LARGE", "Review at most 100 changed files at once");
  const files = [];
  for (const path of paths) {
    const absolute = join(cwd, path);
    const info = await lstat(absolute).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
    if (!info) {
      files.push({ path, deleted: true });
      continue;
    }
    if (!info.isFile() || info.size > 10_000_000)
      fail("UNSUPPORTED_FILE", `Cannot fingerprint changed file: ${path}`);
    const resolved = await realpath(absolute);
    if (!resolved.startsWith(cwd + "/"))
      fail("OUTSIDE_REPO", `Changed file resolves outside repository: ${path}`);
    files.push({
      path,
      sha256: createHash("sha256")
        .update(await readFile(absolute))
        .digest("hex"),
    });
  }
  return {
    cwd,
    commonDir,
    head: repo.base,
    files,
    fingerprint: digest({ head: repo.base, files }),
  };
}

export class ReviewInbox extends Jobs {
  plans: any;
  constructor(dataDir, plans) {
    super(null, dataDir);
    this.plans = plans;
  }
  async submit(
    { requestId, summary, checks = [], planId, taskId, kind = "review" }: { requestId: string; summary: string; checks?: string[]; planId?: string; taskId?: string; kind?: "review" | "task" },
    { sessionId, cwd } = {} as { sessionId: string; cwd: string },
  ) {
    if (
      !/^[a-zA-Z0-9_-]{1,80}$/.test(requestId || "") ||
      !nonempty(summary, 2000) ||
      !["review", "task"].includes(kind) ||
      !Array.isArray(checks) ||
      (kind === "review" && checks.length < 1) ||
      (kind === "task" && checks.length !== 0) ||
      checks.length > 8 ||
      !checks.every((x) => nonempty(x, 500)) ||
      Boolean(planId) !== Boolean(taskId)
    )
      fail(
        "INVALID_REQUEST",
        "Provide a stable requestId and summary; reviews need 1–8 self-checks, task requests need none; planId and taskId must appear together",
      );
    const id = `${kind === "task" ? "request" : "review"}-${digest({ sessionId, requestId }).slice(0, 32)}`;
    const inputHash = digest({
      sessionId,
      requestId,
      summary,
      checks,
      planId,
      taskId,
      ...(kind === "task" ? { kind } : {}),
    });
    return this.exclusive(id, async () => {
      const prior = await this.read(id).catch((e) => {
        if (e.code !== "ENOENT") throw e;
      });
      if (prior) {
        if (prior.inputHash !== inputHash)
          fail(
            "IDEMPOTENCY_CONFLICT",
            "Review requestId reused with different content",
          );
        return prior;
      }
      cwd = await realpath(cwd);
      const assigned = (await this.plans.list()).flatMap((plan) =>
        plan.tasks.map((task) => ({ planId: plan.id, taskId: task.id,
          sessionId: task.execution?.sessionId })),
      ).find((task) => task.sessionId === sessionId);
      if (assigned && (assigned.planId !== planId || assigned.taskId !== taskId))
        fail("PLAN_ID_REQUIRED", "This DSH worker must request review through its assigned plan task");
      const source = await snapshot(cwd);
      let planRevision = null;
      if (planId) {
        const plan = await this.plans.read(planId);
        const task = plan.tasks.find((x) => x.id === taskId);
        if (
          plan.state !== "running" ||
          !task ||
          !["running", "waiting_user"].includes(task.state) ||
          task.execution?.sessionId !== sessionId ||
          (await realpath(task.worktree.path)) !== cwd
        )
          fail(
            "NOT_PLAN_WORKER",
            "Only the running DSH session for this task may request its review",
          );
        planRevision = task.revision;
      }
      return this.save({
        id,
        requestId,
        inputHash,
        sessionId,
        ...source,
        summary,
        checks,
        kind,
        planId: planId || null,
        taskId: taskId || null,
        planRevision,
        state: "requested",
        createdAt: new Date().toISOString(),
      });
    });
  }
  async list({ cwd }) {
    const repo = await repository(await realpath(cwd));
    if (!repo.base) fail("BASELINE_REQUIRED", "Confirm a Git baseline first");
    const commonDir = await realpath(
      await git(
        repo.cwd,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ),
    );
    const files = await readdir(this.dataDir).catch((e) => {
      if (e.code !== "ENOENT") throw e;
      return [];
    });
    const requests = await Promise.all(
      files
        .filter((f) => f.endsWith(".json"))
        .map((f) => this.read(f.slice(0, -5))),
    );
    return requests
      .filter((x) => x.commonDir === commonDir)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async status({ id }) {
    return this.read(id);
  }
  async respond({ id, accepted, feedback, evidence }) {
    if (
      typeof accepted !== "boolean" ||
      !nonempty(feedback, 2000) ||
      !Array.isArray(evidence) ||
      !evidence.length ||
      evidence.length > 8 ||
      !evidence.every((x) => nonempty(x, 500))
    )
      fail(
        "INVALID_REVIEW",
        "Provide an independent verdict, feedback and evidence",
      );
    return this.exclusive(id, async () => {
      const item = await this.read(id);
      if (item.planId && item.kind !== "task")
        fail(
          "PLAN_REVIEW_REQUIRED",
          "Use plan.review for a managed task and its repair budget",
        );
      if (item.response) {
        if (
          item.response.accepted === accepted &&
          item.response.feedback === feedback &&
          digest(item.response.evidence) === digest(evidence)
        )
          return item;
        fail(
          "REVIEW_CONFLICT",
          "This request already has a different response",
        );
      }
      if (item.kind !== "task") {
        const current = await snapshot(item.cwd);
        if (current.fingerprint !== item.fingerprint)
          fail("STALE_SNAPSHOT", "Repository changed after the DSH review request");
      }
      item.state = "responded";
      item.response = {
        accepted,
        feedback,
        evidence,
        at: new Date().toISOString(),
      };
      return this.save(item);
    });
  }
}
