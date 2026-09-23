/**
 * Cordis plugin entry for the DSH ⇄ Codex bridge.
 *
 * Mounted from cordis.patch.yml as a profile-layer insert. Registers four tools
 * on `ctx.tools`; the Codex app-server child is spawned lazily on the first call.
 *
 * Must run inside the DSH host process: the app-server needs a writable
 * $CODEX_HOME, which the DSH bash sandbox does not provide.
 */

import z from '@deepseek-ai/schemastery';
import { CodexAppServerClient } from './client.js';
import { createBridgeTools } from './tools.js';

export const name = 'dsh-codex-bridge';
export const inject = ['tools'];

const DEFAULT_TURN_TIMEOUT_MS = 180_000;

/** Every field has a default, so an empty or partial config is valid. */
export const Config = z.object({
  codexBin: z.string().default('codex'),
  codexHome: z.string().default(''),
  /** `private` spawns a private app-server; `daemon` proxies the desktop daemon. */
  mode: z.string().default('private'),
  /** Socket used when mode is `daemon`; empty means $CODEX_HOME default. */
  daemonSock: z.string().default(''),
  planTimeoutMs: z.number().default(300_000),
  askTimeoutMs: z.number().default(DEFAULT_TURN_TIMEOUT_MS),
});

export function apply(ctx, rawConfig) {
  const config = rawConfig === undefined ? Config({}) : Config(rawConfig);

  const client = new CodexAppServerClient({
    codexBin: config.codexBin || 'codex',
    codexHome: config.codexHome || undefined,
    mode: config.mode === 'daemon' ? 'daemon' : 'private',
    daemonSock: config.daemonSock || undefined,
    turnTimeoutMs: positiveOr(config.askTimeoutMs, DEFAULT_TURN_TIMEOUT_MS),
    cwd: process.cwd(),
  });

  const log = (level, message) => ctx.logger?.[level]?.(`[codex-bridge] ${message}`);
  client.on('protocol-error', (error) => log('warn', error.message));
  client.on('approval-refused', (message) => log('info', `refused approval request ${message.method}`));
  client.on('exit', ({ code, signal }) => log('info', `codex app-server exited code=${code} signal=${signal}`));

  const tools = createBridgeTools({
    client,
    planTimeoutMs: positiveOr(config.planTimeoutMs, 300_000),
    askTimeoutMs: positiveOr(config.askTimeoutMs, DEFAULT_TURN_TIMEOUT_MS),
    audit: (entry) => log('debug', JSON.stringify(entry)),
  });
  for (const tool of tools) ctx.tools.register(tool);

  ctx.effect(() => () => {
    void client.dispose();
  });
}

function positiveOr(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
