/**
 * E2E smoke test for the bridge's Codex side. No DSH needed.
 *
 *   node test/smoke.mjs                 # initialize + Thread/list only
 *   node test/smoke.mjs --turn          # also run one read-only turn ("BRIDGE_OK")
 *   node test/smoke.mjs --turn --cwd /path/to/repo
 *
 * Requires: codex on PATH, a writable $CODEX_HOME, and a working sandbox
 * backend. Run it from a normal directory (NOT from a bwrap-nested DSH shell).
 */

import { CodexAppServerClient } from '../src/client.js';

const argv = process.argv.slice(2);
const runTurn = argv.includes('--turn');
const cwdIndex = argv.indexOf('--cwd');
const cwd = cwdIndex >= 0 ? argv[cwdIndex + 1] : process.cwd();

const client = new CodexAppServerClient({
  cwd,
  requestTimeoutMs: 20_000,
  turnTimeoutMs: 120_000,
  onStderr: (line) => {
    const text = line.trim();
    if (text && !text.startsWith('WARNING: proceeding')) process.stderr.write(`[codex] ${text}\n`);
  },
});

let exitCode = 0;
try {
  await client.ensureStarted();
  console.log('OK  initialize handshake');

  const threads = await client.listThreads({ limit: 5 });
  console.log(`OK  Thread/list returned ${threads?.data?.length ?? 0} thread(s)`);
  for (const thread of threads?.data ?? []) {
    console.log(`      ${thread.id}  ${thread.name ?? '(unnamed)'}  ${thread.cwd}`);
  }

  if (runTurn) {
    const result = await client.runTurn({ text: 'Reply with exactly: BRIDGE_OK', cwd });
    const text = result.text.trim();
    console.log(`OK  Turn/start -> status=${result.status} turn=${result.turnId}`);
    console.log(`      reply: ${JSON.stringify(text.slice(0, 200))}`);
    if (!text.includes('BRIDGE_OK')) {
      console.error('FAIL: expected the reply to contain BRIDGE_OK');
      exitCode = 1;
    }
  }
} catch (error) {
  console.error(`FAIL: ${error.name}: ${error.message}`);
  if (error.method) console.error(`      method: ${error.method}`);
  exitCode = 1;
} finally {
  await client.dispose();
}
process.exit(exitCode);
