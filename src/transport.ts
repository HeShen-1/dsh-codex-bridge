import http from "node:http";
import { chmod, mkdir, lstat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
export const defaultSocket = () =>
  process.env.DSH_CODEX_BRIDGE_SOCKET ||
  join(
    process.env.DSH_HOME || join(homedir(), ".dsh"),
    "codex-bridge",
    "bridge.sock",
  );
export async function request(
  method,
  params = {},
  { socketPath = defaultSocket(), timeoutMs = 30000 } = {},
) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ method, params });
    const req = http.request(
      {
        agent: false,
        socketPath,
        path: "/rpc",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
          if (data.length > 8_000_000)
            req.destroy(new Error("Response too large"));
        });
        res.on("end", () => {
          try {
            const result = JSON.parse(data);
            if (result.error)
              reject(
                Object.assign(new Error(result.error.message), {
                  code: result.error.code,
                }),
              );
            else resolve(result.result);
          } catch (error) {
            reject(error);
          }
        });
        res.on("error", reject);
      },
    );
    req.setTimeout(timeoutMs, () =>
      req.destroy(
        new Error("Bridge request timed out; query status before retrying."),
      ),
    );
    req.on("error", reject);
    req.end(body);
  });
}
export async function listen(socketPath, invoke) {
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  const existing = await lstat(socketPath).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (existing) {
    if (!existing.isSocket())
      throw new Error("Refusing to replace a non-socket path");
    try {
      await request("hello", {}, { socketPath, timeoutMs: 1000 });
      throw Object.assign(new Error("Bridge already running"), {
        code: "ACTIVE",
      });
    } catch (error) {
      if (!["ECONNREFUSED", "ENOENT"].includes(error.code)) throw error;
    }
    await unlink(socketPath);
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    try {
      if (req.method !== "POST" || req.url !== "/rpc" || req.headers.origin)
        throw new Error("Only local bridge RPC is accepted");
      let bytes = 0;
      const chunks = [];
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 1_000_000) throw new Error("Request too large");
        chunks.push(chunk);
      }
      const { method, params } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.end(JSON.stringify({ result: await invoke(method, params || {}) }));
    } catch (error) {
      res.statusCode = 400;
      res.end(
        JSON.stringify({
          error: { code: error.code || "BRIDGE_ERROR", message: error.message },
        }),
      );
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve(undefined));
  });
  await chmod(socketPath, 0o600);
  return async () => {
    server.closeIdleConnections();
    await new Promise((resolve) => server.close(resolve));
    await unlink(socketPath).catch(() => {});
  };
}
