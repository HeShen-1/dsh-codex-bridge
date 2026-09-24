import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, fail } from "./jobs.js";
import { changed } from "./repository.js";
const exec = promisify(execFile);
async function command(bin, args, cwd) {
  return (await exec(bin, args, {
    cwd,
    timeout: 3e4,
    maxBuffer: 8e6,
    env: {
      ...process.env,
      GH_PROMPT_DISABLED: "1",
      GLAB_CHECK_UPDATE: "false",
      GIT_TERMINAL_PROMPT: "0"
    }
  })).stdout.trim();
}
function address(value) {
  if (/^git@[^:]+:/.test(value))
    value = value.replace(/^git@([^:]+):/, "ssh://git@$1/");
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("REMOTE_REQUIRED", "A hosted Git remote URL is required");
  }
  if (url.password || url.username && url.username !== "git")
    fail("CREDENTIAL_URL", "Use credential-free remote URLs");
  return {
    host: url.hostname,
    path: url.pathname.replace(/^\//, "").replace(/\.git$/, "")
  };
}
class Forge {
  run;
  constructor(run = command) {
    this.run = run;
  }
  async validate(plan) {
    const d = plan.delivery;
    if (!["github", "gitlab"].includes(d.forge) || !["origin", ...(await git(plan.cwd, "remote")).split("\n")].includes(
      d.remote
    ) || !d.repository || !d.targetBranch || !d.host)
      fail(
        "DELIVERY_CONFIG",
        "Delivery requires forge, host, repository, existing remote and targetBranch"
      );
    if (!/^[a-zA-Z0-9.-]+(?::\d+)?$/.test(d.host) || !/^[-a-zA-Z0-9_.]+(?:\/[-a-zA-Z0-9_.]+)+$/.test(d.repository))
      fail("DELIVERY_CONFIG", "Invalid host or repository");
    await git(plan.cwd, "check-ref-format", "--branch", d.targetBranch);
    const url = await git(plan.cwd, "remote", "get-url", "--push", d.remote);
    const remote = address(url);
    if (remote.host !== d.host.split(":")[0] || remote.path !== d.repository)
      fail(
        "REMOTE_MISMATCH",
        "Push remote does not match the approved issue/PR destination"
      );
    return d;
  }
  target(d) {
    return `${d.host}/${d.repository}`;
  }
  async findIssues(plan, marker) {
    const d = plan.delivery, args = d.forge === "github" ? [
      "issue",
      "list",
      "--repo",
      this.target(d),
      "--state",
      "all",
      "--search",
      marker,
      "--limit",
      "100",
      "--json",
      "number,body,url"
    ] : [
      "issue",
      "list",
      "--repo",
      this.target(d),
      "--all",
      "--search",
      marker,
      "--per-page",
      "100",
      "--output",
      "json"
    ];
    const rows = JSON.parse(
      await this.run(d.forge === "github" ? "gh" : "glab", args, plan.cwd)
    );
    return rows.filter((x) => (x.body || x.description || "").includes(marker)).map((x) => ({ number: x.number ?? x.iid, url: x.url ?? x.web_url }));
  }
  async withBody(body, action) {
    const dir = await mkdtemp(join(tmpdir(), "bridge-forge-"));
    try {
      const path = join(dir, "body.md");
      await writeFile(path, body, { mode: 384 });
      return await action(path);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  async issue(plan, task, persist) {
    if (!plan.delivery || task.synthetic) return;
    await this.validate(plan);
    const d = plan.delivery, marker = `dsh-bridge:${plan.id}:${task.id}`;
    if (task.issue?.url) return task.issue;
    const found = await this.findIssues(plan, marker);
    if (found.length > 1)
      fail("REMOTE_DUPLICATES", "Multiple matching issues; resolve manually");
    if (found.length) {
      task.issue = found[0];
      await persist();
      return task.issue;
    }
    if (task.issueIntent)
      fail(
        "REMOTE_UNKNOWN",
        "Issue creation was attempted; no confirmed result yet. Inspect remote before retrying"
      );
    task.issueIntent = true;
    await persist();
    const body = `${task.prompt}

\u5141\u8BB8\u4FEE\u6539\uFF1A${task.files.join(", ")}

\u4F9D\u8D56\uFF1A${task.dependsOn.join(", ") || "\u65E0"}

\u9A8C\u6536\uFF1A
${task.acceptance.map((x) => "- " + x).join("\n")}

\u6267\u884C\u65B9\u63D0\u4EA4\u8BC1\u636E\uFF0CCodex \u590D\u6838\uFF1B\u5408\u5E76\u7531\u7528\u6237\u51B3\u5B9A\u3002

<!-- ${marker} -->
`;
    const title = `[${plan.id}/${task.id}] ${task.title}`;
    const output = await this.withBody(
      body,
      (path) => this.run(
        d.forge === "github" ? "gh" : "glab",
        d.forge === "github" ? [
          "issue",
          "create",
          "--repo",
          this.target(d),
          "--title",
          title,
          "--body-file",
          path
        ] : [
          "issue",
          "create",
          "--repo",
          this.target(d),
          "--title",
          title,
          "--description-file",
          path,
          "--yes"
        ],
        plan.cwd
      )
    );
    const url = output.match(/https?:\/\/[^\s]+\/(?:issues|issues\/)\/??\d+/)?.[0] || output.match(/https?:\/\/[^\s]+\/\d+/)?.[0];
    if (!url)
      fail(
        "REMOTE_UNKNOWN",
        "Issue command completed without a usable URL; reconcile by marker"
      );
    task.issue = { url, number: Number(url.split("/").at(-1)) };
    await persist();
    return task.issue;
  }
  async deliver(plan, persist) {
    if (!["reviewed", "delivery_unknown", "awaiting_merge"].includes(plan.state))
      fail(
        "NOT_REVIEWED",
        "All tasks and integration must pass Codex review before delivery"
      );
    if (!plan.delivery)
      fail(
        "REMOTE_REQUIRED",
        "No remote delivery approved; local commits remain available"
      );
    await this.validate(plan);
    for (const t of plan.tasks)
      if (!t.synthetic) await this.issue(plan, t, persist);
    const d = plan.delivery, task = plan.tasks.at(-1);
    if (plan.pr) return plan;
    const cwd = task.worktree.path, head = task.evidence.head, branch = task.worktree.branch;
    if (await git(cwd, "rev-parse", "HEAD") !== head || (await changed(cwd)).length)
      fail(
        "WORKTREE_CHANGED",
        "Delivery worktree differs from reviewed evidence"
      );
    for (const t of plan.tasks)
      await git(cwd, "merge-base", "--is-ancestor", t.evidence.head, head);
    await git(cwd, "fetch", d.remote, d.targetBranch);
    const target = await git(cwd, "rev-parse", "FETCH_HEAD");
    try {
      await git(cwd, "merge-base", "--is-ancestor", target, head);
    } catch {
      fail(
        "TARGET_ADVANCED",
        "Target branch advanced; re-integrate and re-review before delivery"
      );
    }
    const remoteHead = (await git(cwd, "ls-remote", "--heads", d.remote, `refs/heads/${branch}`)).split(/\s/)[0];
    if (remoteHead && remoteHead !== head)
      fail(
        "REMOTE_BRANCH_CONFLICT",
        "Remote branch has a different head; do not overwrite it"
      );
    if (!remoteHead)
      await git(cwd, "push", d.remote, `${head}:refs/heads/${branch}`);
    if ((await git(cwd, "ls-remote", "--heads", d.remote, `refs/heads/${branch}`)).split(/\s/)[0] !== head)
      fail("PUSH_UNVERIFIED", "Remote ref does not match reviewed head");
    const args = d.forge === "github" ? [
      "pr",
      "list",
      "--repo",
      this.target(d),
      "--state",
      "all",
      "--head",
      branch,
      "--json",
      "url,body,state,baseRefName"
    ] : [
      "mr",
      "list",
      "--repo",
      this.target(d),
      "--all",
      "--source-branch",
      branch,
      "--output",
      "json"
    ];
    const found = JSON.parse(
      await this.run(d.forge === "github" ? "gh" : "glab", args, cwd)
    );
    const marker = `dsh-bridge-plan:${plan.id}`;
    if (found.length > 1)
      fail(
        "REMOTE_DUPLICATES",
        "Multiple PR/MRs for this branch; resolve manually"
      );
    if (found.length) {
      const pr = found[0];
      if ((pr.baseRefName || pr.target_branch) !== d.targetBranch)
        fail(
          "REMOTE_TARGET_CONFLICT",
          "Existing PR/MR targets a different branch"
        );
      if (!(pr.body || pr.description || "").includes(marker))
        fail(
          "REMOTE_BRANCH_CONFLICT",
          "Existing PR/MR does not belong to this plan"
        );
      plan.pr = pr.url || pr.web_url;
      plan.state = "awaiting_merge";
      await persist();
      return plan;
    }
    if (plan.prIntent)
      fail(
        "REMOTE_UNKNOWN",
        "PR creation was attempted; query the remote before retrying"
      );
    plan.prIntent = true;
    plan.state = "delivery_unknown";
    await persist();
    const body = `${plan.goal}

${plan.tasks.map((t) => `- ${t.title}: ${t.evidence.head}
  \u9A8C\u8BC1\uFF1A${t.reviews.at(-1).evidence.join("; ")}${t.issue ? "\n  Closes #" + t.issue.number : ""}`).join("\n")}

\u7EC4\u5408\u540E\u7684\u4EE3\u7801\u5DF2\u7531 Codex \u590D\u6838\uFF1B\u8349\u7A3F\u5F85\u7528\u6237\u51B3\u5B9A\u5408\u5E76\u3002

<!-- ${marker} -->
`;
    const output = await this.withBody(
      body,
      (path) => this.run(
        d.forge === "github" ? "gh" : "glab",
        d.forge === "github" ? [
          "pr",
          "create",
          "--repo",
          this.target(d),
          "--head",
          branch,
          "--base",
          d.targetBranch,
          "--draft",
          "--title",
          plan.goal.slice(0, 150),
          "--body-file",
          path
        ] : [
          "mr",
          "create",
          "--repo",
          this.target(d),
          "--source-branch",
          branch,
          "--target-branch",
          d.targetBranch,
          "--draft",
          "--title",
          plan.goal.slice(0, 150),
          "--description-file",
          path,
          "--yes"
        ],
        cwd
      )
    );
    const url = output.match(
      /https?:\/\/[^\s]+\/(?:pull|merge_requests)\/\d+/
    )?.[0];
    if (!url) fail("REMOTE_UNKNOWN", "PR creation result needs reconciliation");
    plan.pr = url;
    plan.state = "awaiting_merge";
    await persist();
    return plan;
  }
}
export {
  Forge,
  command
};
