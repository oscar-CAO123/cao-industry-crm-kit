#!/usr/bin/env node
// Start a command with its keys resolved from 1Password at run time. The deployed CRM, its approval runner and every
// cron start through this, so no key is ever stored in plain text: not in the repo, not in an env file, not in the
// host's settings. The host holds exactly one secret, OP_SERVICE_ACCOUNT_TOKEN (a read-only 1Password service account
// for the business's own vault; SHELL_OP_TOKEN is the same thing under a name op-scoped may set on a laptop), and this
// launcher never passes that token on.
//
//   node shell/scripts/with-secrets.mjs -- node server.js
//
// Rules, all enforced below:
// - The refs file (SHELL_SECRET_REFS, default shell/secrets.refs.json) maps env names to "op://<vault>/<item>/<field>".
//   Refs are not secrets; the values they point to never touch disk.
// - Every ref must be in SHELL_VAULT, the one vault this business uses. A ref to any other vault is refused.
// - A name in the refs file that is ALSO set in the host's environment stops the start: the key belongs in
//   1Password, not in plain host settings.
// - The child starts with the host environment minus OP_SERVICE_ACCOUNT_TOKEN, plus the resolved keys.
// - Output names keys, never values. Errors say which name failed, never what it held.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
const REF = /^op:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)$/;

export function readRefs(file, vault) {
  if (!vault) throw new Error("set SHELL_VAULT to the business's 1Password vault name");
  const refs = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!refs || typeof refs !== "object" || Array.isArray(refs)) throw new Error("the refs file must be an object of NAME: op://vault/item/field");
  for (const [name, ref] of Object.entries(refs)) {
    if (!NAME.test(name)) throw new Error(`bad key name ${name}`);
    const m = REF.exec(String(ref));
    if (!m) throw new Error(`${name}: not an op:// reference`);
    if (decodeURIComponent(m[1]) !== vault) throw new Error(`${name}: refers to a vault other than SHELL_VAULT`);
  }
  return refs;
}

export function checkHost(refs, env) {
  const plain = Object.keys(refs).filter((n) => env[n]);
  if (plain.length) throw new Error(`these keys are set in the host's settings in plain text; remove them and keep them in 1Password only: ${plain.join(", ")}`);
}

/** The 1Password SDK resolver. Loaded only when needed; the package must pass a security sweep before it is installed. */
export async function sdkResolver(token) {
  let sdk;
  try { sdk = await import("@1password/sdk"); } catch { throw new Error("the 1Password SDK (@1password/sdk) is not installed in this deploy"); }
  const client = await sdk.createClient({ auth: token, integrationName: "crm-shell", integrationVersion: "1" });
  return async (ref) => client.secrets.resolve(ref);
}

export async function resolveAll(refs, resolve) {
  const out = {};
  await Promise.all(Object.entries(refs).map(async ([name, ref]) => {
    let v;
    try { v = await resolve(ref); } catch { throw new Error(`could not read ${name} from 1Password`); }
    if (typeof v !== "string" || !v) throw new Error(`${name} is empty in 1Password`);
    out[name] = v;
  }));
  return out;
}

export function childEnv(env, resolved) {
  const { OP_SERVICE_ACCOUNT_TOKEN: _a, SHELL_OP_TOKEN: _b, ...rest } = env;
  return { ...rest, ...resolved };
}

async function main(argv) {
  const at = argv.indexOf("--");
  const cmd = at >= 0 ? argv.slice(at + 1) : [];
  if (!cmd.length) throw new Error("usage: with-secrets.mjs -- <command> [args]");
  const token = process.env.OP_SERVICE_ACCOUNT_TOKEN || process.env.SHELL_OP_TOKEN;
  if (!token) throw new Error("OP_SERVICE_ACCOUNT_TOKEN is not set");
  const refs = readRefs(process.env.SHELL_SECRET_REFS || path.join(HERE, "..", "secrets.refs.json"), process.env.SHELL_VAULT);
  checkHost(refs, process.env);
  const resolved = await resolveAll(refs, await sdkResolver(token));
  console.log(`[secrets] ${Object.keys(resolved).length} keys from 1Password: ${Object.keys(resolved).sort().join(", ")}`);
  const child = spawn(cmd[0], cmd.slice(1), { stdio: "inherit", env: childEnv(process.env, resolved) });
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
  child.on("exit", (code, sig) => process.exit(code ?? (sig ? 1 : 0)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((e) => { console.error(`[secrets] ${String(e?.message ?? e)}`); process.exit(1); });
}
