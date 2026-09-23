import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Jobs, git } from "../src/jobs.js";
import { listen, request } from "../src/transport.js";
async function fixture(t, committed = true) {
  const dir = await mkdtemp(join(tmpdir(), "bridge-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await git(dir, "init", "-b", "main");
  if (committed)
    await git(
      dir,
      "-c",
      "user.name=Bridge Test",
      "-c",
      "user.email=bridge@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "test baseline",
    );
  const backend = {
    calls: 0,
    events: [],
    running: true,
    async create() {},
    async send(s, r, p) {
      this.calls++;
      this.requestId = r;
    },
    async inspect() {
      return this;
    },
    async stop() {
      this.running = false;
      return true;
    },
  };
  return { dir, backend, jobs: new Jobs(backend, join(dir, "state")) };
}
test("concurrent identical submissions and a reloaded store only dispatch once", async (t) => {
  const { dir, backend, jobs } = await fixture(t);
  const input = { id: "once", cwd: dir, prompt: "hello" };
  const results = await Promise.all(
    Array.from({ length: 12 }, () => jobs.submit(input)),
  );
  assert.equal(backend.calls, 1);
  assert.equal(new Set(results.map((x) => x.sessionId)).size, 1);
  const restarted = new Jobs(backend, jobs.dataDir);
  await restarted.submit(input);
  assert.equal(backend.calls, 1);
  await assert.rejects(jobs.submit({ ...input, prompt: "different" }), {
    code: "IDEMPOTENCY_CONFLICT",
  });
});
test("uncommitted repository blocks dispatch", async (t) => {
  const { dir, backend, jobs } = await fixture(t, false);
  await assert.rejects(
    jobs.submit({ id: "baseline", cwd: dir, prompt: "hello" }),
    { code: "BASELINE_REQUIRED" },
  );
  assert.equal(backend.calls, 0);
});
test("finished turn is submitted for review, not accepted", async (t) => {
  const { dir, backend, jobs } = await fixture(t);
  const job = await jobs.submit({ id: "done", cwd: dir, prompt: "hello" });
  backend.running = false;
  backend.events = [
    { seq: 0, type: "turn/start", data: { turn: 1 } },
    {
      seq: 1,
      type: "user/message",
      data: { source: { rpcId: job.requestId } },
    },
    {
      seq: 2,
      type: "assistant/message",
      data: { turn: 1, message: { content: [{ type: "text", text: "DONE" }] } },
    },
    {
      seq: 3,
      type: "turn/end",
      data: { turn: 1, reason: { kind: "completed" } },
    },
  ];
  const result = await jobs.status({ id: job.id });
  assert.equal(result.state, "submitted");
  assert.equal(result.result.text, "DONE");
});
test("uncertain admission is never automatically sent again", async (t) => {
  const { dir, backend, jobs } = await fixture(t);
  backend.send = async () => {
    backend.calls++;
    throw new Error("lost ack");
  };
  backend.running = false;
  const input = { id: "unknown", cwd: dir, prompt: "hello" };
  assert.equal((await jobs.submit(input)).state, "unknown");
  await jobs.submit(input);
  assert.equal(backend.calls, 1);
});
test("stop waits for backend quiescence and blocks later steering", async (t) => {
  const { dir, backend, jobs } = await fixture(t);
  await jobs.submit({ id: "stop", cwd: dir, prompt: "hello" });
  let release;
  backend.stop = () =>
    new Promise((r) => {
      release = r;
    });
  const stopping = jobs.stop({ id: "stop" });
  while (!release) await new Promise((r) => setImmediate(r));
  assert.equal((await jobs.read("stop")).state, "stop_requested");
  await assert.rejects(
    jobs.steer({ id: "stop", requestId: "late", message: "continue" }),
    { code: "NOT_RUNNING" },
  );
  release(true);
  assert.equal((await stopping).state, "stopped");
});
test("RPC uses a private unix socket and refuses second server", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-socket-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const socketPath = join(dir, "bridge.sock");
  const close = await listen(socketPath, async (m, p) => ({ method: m, ...p }));
  t.after(close);
  assert.deepEqual(await request("hello", { ok: true }, { socketPath }), {
    method: "hello",
    ok: true,
  });
  await assert.rejects(
    listen(socketPath, () => ({})),
    /already running/,
  );
});
test("DSH adapter passes actual workspaceId and verifies persisted cwd before sending", async (t) => {
  const { dir } = await fixture(t);
  const { DshBackend } = await import("../src/dsh-backend.js");
  let captured;
  const ctx = {
    workspaceController: {
      async create() {
        return { workspace: { workspaceId: "workspace-real", path: dir } };
      },
    },
    sessionController: {
      async create(req) {
        captured = req;
        return req;
      },
      async inspect() {
        return { meta: { cwd: dir } };
      },
    },
  };
  await new DshBackend(ctx).create("session-test", dir);
  assert.deepEqual(captured, {
    sessionId: "session-test",
    workspaceId: "workspace-real",
  });
  ctx.sessionController.inspect = async () => ({ meta: { cwd: tmpdir() } });
  await assert.rejects(
    new DshBackend(ctx).create("wrong", dir),
    /cwd does not match/,
  );
  ctx.workspaceController.create = async () => ({
    workspace: { id: "wrong-field" },
  });
  await assert.rejects(
    new DshBackend(ctx).create("bad-schema", dir),
    /no workspaceId/,
  );
});
test("pending DSH approval is exposed and resumes only after an actual decision", async (t) => {
  const { dir, backend, jobs } = await fixture(t);
  await jobs.submit({ id: "approval", cwd: dir, prompt: "hello" });
  backend.pendingApprovals = [
    { id: "decision-1", reason: "needs explicit access" },
  ];
  assert.equal((await jobs.status({ id: "approval" })).state, "waiting_user");
  backend.pendingApprovals = [];
  assert.equal((await jobs.status({ id: "approval" })).state, "running");
});
