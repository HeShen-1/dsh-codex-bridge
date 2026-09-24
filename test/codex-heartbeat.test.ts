import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodexHeartbeat } from "../src/codex-heartbeat.js";
import { git } from "../src/jobs.js";

test("Codex heartbeat is scoped to the Git repository and survives reload", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "bridge-presence-repo-"));
  const dataDir = await mkdtemp(join(tmpdir(), "bridge-presence-data-"));
  t.after(() => Promise.all([
    rm(cwd, { recursive: true, force: true }),
    rm(dataDir, { recursive: true, force: true }),
  ]));
  await git(cwd, "init", "-b", "main");
  await git(cwd, "-c", "user.name=Bridge Test", "-c", "user.email=bridge@test.local", "commit", "--allow-empty", "-m", "baseline");
  const heartbeat = new CodexHeartbeat(null, dataDir);
  assert.equal(await heartbeat.getStatus({ cwd }), null);
  const threadId = "01a0cd54-9a1e-7df2-af6a-66e923f0571d";
  const reported = await heartbeat.report({ cwd, threadId, taskStatus: "active" });
  assert.equal(reported.threadId, threadId);
  assert.equal((await new CodexHeartbeat(null, dataDir).getStatus({ cwd })).taskStatus, "active");
  await assert.rejects(
    heartbeat.report({ cwd, threadId: "bad", taskStatus: "active" }),
    /Codex task ID/,
  );
  await assert.rejects(
    heartbeat.report({ cwd, threadId, taskStatus: "online" }),
    /observed task status/,
  );
});
