import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Forge } from "../src/forge.js";
import { git } from "../src/jobs.js";
async function fixture(t, forge = "github") {
  const cwd = await mkdtemp(join(tmpdir(), "bridge-forge-test-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await git(cwd, "init", "-b", "main");
  await git(
    cwd,
    "remote",
    "add",
    "origin",
    "git@" +
      (forge === "github" ? "github.com" : "gitlab.example.test") +
      ":owner/project.git",
  );
  return {
    id: "plan",
    cwd,
    delivery: {
      forge,
      host: forge === "github" ? "github.com" : "gitlab.example.test",
      repository: "owner/project",
      remote: "origin",
      targetBranch: "main",
    },
  };
}
test("reject remote destination mismatch before invoking forge CLI", async (t) => {
  const p = await fixture(t);
  p.delivery.repository = "other/repo";
  let calls = 0;
  await assert.rejects(
    new Forge(async () => {
      calls++;
    }).validate(p),
    { code: "REMOTE_MISMATCH" },
  );
  assert.equal(calls, 0);
});
for (const platform of ["github", "gitlab"])
  test(`${platform} issue uses exact body-file content and reconciles lost response`, async (t) => {
    const plan = await fixture(t, platform);
    const task = {
      id: "a",
      title: "Test $() `literal`",
      prompt: "Line one\nLine two",
      files: ["a.txt"],
      dependsOn: [],
      acceptance: ["test it"],
    };
    let created = false,
      calls = 0;
    const forge = new Forge(async (bin, args) => {
      if (args[1] === "list")
        return JSON.stringify(
          created
            ? [
                platform === "github"
                  ? {
                      number: 12,
                      url: "https://github.com/owner/project/issues/12",
                      body: "<!-- dsh-bridge:plan:a -->",
                    }
                  : {
                      iid: 12,
                      web_url:
                        "https://gitlab.example.test/owner/project/-/issues/12",
                      description: "<!-- dsh-bridge:plan:a -->",
                    },
              ]
            : [],
        );
      calls++;
      const flag = platform === "github" ? "--body-file" : "--description-file";
      const body = await readFile(args[args.indexOf(flag) + 1], "utf8");
      assert.match(body, /Line one\nLine two/);
      assert.match(body, /dsh-bridge:plan:a/);
      created = true;
      throw new Error("response lost after remote creation");
    });
    await assert.rejects(
      forge.issue(plan, task, async () => {}),
      /response lost/,
    );
    assert.equal(task.issueIntent, true);
    const issue = await forge.issue(plan, task, async () => {});
    assert.equal(issue.number, 12);
    assert.equal(calls, 1);
  });
test("unknown remote creation never blindly repeats", async (t) => {
  const p = await fixture(t);
  const task = { id: "a", issueIntent: true };
  let creates = 0;
  const forge = new Forge(async (bin, args) => {
    if (args[1] === "list") return "[]";
    creates++;
  });
  await assert.rejects(
    forge.issue(p, task, async () => {}),
    { code: "REMOTE_UNKNOWN" },
  );
  assert.equal(creates, 0);
});
test("delivery verifies actual local Git push and creates one draft PR without merging", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "bridge-publish-test-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const bare = join(cwd, "remote.git"),
    repo = join(cwd, "repo");
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(repo);
  await mkdir(bare);
  await git(bare, "init", "--bare");
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "Bridge Test");
  await git(repo, "config", "user.email", "bridge@example.invalid");
  await writeFile(join(repo, "a.txt"), "base");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "base");
  await git(repo, "remote", "add", "origin", bare);
  await git(repo, "push", "origin", "main");
  await git(repo, "checkout", "-b", "bridge/test/a");
  await writeFile(join(repo, "a.txt"), "change");
  await git(repo, "commit", "-am", "change");
  const head = await git(repo, "rev-parse", "HEAD");
  const p = {
    id: "publish",
    cwd: repo,
    state: "reviewed",
    goal: "Publish test",
    delivery: {
      forge: "github",
      host: "github.com",
      repository: "owner/project",
      remote: "origin",
      targetBranch: "main",
    },
    tasks: [
      {
        title: "a",
        worktree: { path: repo, branch: "bridge/test/a" },
        evidence: { head },
        reviews: [{ evidence: ["tests passed"] }],
        issue: { number: 1, url: "https://github.com/owner/project/issues/1" },
      },
    ],
  };
  let creates = 0;
  const forge = new Forge(async (bin, args) => {
    assert.ok(!args.includes("merge"));
    if (args[1] === "list") return "[]";
    assert.ok(args.includes("--draft"));
    const body = await readFile(args[args.indexOf("--body-file") + 1], "utf8");
    assert.match(body, /Closes #1/);
    creates++;
    return "https://github.com/owner/project/pull/2";
  });
  forge.validate = async () => p.delivery;
  await forge.deliver(p, async () => {});
  assert.equal(p.state, "awaiting_merge");
  assert.equal(
    (await git(repo, "ls-remote", "origin", "refs/heads/bridge/test/a")).split(
      /\s/,
    )[0],
    head,
  );
  await forge.deliver(p, async () => {});
  assert.equal(creates, 1);
  assert.notEqual(
    (await git(repo, "ls-remote", "origin", "refs/heads/main")).split(/\s/)[0],
    head,
  );
});
