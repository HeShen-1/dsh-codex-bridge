import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename, realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { outcome } from "./dsh-backend.js";
const exec = promisify(execFile);
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function git(cwd, ...args) {
  return (await exec("git", ["-C", cwd, ...args], { maxBuffer: 8e6 })).stdout.trim();
}
const fail = (code, message) => {
  throw Object.assign(new Error(message), { code });
};
class Jobs {
  backend;
  dataDir;
  locks;
  stopping;
  constructor(backend, dataDir) {
    this.backend = backend;
    this.dataDir = dataDir;
    this.locks = /* @__PURE__ */ new Map();
    this.stopping = false;
  }
  async exclusive(key, action) {
    const previous = this.locks.get(key) || Promise.resolve();
    const current = previous.catch(() => {
    }).then(action);
    this.locks.set(key, current);
    try {
      return await current;
    } finally {
      if (this.locks.get(key) === current) this.locks.delete(key);
    }
  }
  file(id) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id || ""))
      fail(
        "INVALID_ID",
        "Use a stable task ID containing letters, digits, dash or underscore"
      );
    return join(this.dataDir, `${id}.json`);
  }
  async read(id) {
    return JSON.parse(await readFile(this.file(id), "utf8"));
  }
  async save(job) {
    await mkdir(this.dataDir, { recursive: true, mode: 448 });
    const file = this.file(job.id);
    await writeFile(file + ".tmp", JSON.stringify(job, null, 2) + "\n", {
      mode: 384
    });
    await rename(file + ".tmp", file);
    return job;
  }
  async submit(input) {
    let { id, cwd, prompt, sourceTask = "" } = input;
    this.file(id);
    if (typeof prompt !== "string" || !prompt.trim())
      fail("INVALID_PROMPT", "A non-empty task prompt is required");
    cwd = await realpath(cwd);
    return this.exclusive(id, async () => {
      const hash = digest({ cwd, prompt, sourceTask });
      let job = await this.read(id).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      if (job) {
        if (job.hash !== hash)
          fail(
            "IDEMPOTENCY_CONFLICT",
            "Task ID already belongs to different input"
          );
        return this.refresh(job);
      }
      if (this.stopping) fail("STOPPING", "Plugin is stopping");
      try {
        await git(cwd, "rev-parse", "--show-toplevel");
      } catch {
        await git(cwd, "init", "-b", "main");
      }
      let base;
      try {
        base = await git(cwd, "rev-parse", "--verify", "HEAD");
      } catch {
        fail(
          "BASELINE_REQUIRED",
          "Git initialized; confirm the initial file list and create a baseline commit before execution"
        );
      }
      job = {
        id,
        cwd,
        prompt,
        sourceTask,
        hash,
        base,
        sessionId: `bridge-${digest({ id, cwd }).slice(0, 32)}`,
        requestId: `bridge-${digest({ id, cwd, prompt }).slice(0, 32)}`,
        state: "preparing",
        createdAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      await this.save(job);
      try {
        await this.backend.create(job.sessionId, cwd);
        job.state = "dispatching";
        await this.save(job);
        await this.backend.send(job.sessionId, job.requestId, prompt);
        job.state = "running";
      } catch (error) {
        job.state = "unknown";
        job.error = error.message;
      }
      return this.save(job);
    });
  }
  async refresh(job) {
    if (["stopped", "submitted", "failed"].includes(job.state)) return job;
    try {
      const inspection = await this.backend.inspect(job.sessionId);
      const result = outcome(inspection.events, job.requestId);
      if (result) job.result = result;
      job.actualCwd = inspection.cwd;
      job.pendingApprovals = inspection.pendingApprovals || [];
      job.pendingQuestions = inspection.pendingQuestions || [];
      if (result?.finished && !inspection.running)
        job.state = job.state === "stop_requested" ? "stopped" : result.reason?.kind === "completed" ? "submitted" : "failed";
      else if (inspection.running) {
        if (job.state !== "stop_requested")
          job.state = job.pendingApprovals.length || job.pendingQuestions.length ? "waiting_user" : "running";
      } else job.state = "unknown";
    } catch (error) {
      job.state = "unknown";
      job.error = error.message;
    }
    return this.save(job);
  }
  async status({ id }) {
    return this.exclusive(id, async () => this.refresh(await this.read(id)));
  }
  async steer({ id, message, requestId }) {
    if (!requestId || typeof message !== "string" || !message.trim())
      fail(
        "INVALID_INPUT",
        "Steering needs a stable requestId and non-empty message"
      );
    return this.exclusive(id, async () => {
      const job = await this.refresh(await this.read(id));
      if (job.state !== "running")
        fail(
          "NOT_RUNNING",
          "Steering is only allowed while the task is running"
        );
      job.messages ||= {};
      if (job.messages[requestId] && job.messages[requestId] !== message)
        fail(
          "IDEMPOTENCY_CONFLICT",
          "Steering requestId reused with different text"
        );
      job.messages[requestId] = message;
      await this.save(job);
      await this.backend.send(job.sessionId, requestId, message, "steer");
      return job;
    });
  }
  async stop({ id }) {
    let sessionId;
    await this.exclusive(id, async () => {
      const job = await this.read(id);
      if (["stopped", "submitted", "failed"].includes(job.state)) return;
      job.state = "stop_requested";
      sessionId = job.sessionId;
      await this.save(job);
    });
    if (sessionId) {
      const confirmed = await this.backend.stop(sessionId);
      if (confirmed)
        await this.exclusive(id, async () => {
          const job = await this.read(id);
          job.state = "stopped";
          await this.save(job);
        });
    }
    return this.status({ id });
  }
}
export {
  Jobs,
  digest,
  fail,
  git
};
