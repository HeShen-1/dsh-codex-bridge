#!/usr/bin/env node
import { build } from "esbuild";
import { readdir, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const out = join(root, "lib");
const source = (await readdir(join(root, "src")))
  .filter((name) => name.endsWith(".ts") && name !== "client.ts")
  .map((name) => join(root, "src", name));
const tests = (await readdir(join(root, "test")))
  .filter((name) => name.endsWith(".ts"))
  .map((name) => join(root, "test", name));
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await build({
  entryPoints: [...source, ...tests],
  outbase: root,
  outdir: out,
  bundle: false,
  format: "esm",
  platform: "node",
  target: "node22",
});
const browser = await build({
  entryPoints: [join(root, "src/client.tsx")],
  write: false,
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  external: ["react", "react/jsx-runtime", "@deepseek-ai/*"],
});
const body = browser.outputFiles?.[0]?.text;
if (!body) throw new Error("Client build produced no output");
await writeFile(
  join(out, "client.js"),
  `window.__ModuleLoader__.load({id:${JSON.stringify(pkg.name)},factory:(require)=>{var module={exports:{}};var exports=module.exports;${body}\nreturn module.exports;}});\n`,
);
console.log(`Built ${pkg.name}@${pkg.version}`);
