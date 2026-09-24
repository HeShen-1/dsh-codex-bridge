#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { request } from "../src/transport.js";
const method = process.argv[2] || "hello";
try {
  let input = "";
  if (process.argv[3]) input = await readFile(process.argv[3], "utf8");
  else if (!process.stdin.isTTY)
    for await (const chunk of process.stdin) input += chunk;
  console.log(
    JSON.stringify(
      await request(method, JSON.parse(input.trim() || "{}")),
      null,
      2
    )
  );
} catch (error) {
  console.error(JSON.stringify({ error: error.message, code: error.code }));
  process.exitCode = 1;
}
