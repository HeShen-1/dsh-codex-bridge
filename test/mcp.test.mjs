import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listen } from "../src/transport.js";
test("MCP initialize, tools/list and tools/call reach the bridge service", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-mcp-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const socketPath = join(dir, "bridge.sock");
  const close = await listen(socketPath, async (method) => ({
    method,
    realTransport: true,
  }));
  t.after(close);
  const child = spawn(process.execPath, ["bin/mcp.mjs"], {
    env: { ...process.env, DSH_CODEX_BRIDGE_SOCKET: socketPath },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  const pending = new Map();
  createInterface({ input: child.stdout }).on("line", (l) => {
    const m = JSON.parse(l);
    pending.get(m.id)?.(m);
  });
  let id = 0;
  async function call(method, params) {
    const key = ++id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("MCP timeout")), 3000);
      pending.set(key, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id: key, method, params }) + "\n",
      );
    });
  }
  assert.equal(
    (await call("initialize", { protocolVersion: "2025-06-18" })).result
      .protocolVersion,
    "2025-06-18",
  );
  const names = (await call("tools/list")).result.tools.map((x) => x.name);
  assert.ok(names.includes("dsh_plan_approve"));
  assert.ok(!names.includes("dsh_submit"));
  const reply = await call("tools/call", {
    name: "dsh_bridge_status",
    arguments: {},
  });
  assert.equal(JSON.parse(reply.result.content[0].text).realTransport, true);
  const invalid = await call("tools/call", {
    name: "dsh_plan_approve",
    arguments: { id: "x" },
  });
  assert.equal(invalid.error.code, -32602);
  child.stdin.end();
});
