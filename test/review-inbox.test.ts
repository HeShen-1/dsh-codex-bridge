import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReviewInbox } from "../src/review-inbox.js";
import { registerDshTools } from "../src/dsh-tools.js";
import { git } from "../src/jobs.js";

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "bridge-review-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await git(cwd, "init", "-b", "main");
  await git(
    cwd,
    "-c",
    "user.name=Bridge Test",
    "-c",
    "user.email=bridge@test.local",
    "commit",
    "--allow-empty",
    "-m",
    "baseline",
  );
  return cwd;
}

test("DSH review request survives retry and Codex response requires unchanged files", async (t) => {
  const cwd = await fixture(t);
  const inboxDir = await mkdtemp(join(tmpdir(), "bridge-inbox-"));
  t.after(() => rm(inboxDir, { recursive: true, force: true }));
  const inbox = new ReviewInbox(inboxDir, {
    list: async () => [],
    read: async () => {
      throw Error("unexpected plan");
    },
  });
  await writeFile(join(cwd, "change.txt"), "first\n");
  const input = {
    requestId: "done-1",
    summary: "Implemented the change",
    checks: ["node --test: passed"],
  };
  const owner = { sessionId: "dsh-one", cwd };
  const sent = await inbox.submit(input, owner);
  assert.equal((await inbox.submit(input, owner)).id, sent.id);
  assert.equal((await inbox.list({ cwd }))[0].sessionId, "dsh-one");
  await assert.rejects(
    inbox.submit({ ...input, summary: "different" }, owner),
    /different content/,
  );
  await writeFile(join(cwd, "change.txt"), "second\n");
  await assert.rejects(
    inbox.respond({
      id: sent.id,
      accepted: true,
      feedback: "pass",
      evidence: ["file read"],
    }),
    /changed after/,
  );
  await writeFile(join(cwd, "change.txt"), "first\n");
  const reply = await inbox.respond({
    id: sent.id,
    accepted: true,
    feedback: "pass",
    evidence: ["file read"],
  });
  assert.equal(reply.response.accepted, true);
  assert.equal(
    (
      await inbox.respond({
        id: sent.id,
        accepted: true,
        feedback: "pass",
        evidence: ["file read"],
      })
    ).id,
    sent.id,
  );
  await assert.rejects(
    inbox.respond({
      id: sent.id,
      accepted: false,
      feedback: "fail",
      evidence: ["file read"],
    }),
    /different response/,
  );
});

test("DSH Tool binds review to real caller and managed plan rejects another session", async (t) => {
  const cwd = await fixture(t);
  const plan = {
    state: "running",
    tasks: [
      {
        id: "alpha",
        state: "running",
        execution: { sessionId: "dsh-one" },
        worktree: { path: cwd },
      },
    ],
  };
  const plans = { read: async () => plan, list: async () => [{ id: "plan-1", ...plan }] };
  const inboxDir = await mkdtemp(join(tmpdir(), "bridge-inbox-"));
  t.after(() => rm(inboxDir, { recursive: true, force: true }));
  const inbox = new ReviewInbox(inboxDir, plans);
  const defs = new Map();
  registerDshTools(
    { tools: { register: (x) => defs.set(x.name, x) } },
    inbox,
    plans,
  );
  const request = defs.get("request_codex_review");
  const check = defs.get("check_codex_review");
  assert.ok(request && check);
  const args = {
    requestId: "alpha-0",
    summary: "Read-only check",
    checks: ["git status: clean"],
    planId: "plan-1",
    taskId: "alpha",
  };
  const exec = (id) => ({
    signal: new AbortController().signal,
    agent: { session: { id, header: { cwd } } },
  });
  await assert.rejects(
    request.execute({ ...args, planId: undefined, taskId: undefined }, exec("dsh-one")),
    /assigned plan task/,
  );
  await assert.rejects(
    request.execute(args, exec("dsh-other")),
    /Only the running DSH session/,
  );
  const sent = JSON.parse(await request.execute(args, exec("dsh-one")));
  assert.equal(sent.state, "requested");
  assert.equal(
    JSON.parse(await check.execute({ id: sent.id }, exec("dsh-one"))).state,
    "running",
  );
  await assert.rejects(
    check.execute({ id: sent.id }, exec("dsh-other")),
    /another DSH session/,
  );
  await assert.rejects(
    inbox.respond({
      id: sent.id,
      accepted: true,
      feedback: "pass",
      evidence: ["check"],
    }),
    /Use plan.review/,
  );
});

test("general DSH request is distinct from review and can be acknowledged after code changes", async (t) => {
  const cwd = await fixture(t);
  const inboxDir = await mkdtemp(join(tmpdir(), "bridge-inbox-"));
  t.after(() => rm(inboxDir, { recursive: true, force: true }));
  const inbox = new ReviewInbox(inboxDir, { list: async () => [] });
  const owner = { sessionId: "dsh-one", cwd };
  const input = { requestId: "question-1", summary: "Please inspect a new task", kind: "task" as const };
  const request = await inbox.submit(input, owner);
  assert.match(request.id, /^request-/);
  assert.equal(request.kind, "task");
  assert.equal((await inbox.submit(input, owner)).id, request.id);
  await assert.rejects(inbox.submit({ ...input, summary: "changed" }, owner), /different content/);
  await assert.rejects(inbox.submit({ ...input, checks: ["not allowed"] }, owner), /task requests need none/);
  await writeFile(join(cwd, "later.txt"), "later\n");
  const reply = await inbox.respond({ id: request.id, accepted: true,
    feedback: "Request received for planning, no code accepted", evidence: ["inbox item read"] });
  assert.equal(reply.response.accepted, true);
  assert.equal((await inbox.list({ cwd }))[0].kind, "task");
});

test("DSH task-request Tool records the caller and reads Codex acknowledgment", async (t) => {
  const cwd = await fixture(t);
  const inboxDir = await mkdtemp(join(tmpdir(), "bridge-inbox-"));
  t.after(() => rm(inboxDir, { recursive: true, force: true }));
  const plans = { list: async () => [] };
  const inbox = new ReviewInbox(inboxDir, plans);
  const defs = new Map();
  registerDshTools({ tools: { register: (x) => defs.set(x.name, x) } }, inbox, plans);
  const exec = { signal: new AbortController().signal,
    agent: { session: { id: "dsh-one", header: { cwd } } } };
  const sent = JSON.parse(await defs.get("request_codex_task").execute({
    requestId: "task-1", summary: "Please plan the next change",
  }, exec));
  assert.match(sent.id, /^request-/);
  const listed = await inbox.list({ cwd });
  assert.equal(listed[0].sessionId, "dsh-one");
  assert.equal(listed[0].kind, "task");
  await inbox.respond({ id: sent.id, accepted: true, feedback: "I will plan it",
    evidence: ["request text read"] });
  const checked = JSON.parse(await defs.get("check_codex_request").execute({ id: sent.id }, exec));
  assert.equal(checked.kind, "task");
  assert.equal(checked.response.feedback, "I will plan it");
});
