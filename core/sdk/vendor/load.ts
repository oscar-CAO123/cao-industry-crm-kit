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
  if (!fs.existsSync(path.join(dir, "node_modules", ".package-lock.json"))) {
    throw new Error(`${app}: its official SDK is not installed. Run: node tools/sdk-install.mjs ${app}`);
  }
  return createRequire(path.join(dir, "package.json"));
}
