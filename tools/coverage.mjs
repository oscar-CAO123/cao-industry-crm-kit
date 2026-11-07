#!/usr/bin/env node
// Reads a client's tool list and reports what the kit covers. Usage: node tools/coverage.mjs stack.json
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name === "connector.json" && !p.includes("_template")) out.push(JSON.parse(fs.readFileSync(p, "utf8")));
  }
  return out;
}
export function loadConnectors() { return [...walk(path.join(root, "core/connectors")), ...walk(path.join(root, "industries"))]; }
const key = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
export function coverage(tools, connectors = loadConnectors()) {
  const byName = new Map(connectors.flatMap((c) => [[key(c.name), c], [key(c.id), c]]));
  const report = { supported: [], notTested: [], missing: [] };
  for (const t of tools) {
    const c = byName.get(key(t));
    if (!c) report.missing.push(t);
    else if (["live-tested", "sandbox-tested"].includes(c.status)) report.supported.push({ tool: t, status: c.status });
    else report.notTested.push({ tool: t, status: c.status, account: c.account_to_test });
  }
  return report;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) { console.error("Usage: node tools/coverage.mjs stack.json"); process.exit(2); }
  const stack = JSON.parse(fs.readFileSync(file, "utf8"));
  console.log(JSON.stringify(coverage(stack.tools || []), null, 2));
}
