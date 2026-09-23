import { dirname, join } from "node:path";
import { listen, defaultSocket } from "./transport.js";
import { DshBackend } from "./dsh-backend.js";
import { Jobs } from "./jobs.js";
import { Plans } from "./plans.js";
import { Forge } from "./forge.js";
import { baselinePreview, baselineConfirm } from "./repository.js";
export const name = "dsh-codex-bridge";
export const inject = [
  "sessionController",
  "workspaceController",
  "agents",
  "sessions",
  "agentDefaultModel",
];
export async function apply(ctx, config = {}) {
  const socketPath = config.socketPath || defaultSocket();
  const backend = new DshBackend(ctx);
  const jobs = new Jobs(
    backend,
    config.dataDir || join(dirname(socketPath), "jobs"),
  );
  const plans = new Plans(jobs, join(dirname(socketPath), "plans"), {
    maxParallel: config.maxParallel ?? 2,
    forge: new Forge(),
  });
  const close = await listen(socketPath, async (method, params) => {
    if (method === "hello")
      return {
        name,
        version: "0.2.0",
        build: config.build,
        transport: "unix",
        model: await backend.model(),
        capabilities: [
          "baseline.preview",
          "baseline.confirm",
          "plan.preview",
          "plan.approve",
          "plan.status",
          "plan.wait",
          "plan.review",
          "plan.steer",
          "plan.stop",
          "plan.list",
          "plan.deliver",
        ],
      };
    if (method === "baseline.preview") return baselinePreview(params);
    if (method === "baseline.confirm") return baselineConfirm(params);
    if (
      method.startsWith("plan.") &&
      [
        "preview",
        "approve",
        "status",
        "wait",
        "review",
        "steer",
        "stop",
        "list",
        "deliver",
      ].includes(method.slice(5))
    )
      return plans[method.slice(5)](params);
    throw new Error(
      "Unknown bridge method; task execution requires an approved plan",
    );
  });
  let stopScheduler = () => {};
  ctx.effect(() => async () => {
    stopScheduler();
    jobs.stopping = true;
    await close();
  });
  await plans.recover();
  stopScheduler = plans.start();
}
