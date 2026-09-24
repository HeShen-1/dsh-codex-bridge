import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Jobs, git } from "../src/jobs.js";
import { Plans } from "../src/plans.js";
import { baselinePreview, baselineConfirm } from "../src/repository.js";
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "bridge-plan-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await git(dir, "init", "-b", "main");
  await git(dir, "config", "user.name", "Bridge Test");
  await git(dir, "config", "user.email", "bridge@example.invalid");
  await writeFile(join(dir, "base.txt"), "base\n");
  await git(dir, "add", "base.txt");
  await git(dir, "commit", "-m", "baseline");
  const sessions = new Map();
  const backend = {
    calls: 0,
    async create(id, cwd) {
      sessions.set(id, { cwd, events: [], running: false });
    },
    async send(id, r, p) {
      this.calls++;
      const s = sessions.get(id);
      s.requestId = r;
      s.running = true;
    },
    async inspect(id) {
      return sessions.get(id);
    },
    async stop(id) {
      sessions.get(id).running = false;
      return true;
    },
  };
  const jobs = new Jobs(backend, join(dir, ".git/jobs"));
  const plans = new Plans(jobs, join(dir, ".git/plans"));
  const task = (id, dependsOn = []) => ({
    id,
    title: id,
    prompt: "Implement " + id,
    files: [id + ".txt"],
    acceptance: ["Verify " + id],
    dependsOn,
  });
  async function finish(plan, taskId, content = "done") {
    const task = plan.tasks.find((x) => x.id === taskId);
    const s = sessions.get(task.execution.sessionId);
    if (taskId !== "integration")
      await writeFile(join(s.cwd, taskId + ".txt"), content);
    s.events = [
      { seq: 0, type: "turn/start", data: { turn: 1 } },
      {
        seq: 1,
        type: "user/message",
        data: { source: { rpcId: s.requestId } },
      },
      {
        seq: 2,
        type: "assistant/message",
        data: {
          turn: 1,
          message: { content: [{ type: "text", text: "checked" }] },
        },
      },
      {
        seq: 3,
        type: "turn/end",
        data: { turn: 1, reason: { kind: "completed" } },
      },
    ];
    s.running = false;
    return plans.status({ id: plan.id });
  }
  async function accept(plan, id) {
    const task = plan.tasks.find((x) => x.id === id);
    return plans.review({
      id: plan.id,
      taskId: id,
      reviewHash: task.reviewHash,
      accepted: true,
      feedback: "Reviewed file and test evidence",
      evidence: ["test-result-1"],
    });
  }
  return { dir, plans, jobs, backend, task, finish, accept };
}
test("parallel worktrees preserve source edits and integration waits for reviews", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.dir, "base.txt"), "user unfinished edit\n");
  let plan = await f.plans.preview({
    id: "parallel",
    cwd: f.dir,
    goal: "two features",
    tasks: [f.task("a"), f.task("b")],
  });
  assert.equal(f.backend.calls, 0);
  await assert.rejects(f.plans.approve({ id: plan.id, hash: "wrong" }), {
    code: "PLAN_CHANGED",
  });
  plan = await f.plans.approve({ id: plan.id, hash: plan.hash });
  assert.equal(f.backend.calls, 2);
  assert.equal(plan.tasks[2].state, "pending");
  assert.notEqual(plan.tasks[0].worktree.path, plan.tasks[1].worktree.path);
  assert.equal(
    await readFile(join(plan.tasks[0].worktree.path, "base.txt"), "utf8"),
    "base\n",
  );
  plan = await f.finish(plan, "a");
  plan = await f.accept(plan, "a");
  assert.equal(f.backend.calls, 2);
  plan = await f.finish(plan, "b");
  plan = await f.accept(plan, "b");
  assert.equal(f.backend.calls, 3);
  const merged = plan.tasks[2].worktree.path;
  assert.equal(await readFile(join(merged, "a.txt"), "utf8"), "done");
  assert.equal(await readFile(join(merged, "b.txt"), "utf8"), "done");
  plan = await f.finish(plan, "integration");
  plan = await f.accept(plan, "integration");
  assert.equal(plan.state, "reviewed");
  assert.equal(
    await readFile(join(f.dir, "base.txt"), "utf8"),
    "user unfinished edit\n",
  );
});
test("dependencies start only after acceptance, stop halts all pending/running work", async (t) => {
  const f = await fixture(t);
  let p = await f.plans.preview({
    id: "deps",
    cwd: f.dir,
    goal: "dependency",
    tasks: [f.task("a"), f.task("b", ["a"])],
  });
  p = await f.plans.approve({ id: p.id, hash: p.hash });
  assert.equal(f.backend.calls, 1);
  p = await f.finish(p, "a");
  assert.equal(f.backend.calls, 1);
  p = await f.accept(p, "a");
  assert.equal(f.backend.calls, 2);
  p = await f.plans.stop({ id: p.id });
  assert.equal(p.state, "stopped");
  await f.plans.tick(p.id);
  assert.equal(f.backend.calls, 2);
});
test("same blocker twice stops repair without consuming all three rounds", async (t) => {
  const f = await fixture(t);
  let p = await f.plans.preview({
    id: "repair",
    cwd: f.dir,
    goal: "repair",
    tasks: [f.task("a")],
  });
  p = await f.plans.approve({ id: p.id, hash: p.hash });
  for (let i = 0; i < 2; i++) {
    p = await f.finish(p, "a", "round" + i);
    const task = p.tasks[0];
    p = await f.plans.review({
      id: p.id,
      taskId: "a",
      reviewHash: task.reviewHash,
      accepted: false,
      feedback: "same failure",
      evidence: ["failure.log"],
      blockerKey: "test-failure",
      progress: false,
    });
  }
  assert.equal(p.tasks[0].state, "blocked");
  assert.equal(f.backend.calls, 2);
  assert.equal(p.repairRounds, 1);
});
test("scope violation remains blocked and out-of-scope file is not committed", async (t) => {
  const f = await fixture(t);
  let p = await f.plans.preview({
    id: "scope",
    cwd: f.dir,
    goal: "scope",
    tasks: [f.task("a")],
  });
  p = await f.plans.approve({ id: p.id, hash: p.hash });
  await writeFile(join(p.tasks[0].worktree.path, "outside.txt"), "bad");
  p = await f.finish(p, "a");
  assert.equal(p.tasks[0].state, "blocked");
  assert.match(p.tasks[0].error, /outside/);
});
test("stale code cannot be accepted by an old review", async (t) => {
  const f = await fixture(t);
  let p = await f.plans.preview({
    id: "stale",
    cwd: f.dir,
    goal: "stale",
    tasks: [f.task("a")],
  });
  p = await f.plans.approve({ id: p.id, hash: p.hash });
  p = await f.finish(p, "a");
  await writeFile(join(p.tasks[0].worktree.path, "a.txt"), "new change");
  await assert.rejects(f.accept(p, "a"), { code: "WORKTREE_CHANGED" });
});
test("baseline confirms exact content and excludes credentials", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-baseline-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "a.txt"), "first");
  await writeFile(join(dir, ".env"), "TEST_SECRET=do-not-stage");
  let b = await baselinePreview({ cwd: dir });
  if (!("files" in b)) throw new Error("expected baseline preview");
  assert.deepEqual(b.files, ["a.txt"]);
  assert.deepEqual(b.excluded, [".env"]);
  await writeFile(join(dir, "a.txt"), "changed");
  await assert.rejects(baselineConfirm(b), { code: "BASELINE_CHANGED" });
  await git(dir, "config", "user.name", "Bridge Test");
  await git(dir, "config", "user.email", "bridge@example.invalid");
  b = await baselinePreview({ cwd: dir });
  if (!("files" in b)) throw new Error("expected baseline preview");
  assert.ok((await baselineConfirm(b)).base);
  assert.equal(await git(dir, "ls-files"), "a.txt");
});
test("cyclic dependencies never create worktrees or call model", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.plans.preview({
      id: "cycle",
      cwd: f.dir,
      goal: "bad",
      tasks: [f.task("a", ["b"]), f.task("b", ["a"])],
    }),
    { code: "DEPENDENCY_CYCLE" },
  );
  assert.equal(f.backend.calls, 0);
});
test("three repair attempts are the shared plan maximum", async (t) => {
  const f = await fixture(t);
  let p = await f.plans.preview({
    id: "limit",
    cwd: f.dir,
    goal: "repair limit",
    tasks: [f.task("a")],
  });
  p = await f.plans.approve({ id: p.id, hash: p.hash });
  for (let i = 0; i < 4; i++) {
    p = await f.finish(p, "a", "round" + i);
    p = await f.plans.review({
      id: p.id,
      taskId: "a",
      reviewHash: p.tasks[0].reviewHash,
      accepted: false,
      feedback: "new failure " + i,
      evidence: ["test-" + i],
      blockerKey: "failure-" + i,
      progress: true,
    });
  }
  assert.equal(p.repairRounds, 3);
  assert.equal(f.backend.calls, 4);
  assert.equal(p.tasks[0].state, "blocked");
});
test("forge outage blocks publication but independent local execution proceeds", async (t) => {
  const f = await fixture(t);
  f.plans.forge = {
    async validate() {},
    async issue() {
      throw new Error("API unavailable");
    },
  };
  let p = await f.plans.preview({
    id: "forge-down",
    cwd: f.dir,
    goal: "local progress",
    tasks: [f.task("a")],
    delivery: { forge: "github" },
  });
  p = await f.plans.approve({ id: p.id, hash: p.hash });
  assert.equal(p.tasks[0].state, "running");
  assert.match(p.tasks[0].deliveryError.message, /unavailable/);
  assert.equal(f.backend.calls, 1);
});
