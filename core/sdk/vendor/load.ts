// Loads a vendor SDK from its own pinned folder, vendor-sdks/<app>/, installed on demand by
// tools/sdk-install.mjs. The kit never carries SDK code. Each SDK resolves its own dependencies
// (its own axios, for example), so one SDK's setup can never reach another's.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "vendor-sdks");

export function vendorRequire(app: string): NodeJS.Require {
  const dir = path.join(ROOT, app);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(app) || !fs.existsSync(path.join(dir, "package-lock.json"))) throw new Error(`${app}: no pinned SDK pointer`);
  const installed = path.join(dir, "node_modules", ".package-lock.json");
  if (!fs.existsSync(installed)) throw new Error(`${app}: its official SDK is not installed. Run: node tools/sdk-install.mjs ${app}`);
  // Load only an install that matches the audited pin exactly: same packages, versions and sha512, nothing extra.
  const want = JSON.parse(fs.readFileSync(path.join(dir, "package-lock.json"), "utf8")).packages as Record<string, any>;
  const got = JSON.parse(fs.readFileSync(installed, "utf8")).packages as Record<string, any>;
  const bad = Object.keys(got).some((k) => !(k in want) || got[k].version !== want[k].version || got[k].integrity !== want[k].integrity)
    || Object.entries(want).some(([k, v]) => k && !v.optional && !(k in got));
  if (bad) throw new Error(`${app}: the installed SDK does not match the audited pin; reinstall with node tools/sdk-install.mjs ${app}`);
  return createRequire(path.join(dir, "package.json"));
}
