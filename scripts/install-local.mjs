#!/usr/bin/env node
import {
  readFile,
  writeFile,
  mkdir,
  readdir,
  copyFile,
  rename,
} from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { request } from "../src/transport.js";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const home = process.env.DSH_HOME || join(homedir(), ".dsh");
const patch = process.argv[2] || join(home, "profiles/web/cordis.patch.yml");
const files = (await readdir(join(root, "src")))
  .filter((x) => x.endsWith(".js"))
  .sort();
const contents = await Promise.all(
  files.map((x) => readFile(join(root, "src", x))),
);
const hash = createHash("sha256");
contents.forEach((x) => hash.update(x));
const version = hash.digest("hex").slice(0, 16);
const release = join(root, ".dsh-codex-bridge/releases", version);
await mkdir(join(release, "src"), { recursive: true });
await writeFile(join(release, "package.json"), '{"type":"module"}\n');
await Promise.all(
  files.map((x, i) => writeFile(join(release, "src", x), contents[i])),
);
const begin = "# BEGIN dsh-codex-bridge managed mount";
const end = "# END dsh-codex-bridge managed mount";
let original = await readFile(patch, "utf8");
const first = original.indexOf(begin),
  last = original.indexOf(end);
if (first < 0 !== last < 0 || (first >= 0 && last < first))
  throw new Error(
    "Malformed managed block; preserve configuration and repair manually",
  );
if (first < 0 && original.includes("id: codex-bridge"))
  throw new Error("Existing unmanaged codex-bridge entry; resolve explicitly");
if (
  first >= 0 &&
  original.includes(JSON.stringify(join(release, "src/index.js")))
) {
  console.log(JSON.stringify({ patch, release, version, unchanged: true }));
  process.exit(0);
}
if (first >= 0) {
  const plans = await request("plan.list");
  if (plans.some((p) => p.state === "running" || p.state === "stop_requested"))
    throw new Error(
      "Finish or explicitly stop active bridge plans before updating the plugin",
    );
}
if (first >= 0)
  original =
    original.slice(0, first) +
    original.slice(last + end.length).replace(/^\n/, "");
const block = `${begin}\n- insert:\n    - id: codex-bridge\n      name: ${JSON.stringify(join(release, "src/index.js"))}\n      config: { build: ${JSON.stringify(version)} }\n${end}\n`;
await copyFile(patch, patch + ".bridge-backup-" + Date.now());
if (first >= 0) {
  await writeFile(patch + ".bridge-tmp", original, { mode: 0o600 });
  await rename(patch + ".bridge-tmp", patch);
  let stopped = false;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      await request("hello", {}, { timeoutMs: 1000 });
    } catch (e) {
      if (["ENOENT", "ECONNREFUSED"].includes(e.code)) {
        stopped = true;
        break;
      }
      if (!["ECONNRESET", "EPIPE"].includes(e.code)) throw e;
    }
  }
  if (!stopped)
    throw new Error(
      "Plugin did not unload; preserve DSH service and inspect the saved backup",
    );
}
await writeFile(patch + ".bridge-tmp", original.trimEnd() + "\n\n" + block, {
  mode: 0o600,
});
await rename(patch + ".bridge-tmp", patch);
console.log(
  JSON.stringify({
    patch,
    release,
    version,
    reload: "profile live patch must be enabled; verify with bridge hello",
  }),
);
