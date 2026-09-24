import { realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Jobs, fail, git } from "./jobs.js";
import { repository } from "./repository.js";
class CodexHeartbeat extends Jobs {
  async key(cwd) {
    const repo = await repository(await realpath(cwd));
    if (!repo.base) fail("BASELINE_REQUIRED", "Confirm a Git baseline first");
    const commonDir = await realpath(
      await git(repo.cwd, "rev-parse", "--path-format=absolute", "--git-common-dir")
    );
    return `codex-${createHash("sha256").update(commonDir).digest("hex").slice(0, 32)}`;
  }
  async getStatus({ cwd }) {
    const id = await this.key(cwd);
    return this.read(id).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
  }
  async report({ cwd, threadId, taskStatus }) {
    if (!/^[0-9a-f-]{36}$/i.test(threadId || "") || !["active", "idle", "needs_attention", "unknown"].includes(taskStatus))
      fail("INVALID_HEARTBEAT", "Provide a Codex task ID and observed task status");
    const id = await this.key(cwd);
    return this.exclusive(id, async () => this.save({
      id,
      threadId,
      taskStatus,
      checkedAt: (/* @__PURE__ */ new Date()).toISOString()
    }));
  }
}
export {
  CodexHeartbeat
};
