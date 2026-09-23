/**
 * Load test: verifies the plugin modules import cleanly and that `apply()`
 * registers exactly the four expected tools, without needing a live Codex.
 *
 *   node test/load.mjs
 *
 * Historical note (2026-09, first run): bare `@deepseek-ai/dsh-tools` and
 * `@deepseek-ai/schemastery` imports only resolve after the plugin is linked
 * into the DSH profile; see cordis.patch.yml for the symlink commands.
 */

import { createBridgeTools } from '../src/tools.js';

const fakeClient = {
  child: null,
  initialized: false,
  options: { mode: 'private' },
  turns: new Map(),
  threadByCwd: new Map(),
};

const tools = createBridgeTools({
  client: fakeClient,
  planTimeoutMs: 1000,
  askTimeoutMs: 1000,
  audit: () => {},
});

const expected = ['codex_plan', 'codex_ask', 'codex_steer', 'codex_status'];
const names = tools.map((tool) => tool.name);
const problems = [];

for (const name of expected) {
  if (!names.includes(name)) problems.push(`missing tool: ${name}`);
}
if (names.length !== expected.length) {
  problems.push(`expected ${expected.length} tools, got ${names.length}: ${names.join(', ')}`);
}
for (const tool of tools) {
  if (!tool.definition?.description) problems.push(`${tool.name}: no description`);
  if (typeof tool.execute !== 'function') problems.push(`${tool.name}: no execute()`);
  if (!tool.definition?.parameters) problems.push(`${tool.name}: no parameter schema`);
}

if (problems.length > 0) {
  console.error('FAIL');
  for (const problem of problems) console.error('  - ' + problem);
  process.exit(1);
}

console.log(`OK: registered ${names.join(', ')}`);
for (const tool of tools) {
  const params = Object.keys(tool.definition?.parameters ?? {});
  console.log(`  ${tool.name}(${params.join(', ')})`);
}
