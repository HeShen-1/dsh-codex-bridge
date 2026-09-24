import { readFile, writeFile, mkdir, realpath, lstat } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { git, digest, fail } from "./jobs.js";
const sensitive = (p) => /(^|\/)(\.env(\..*)?|id_(rsa|ed25519)|credentials[^/]*|\.credentials[^/]*|auth\.json)$|\.(pem|key|p12|pfx)$/i.test(
  p
) && !/(^|\/)\.env\.example$/.test(p);
function validPath(p) {
  return typeof p === "string" && p.length && !isAbsolute(p) && !p.split("/").includes("..") && !p.includes("\\") && !/[\x00-\x1f]/.test(p) && !p.startsWith("-") && !/^\.(git|handoff|worktrees)(\/|$)/.test(p);
}
async function repository(cwd) {
  cwd = await realpath(cwd);
  let root;
  try {
    root = await git(cwd, "rev-parse", "--show-toplevel");
  } catch {
    await git(cwd, "init", "-b", "main");
    root = cwd;
  }
  if (await realpath(root) !== cwd)
    fail(
      "REPO_ROOT_REQUIRED",
      `Choose the repository root explicitly: ${root}`
    );
  let base = null;
  try {
    base = await git(cwd, "rev-parse", "--verify", "HEAD");
  } catch {
  }
  return { cwd, base };
}
async function changed(cwd) {
  const tracked = await git(
    cwd,
    "diff",
    "--name-only",
    "--no-renames",
    "-z",
    "HEAD"
  );
  const untracked = await git(
    cwd,
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z"
  );
  return [
    ...new Set(
      [...tracked.split("\0"), ...untracked.split("\0")].filter(Boolean)
    )
  ].sort();
}
async function manifest(cwd, files) {
  const rows = [];
  for (const file of files) {
    if (!validPath(file) || sensitive(file))
      fail("SENSITIVE_PATH", `File requires explicit manual handling: ${file}`);
    const absolute = join(cwd, file);
    const stat = await lstat(absolute).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
    if (!stat) {
      rows.push({ file, deleted: true });
      continue;
    }
    if (!stat.isFile())
      fail(
        "UNSUPPORTED_FILE",
        `Only regular files can be staged automatically: ${file}`
      );
    const resolved = await realpath(absolute);
    if (!resolved.startsWith(await realpath(cwd) + "/"))
      fail("OUTSIDE_WORKTREE", `File resolves outside the worktree: ${file}`);
    const content = await readFile(absolute);
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{30,}|\bsk-(?:proj-|live-)?[A-Za-z0-9_-]{32,}/.test(
      content.toString("utf8")
    ))
      fail(
        "SECRET_DETECTED",
        `Potential credential in ${file}; review manually`
      );
    rows.push({
      file,
      hash: digest(content.toString("base64")),
      mode: stat.mode & 511
    });
  }
  return rows;
}
async function baselinePreview({ cwd }) {
  const repo = await repository(cwd);
  if (repo.base) return { ...repo, required: false };
  const files = (await git(
    repo.cwd,
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z"
  )).split("\0").filter(Boolean);
  const excluded = files.filter(sensitive);
  const included = files.filter((p) => !sensitive(p));
  const items = await manifest(repo.cwd, included);
  return {
    ...repo,
    required: true,
    files: included,
    excluded,
    confirmation: digest(items)
  };
}
async function baselineConfirm({ cwd, files, confirmation }) {
  const repo = await repository(cwd);
  if (repo.base) fail("ALREADY_COMMITTED", "Repository already has a baseline");
  if (!Array.isArray(files))
    fail("INVALID_FILES", "Confirm an explicit file list");
  if (digest(await manifest(repo.cwd, files)) !== confirmation)
    fail("BASELINE_CHANGED", "File list or content changed; preview again");
  const staged = (await git(repo.cwd, "diff", "--cached", "--name-only", "-z")).split("\0").filter(Boolean);
  if (staged.some((p) => !files.includes(p)))
    fail("STAGED_CONFLICT", "Index contains files outside the confirmed list");
  if (files.length) await git(repo.cwd, "add", "--", ...files);
  await git(repo.cwd, "diff", "--cached", "--check");
  await git(
    repo.cwd,
    "commit",
    "--allow-empty",
    "-m",
    "chore: establish approved project baseline"
  );
  return repository(repo.cwd);
}
async function makeWorktree(plan, task, dependencyHeads = []) {
  const common = await git(
    plan.cwd,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir"
  );
  const exclude = join(common, "info/exclude");
  await mkdir(join(common, "info"), { recursive: true });
  let text = await readFile(exclude, "utf8").catch((e) => {
    if (e.code !== "ENOENT") throw e;
    return "";
  });
  for (const line of [".worktrees/", ".handoff/"])
    if (!text.split("\n").includes(line)) text += "\n" + line + "\n";
  await writeFile(exclude, text);
  const path = join(plan.cwd, ".worktrees", `bridge-${plan.id}-${task.id}`);
  const branch = `bridge/${plan.id}/${task.id}`;
  await git(plan.cwd, "worktree", "add", "-b", branch, path, plan.base);
  for (const head of dependencyHeads)
    await git(path, "merge", "--no-edit", "--no-ff", head);
  const handoff = join(path, ".handoff");
  await mkdir(handoff, { recursive: true });
  await writeFile(
    join(handoff, "HANDOFF.md"),
    `updated: ${(/* @__PURE__ */ new Date()).toISOString()}
status: active
from-agent: codex

1. \u5F53\u524D\u76EE\u6807: ${task.title}
2. \u4E0B\u4E00\u6B65\u52A8\u4F5C: \u5728\u6388\u6743\u6587\u4EF6\u8303\u56F4\u5185\u5B8C\u6210\u4EFB\u52A1\u5E76\u9A8C\u8BC1\uFF1B\u5B8C\u6210\u540E\u63D0\u4EA4\u8BC1\u636E\u7ED9 Codex \u590D\u6838\u3002
3. \u5DF2\u5B8C\u6210+\u9A8C\u8BC1\u72B6\u6001: Git \u57FA\u7EBF\u4E0E\u4F9D\u8D56\u5DF2\u51C6\u5907\uFF1B\u4EFB\u52A1\u5C1A\u672A\u5B9E\u65BD\u3002
4. \u5173\u952E\u51B3\u7B56: \u8BA1\u5212 ${plan.id} / \u5B50\u4EFB\u52A1 ${task.id}\uFF1B\u6A21\u578B\u7531\u4EBA\u5DE5\u8BBE\u7F6E\uFF1B\u4E0D\u5F97\u53D1\u5E03\u6216\u5408\u5E76\u3002
5. \u5DF2\u8BD5\u8FC7\u4E14\u5931\u8D25: \u65E0\u3002
6. \u6587\u4EF6\u5730\u56FE: ${task.files.join(", ")}
7. \u672A\u51B3\u95EE\u9898: \u8D85\u51FA\u76EE\u6807\u6216\u8BBF\u95EE\u8303\u56F4\u65F6\u505C\u6B62\u5E76\u62A5\u544A\u3002
8. \u9700\u8DD1\u7684\u547D\u4EE4: \u89C1\u4EFB\u52A1\u9A8C\u6536\u8981\u6C42\u3002
9. \u73AF\u5883\u72B6\u6001: \u72EC\u7ACB worktree\uFF1B\u5206\u652F ${branch}\u3002
`,
    { mode: 384 }
  );
  return { path, branch, base: await git(path, "rev-parse", "HEAD") };
}
async function checkpoint(plan, task) {
  const cwd = task.worktree.path;
  const expected = task.evidence?.head || task.worktree.base;
  if (await git(cwd, "rev-parse", "HEAD") !== expected)
    fail(
      "UNEXPECTED_COMMIT",
      "Execution changed Git history; inspect commits before accepting or publishing"
    );
  const files = await changed(cwd);
  for (const p of files)
    if (!task.files.some(
      (scope) => p === scope || scope.endsWith("/") && p.startsWith(scope)
    ))
      fail(
        "SCOPE_VIOLATION",
        `Task changed a file outside its approved scope: ${p}`
      );
  await manifest(cwd, files);
  if (files.length) {
    await git(cwd, "add", "--", ...files);
    await git(cwd, "diff", "--cached", "--check");
    await git(
      cwd,
      "commit",
      "-m",
      `feat: ${task.title.replace(/[\r\n]/g, " ").slice(0, 100)}`
    );
  }
  const head = await git(cwd, "rev-parse", "HEAD");
  const paths = (await git(
    cwd,
    "diff",
    "--name-only",
    "--no-renames",
    "-z",
    task.worktree.base,
    head
  )).split("\0").filter(Boolean);
  for (const p of paths)
    if (!task.files.some(
      (scope) => p === scope || scope.endsWith("/") && p.startsWith(scope)
    ))
      fail("SCOPE_VIOLATION", `Committed change outside approved scope: ${p}`);
  await manifest(cwd, paths);
  return {
    head,
    files: paths,
    diffStat: await git(cwd, "diff", "--stat", task.worktree.base, head),
    dirty: await git(cwd, "status", "--porcelain")
  };
}
export {
  baselineConfirm,
  baselinePreview,
  changed,
  checkpoint,
  makeWorktree,
  repository,
  sensitive,
  validPath
};
