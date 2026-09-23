/**
 * Static verification for the plugin skeleton. No Codex, no DSH required.
 *
 *   node test/verify.mjs
 *
 * Checks:
 *  1. every source file parses as an ES module;
 *  2. package.json points at the real patch file, and the patch mounts this plugin;
 *  3. protocol.js exports non-empty method/notification names in the expected shapes;
 *  4. every RPC method named in ./src/protocol.js appears in the frozen schema copy
 *     (regenerate with: codex app-server generate-json-schema --out <DIR>).
 *
 * Usage with schema cross-check:
 *   node test/verify.mjs --schema /path/to/generated/schema
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const notes = [];

function check(condition, message) {
  if (condition) notes.push(`ok   ${message}`);
  else problems.push(message);
}

// 1. ES module syntax
const sources = ['src/protocol.js', 'src/client.js', 'src/tools.js', 'src/index.js', 'test/load.mjs', 'test/smoke.mjs'];
for (const relative of sources) {
  const file = path.join(root, relative);
  if (!fs.existsSync(file)) {
    problems.push(`missing file: ${relative}`);
    continue;
  }
  const code = fs.readFileSync(file, 'utf8');
  try {
    // Parses the source as a module without executing it.
    new vm.SourceTextModule(code, { identifier: file });
    notes.push(`ok   parses as ESM: ${relative}`);
  } catch (error) {
    problems.push(`ESM parse error in ${relative}: ${error.message}`);
  }
}

// 2. manifest + patch wiring
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
check(pkg.dsh?.bundle?.patch === './cordis.patch.yml', 'package.json dsh.bundle.patch -> ./cordis.patch.yml');
const patchPath = path.join(root, pkg.dsh?.bundle?.patch ?? 'cordis.patch.yml');
check(fs.existsSync(patchPath), 'cordis.patch.yml exists');
const patchText = fs.readFileSync(patchPath, 'utf8');
check(/id:\s*codex-bridge/.test(patchText), 'patch inserts id: codex-bridge');
check(/name:\s*'dsh-codex-bridge'/.test(patchText), 'patch mounts name: dsh-codex-bridge');

// 3. protocol constants
const protocol = await import(path.join(root, 'src', 'protocol.js'));
check(protocol.METHODS && Object.keys(protocol.METHODS).length >= 9, 'protocol.METHODS has the expected methods');
check(
  protocol.NOTIFICATIONS && Object.keys(protocol.NOTIFICATIONS).length >= 4,
  'protocol.NOTIFICATIONS has the expected notifications',
);
for (const [key, value] of Object.entries(protocol.METHODS ?? {})) {
  check(typeof value === 'string' && value.length > 0, `METHODS.${key} is a non-empty string`);
}
check(protocol.CLIENT_INFO?.name === 'dsh-codex-bridge', 'CLIENT_INFO.name is set');
check(
  protocol.DEFAULT_TURN_POLICY?.sandbox === 'read-only',
  'DEFAULT_TURN_POLICY keeps Codex read-only',
);

// 4. optional schema cross-check
const schemaIndex = process.argv.indexOf('--schema');
if (schemaIndex >= 0) {
  const schemaDir = process.argv[schemaIndex + 1];
  const clientRequestPath = path.join(schemaDir, 'ClientRequest.json');
  const bundlePath = path.join(schemaDir, 'codex_app_server_protocol.v2.schemas.json');
  if (!fs.existsSync(clientRequestPath) || !fs.existsSync(bundlePath)) {
    problems.push(`schema dir ${schemaDir} is missing ClientRequest.json / v2 bundle`);
  } else {
    const clientRequest = JSON.parse(fs.readFileSync(clientRequestPath, 'utf8'));
    const oneOf = new Set((clientRequest.oneOf ?? []).map((entry) => String(entry.$ref ?? '')));
    const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
    const definitions = new Set(Object.keys(bundle.definitions ?? {}));
    const variants = new Set((bundle.oneOf ?? []).map((entry) => String(entry.$ref ?? '')));

    const titleCase = (text) => text[0].toUpperCase() + text.slice(1);
    for (const method of Object.values(protocol.METHODS)) {
      // `initialize` has no namespace/verb split; it lives in v1.
      if (!method.includes('/')) {
        check(
          definitions.has('InitializeParams') || fs.existsSync(path.join(schemaDir, 'v1', 'InitializeParams.json')),
          `schema still defines ${method}`,
        );
        continue;
      }
      const [namespace, verb] = method.split('/');
      const stem = `${namespace}${titleCase(verb)}`;
      const found =
        oneOf.has(`#/definitions/${stem}Request`) ||
        oneOf.has(`#/definitions/${stem}Params`) ||
        definitions.has(`${stem}Params`) ||
        definitions.has(`${stem}Request`);
      check(found, `schema still defines ${method}`);
    }
    for (const method of Object.values(protocol.NOTIFICATIONS)) {
      // Codex names notification definitions without the "Item" namespace:
      // "Item/agentMessage/delta" -> AgentMessageDeltaNotification, while
      // "Turn/plan/updated" -> TurnPlanUpdatedNotification.
      const segments = method.split('/');
      const stems = [
        segments.map((part) => part[0].toUpperCase() + part.slice(1)).join(''),
        segments.slice(1).map((part) => part[0].toUpperCase() + part.slice(1)).join(''),
      ].filter(Boolean);
      const found = stems.some(
        (stem) =>
          definitions.has(`${stem}Notification`) ||
          variants.has(`#/definitions/${stem}Notification`) ||
          definitions.has(stem) ||
          variants.has(`#/definitions/${stem}`),
      );
      check(found, `schema still defines ${method}`);
    }
  }
} else {
  notes.push('skip schema cross-check (pass --schema <dir> to enable)');
}

if (problems.length > 0) {
  console.error(`FAIL (${problems.length})`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
for (const note of notes) console.log(note);
console.log(`OK: ${notes.length} checks passed`);
