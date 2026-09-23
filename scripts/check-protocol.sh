#!/usr/bin/env bash
# Protocol compatibility check: regenerate the codex app-server schema and assert
# that every method and notification this bridge depends on still exists.
#
# Run this after any Codex upgrade. Exit 0 = safe, exit 1 = protocol drift.
#
# Usage: bash scripts/check-protocol.sh [schema-dir]
set -euo pipefail

OUT="${1:-$(mktemp -d)}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "[check-protocol] generating schema -> $OUT"
codex app-server generate-json-schema --out "$OUT" >/dev/null

node --input-type=module -e '
import fs from "node:fs";
import path from "node:path";

const out = process.argv[1];
const here = process.argv[2];
const protocol = await import(path.join(here, "..", "src", "protocol.js"));

const bundle = JSON.parse(
  fs.readFileSync(path.join(out, "codex_app_server_protocol.v2.schemas.json"), "utf8"),
);
const clientRequest = JSON.parse(fs.readFileSync(path.join(out, "ClientRequest.json"), "utf8"));
const oneOf = new Set((clientRequest.oneOf ?? []).map((entry) => String(entry.$ref ?? "")));

// v2 definitions are named "<Namespace><Verb><Params|Response|Notification>".
// Map our method strings ("Thread/start") onto those definition names.
const defName = (method, suffix) => {
  const [namespace, verb] = method.split("/");
  return `${namespace}${verb[0].toUpperCase()}${verb.slice(1)}${suffix}`;
};

const missing = [];
for (const method of Object.values(protocol.METHODS)) {
  // `initialize` has no namespace/verb split; it lives in v1.
  if (!method.includes("/")) {
    const found =
      oneOf.has("#/definitions/InitializeParams") ||
      oneOf.has("#/definitions/InitializeRequest") ||
      fs.existsSync(path.join(out, "v1", "InitializeParams.json"));
    if (!found) missing.push(`${method} (expected v1 InitializeParams)`);
    continue;
  }
  const candidate = defName(method, "Params");
  const present =
    Object.hasOwn(bundle.definitions, candidate) ||
    oneOf.has(`#/definitions/${candidate}Request`) ||
    oneOf.has(`#/definitions/${candidate}`);
  if (!present) missing.push(`${method} (expected definition ${candidate})`);
}

const v2 = new Set(Object.keys(bundle.definitions));
const notificationVariants = new Set((bundle.oneOf ?? []).map((entry) => String(entry.$ref ?? "")));
for (const method of Object.values(protocol.NOTIFICATIONS)) {
  // Codex names notification definitions without the "Item" namespace:
  // "Item/agentMessage/delta" -> AgentMessageDeltaNotification,
  // "Turn/plan/updated" -> TurnPlanUpdatedNotification.
  const segments = method.split("/");
  const stems = [
    segments.map((part) => part[0].toUpperCase() + part.slice(1)).join(""),
    segments.slice(1).map((part) => part[0].toUpperCase() + part.slice(1)).join(""),
  ].filter(Boolean);
  const present = stems.some(
    (stem) =>
      v2.has(`${stem}Notification`) ||
      notificationVariants.has(`#/definitions/${stem}Notification`) ||
      v2.has(stem),
  );
  if (!present) missing.push(`${method} (expected definition ${stems[0]}Notification)`);
}

if (missing.length > 0) {
  console.error("[check-protocol] PROTOCOL DRIFT:");
  for (const line of missing) console.error("  - " + line);
  process.exit(1);
}

console.log(
  "[check-protocol] OK:",
  Object.keys(protocol.METHODS).length,
  "methods and",
  Object.keys(protocol.NOTIFICATIONS).length,
  "notifications still present in codex app-server schema",
);
' "$OUT" "$HERE"
