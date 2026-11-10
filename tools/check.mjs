#!/usr/bin/env node
// Checks every connector record against the capability list and the allowed statuses.
import fs from "node:fs";
import { loadConnectors } from "./coverage.mjs";
const caps = new Set(Object.values(JSON.parse(fs.readFileSync(new URL("../core/capabilities.json", import.meta.url)))).flat());
const statuses = new Set(["record-only", "docs-only", "code-built", "sandbox-tested", "live-tested"]);
let bad = 0; const list = loadConnectors();
for (const c of list) {
  if (!statuses.has(c.status)) { console.error(c.id, "bad status", c.status); bad++; }
  if (c.script && !fs.existsSync(new URL(`../${c.script}`, import.meta.url))) { console.error(c.id, "script missing", c.script); bad++; }
  for (const k of c.capabilities) if (!caps.has(k)) { console.error(c.id, "unknown capability", k); bad++; }
  if (["code-built", "sandbox-tested", "live-tested"].includes(c.status) && !c.script) { console.error(c.id, "tested with no script"); bad++; }
}
console.log(list.length, "connectors checked,", bad, "problems");
process.exit(bad ? 1 : 0);
