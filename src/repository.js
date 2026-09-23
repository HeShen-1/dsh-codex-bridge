import { readFile, writeFile, mkdir, realpath, lstat } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { git, digest, fail } from "./jobs.js";
export const sensitive = (p) =>
  /(^|\/)(\.env(\..*)?|id_(rsa|ed25519)|credentials[^/]*|\.credentials[^/]*|auth\.json)$|\.(pem|key|p12|pfx)$/i.test(
    p,
  ) && !/(^|\/)\.env\.example$/.test(p);
export function validPath(p) {
  return (
    typeof p === "string" &&
    p.length &&
    !isAbsolute(p) &&
    !p.split("/").includes("..") &&
    !p.includes("\\") &&
    !/[\x00-\x1f]/.test(p) &&
    !p.startsWith("-") &&
    !/^\.(git|handoff|worktrees)(\/|$)/.test(p)
  );
}
export async function repository(cwd) {
  cwd = await realpath(cwd);
  let root;
  try {
    root = await git(cwd, "rev-parse", "--show-toplevel");
  } catch {
    await git(cwd, "init", "-b", "main");
    root = cwd;
  }
  if ((await realpath(root)) !== cwd)
    fail(
      "REPO_ROOT_REQUIRED",
      `Choose the repository root explicitly: ${root}`,
    );
  let base = null;
  try {
    base = await git(cwd, "rev-parse", "--verify", "HEAD");
  } catch {}
  return { cwd, base };
}
export async function changed(cwd) {
  const tracked = await git(
    cwd,
    "diff",
    "--name-only",
    "--no-renames",
    "-z",
    "HEAD",
  );
  const untracked = await git(
    cwd,
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  );
  return [
    ...new Set(
      [...tracked.split("\0"), ...untracked.split("\0")].filter(Boolean),
    ),
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
        `Only regular files can be staged automatically: ${file}`,
      );
    const resolved = await realpath(absolute);
    if (!resolved.startsWith((await realpath(cwd)) + "/"))
      fail("OUTSIDE_WORKTREE", `File resolves outside the worktree: ${file}`);
    const content = await readFile(absolute);
    if (
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{30,}|\bsk-(?:proj-|live-)?[A-Za-z0-9_-]{32,}/.test(
        content.toString("utf8"),
      )
    )
      fail(
        "SECRET_DETECTED",
        `Potential credential in ${file}; review manually`,
      );
    rows.push({
      file,
      hash: digest(content.toString("base64")),
      mode: stat.mode & 0o777,
    });
  }
  return rows;
}
export async function baselinePreview({ cwd }) {
  const repo = await repository(cwd);
  if (repo.base) return { ...repo, required: false };
  const files = (
    await git(
      repo.cwd,
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    )
  )
    .split("\0")
    .filter(Boolean);
  const excluded = files.filter(sensitive);
  const included = files.filter((p) => !sensitive(p));
  const items = await manifest(repo.cwd, included);
  return {
    ...repo,
    required: true,
    files: included,
    excluded,
    confirmation: digest(items),
  };
}
export async function baselineConfirm({ cwd, files, confirmation }) {
  const repo = await repository(cwd);
  if (repo.base) fail("ALREADY_COMMITTED", "Repository already has a baseline");
  if (!Array.isArray(files))
    fail("INVALID_FILES", "Confirm an explicit file list");
  if (digest(await manifest(repo.cwd, files)) !== confirmation)
    fail("BASELINE_CHANGED", "File list or content changed; preview again");
  const staged = (await git(repo.cwd, "diff", "--cached", "--name-only", "-z"))
    .split("\0")
    .filter(Boolean);
  if (staged.some((p) => !files.includes(p)))
    fail("STAGED_CONFLICT", "Index contains files outside the confirmed list");
  if (files.length) await git(repo.cwd, "add", "--", ...files);
  await git(repo.cwd, "diff", "--cached", "--check");
  await git(
    repo.cwd,
    "commit",
    "--allow-empty",
    "-m",
    "chore: establish approved project baseline",
  );
  return repository(repo.cwd);
}
export async function makeWorktree(plan, task, dependencyHeads = []) {
  const common = await git(
    plan.cwd,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
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
  // A task's preparation identity is saved by the orchestrator before this call.
  // Never adopt an unrelated branch/directory merely because its name matches.
  await git(plan.cwd, "worktree", "add", "-b", branch, path, plan.base);
  for (const head of dependencyHeads)
    await git(path, "merge", "--no-edit", "--no-ff", head);
  const handoff = join(path, ".handoff");
  await mkdir(handoff, { recursive: true });
  await writeFile(
    join(handoff, "HANDOFF.md"),
    `updated: ${new Date().toISOString()}\nstatus: active\nfrom-agent: codex\n\n1. 当前目标: ${task.title}\n2. 下一步动作: 在授权文件范围内完成任务并验证；完成后提交证据给 Codex 复核。\n3. 已完成+验证状态: Git 基线与依赖已准备；任务尚未实施。\n4. 关键决策: 计划 ${plan.id} / 子任务 ${task.id}；模型由人工设置；不得发布或合并。\n5. 已试过且失败: 无。\n6. 文件地图: ${task.files.join(", ")}\n7. 未决问题: 超出目标或访问范围时停止并报告。\n8. 需跑的命令: 见任务验收要求。\n9. 环境状态: 独立 worktree；分支 ${branch}。\n`,
    { mode: 0o600 },
  );
  return { path, branch, base: await git(path, "rev-parse", "HEAD") };
}
export async function checkpoint(plan, task) {
  const cwd = task.worktree.path;
  const expected = task.evidence?.head || task.worktree.base;
  if ((await git(cwd, "rev-parse", "HEAD")) !== expected)
    fail(
      "UNEXPECTED_COMMIT",
      "Execution changed Git history; inspect commits before accepting or publishing",
    );
  const files = await changed(cwd);
  for (const p of files)
    if (
      !task.files.some(
        (scope) => p === scope || (scope.endsWith("/") && p.startsWith(scope)),
      )
    )
      fail(
        "SCOPE_VIOLATION",
        `Task changed a file outside its approved scope: ${p}`,
      );
  await manifest(cwd, files);
  if (files.length) {
    await git(cwd, "add", "--", ...files);
    await git(cwd, "diff", "--cached", "--check");
    await git(
      cwd,
      "commit",
      "-m",
      `feat: ${task.title.replace(/[\r\n]/g, " ").slice(0, 100)}`,
    );
  }
  const head = await git(cwd, "rev-parse", "HEAD");
  const paths = (
    await git(
      cwd,
      "diff",
      "--name-only",
      "--no-renames",
      "-z",
      task.worktree.base,
      head,
    )
  )
    .split("\0")
    .filter(Boolean);
  for (const p of paths)
    if (
      !task.files.some(
        (scope) => p === scope || (scope.endsWith("/") && p.startsWith(scope)),
      )
    )
      fail("SCOPE_VIOLATION", `Committed change outside approved scope: ${p}`);
  await manifest(cwd, paths);
  return {
    head,
    files: paths,
    diffStat: await git(cwd, "diff", "--stat", task.worktree.base, head),
    dirty: await git(cwd, "status", "--porcelain"),
  };
}
