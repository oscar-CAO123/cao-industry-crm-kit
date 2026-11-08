#!/usr/bin/env node
// Installs a vendor SDK only when a client needs it, from its pinned pointer in vendor-sdks/<app>/.
// The kit never carries SDK code: each folder holds the SDK's package.json and the exact lockfile that
// was audited (every package, version and sha512). `npm ci` installs exactly that tree and refuses any
// file whose hash does not match. Install scripts are off. Afterwards every installed package is checked
// against the lockfile again, and anything extra or different is reported as a failure.
//
//   node tools/sdk-install.mjs              list the pointers and which are installed
//   node tools/sdk-install.mjs stripe xero  install those
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "vendor-sdks");
const SAFE = /^[a-z0-9][a-z0-9-]*$/;
const pointers = fs.readdirSync(ROOT).filter((d) => fs.existsSync(path.join(ROOT, d, "package-lock.json"))).sort();

function check(app) {
  const dir = path.join(ROOT, app);
  const want = JSON.parse(fs.readFileSync(path.join(dir, "package-lock.json"), "utf8")).packages;
  const gotFile = path.join(dir, "node_modules", ".package-lock.json");
  if (!fs.existsSync(gotFile)) return ["not installed"];
  const got = JSON.parse(fs.readFileSync(gotFile, "utf8")).packages;
  const problems = [];
  for (const [k, v] of Object.entries(want)) {
    if (!k) continue;
    if (!got[k]) { if (!v.optional) problems.push(`${k} missing`); continue; }
    if (got[k].version !== v.version || got[k].integrity !== v.integrity) problems.push(`${k} differs from the audited pin`);
  }
  for (const k of Object.keys(got)) if (!(k in want)) problems.push(`${k} is not in the audited pin`);
  return problems;
}

const apps = process.argv.slice(2);
if (!apps.length) {
  for (const a of pointers) {
    const p = check(a);
    const pkg = Object.entries(JSON.parse(fs.readFileSync(path.join(ROOT, a, "package.json"), "utf8")).dependencies).map(([n, v]) => `${n}@${v}`).join(" ");
    console.log(`${a.padEnd(18)} ${pkg.padEnd(40)} ${p.length ? p[0] : "installed, matches the audited pin"}`);
  }
  process.exit(0);
}
let failed = 0;
for (const app of apps) {
  if (!SAFE.test(app) || !pointers.includes(app)) { console.error(`${app}: no pinned pointer in vendor-sdks/`); failed++; continue; }
  const r = spawnSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: path.join(ROOT, app), stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, npm_config_ignore_scripts: "true" },
  });
  const problems = r.status === 0 ? check(app) : [`npm ci failed (exit ${r.status})`];
  if (problems.length) { failed++; console.error(`${app}: ${problems.join("; ")}`); }
  else console.log(`${app}: installed, every package matches the audited pin`);
}
process.exit(failed ? 1 : 0);
