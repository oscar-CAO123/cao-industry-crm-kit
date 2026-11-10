#!/usr/bin/env node
// The key resolver. shell/scripts/with-secrets.sh runs it as a short-lived child, reads what it prints, drops the
// service account token and then replaces itself with the real command. Nothing starts through this file directly,
// because a Node process cannot replace itself and would stay alive as the parent of the service with the token in
// its start-up environment, which any other process of the same user can read.
//
//   sh shell/scripts/with-secrets.sh -- node server.js        (this file is run as: node with-secrets.mjs --print)
//
// What --print writes to stdout, one line per mapped key, and nothing else:
//   V NAME <value, base64>     the key was read from 1Password
//   M NAME                     the key could not be read (the wrapper clears any host copy of that name)
// With --names it prints just the mapped names, needing no token, so they can be cleared even when nothing loads.
// Warnings go to stderr and name keys, never values.
//
// Rules, all enforced below:
// - The refs file (SHELL_SECRET_REFS, default shell/secrets.refs.json) maps env names to "op://<vault>/<item>/<field>".
//   It must sit inside the shell folder and end in .json. Refs are not secrets; the values never touch disk.
// - Every ref must be in SHELL_VAULT, the one vault this business uses. A ref to any other vault is skipped.
// - A name that changes how a shell, the dynamic loader or Node run code may never be set from a vault value.
// - One bad entry or one missing key never stops the service: it is skipped with a warning and only the feature that
//   needs it fails. Every read has its own time limit, and the whole fetch has one.
// - Output names keys, never values. Errors say which name failed, never what it held.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHELL_ROOT = path.resolve(HERE, "..");
const NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
const REF = /^op:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)$/;
export const PER_KEY_MS = 15_000;
export const TOTAL_MS = 60_000;

/** Names a map may never set: they change how the shell, the dynamic loader or Node run code, or belong to the
 *  helper itself. A value from 1Password under one of these would be code execution, not a key. */
export function blockedName(name) {
  return /^(PATH|IFS|ENV|BASH_ENV|HOME|SHELL|PS4|CDPATH|TMPDIR|GCONV_PATH|GLIBC_TUNABLES|LOCPATH|NLSPATH|HOSTALIASES|BASHOPTS|SHELLOPTS|BROWSER|EDITOR|VISUAL|PAGER|ZDOTDIR)$/.test(name)
    || /^(NODE_|NPM_|YARN_|PNPM_|BUN_|DENO_|SSL_|OPENSSL_|PYTHON|LD_|DYLD_|OP_|BASH_FUNC_|MALLOC_|GIT_|PERL|RUBY|JAVA_|GEM_|PIP_|COREPACK_|CURL_|XDG_|ELECTRON_)/.test(name)
    || /_PROXY$/i.test(name);
}

/** The refs file, or null when the path is not allowed: inside the shell folder only, no "..", .json only. */
export function refsPath(file, root = SHELL_ROOT) {
  if (!file || file.split(/[\\/]/).includes("..")) return null;
  const abs = path.resolve(root, file);
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || !/\.json$/.test(abs)) return null;
  // A link inside the folder must not lead outside it: when the file exists, its real path has to stay inside too.
  if (fs.existsSync(abs)) {
    const real = path.relative(fs.realpathSync(root), fs.realpathSync(abs));
    if (!real || real.startsWith("..") || path.isAbsolute(real)) return null;
  }
  return abs;
}

/** Sort a refs object into the keys that may load and the entries skipped, each with a reason (never a value). */
export function planRefs(raw, vault) {
  const refs = {}; const skipped = [];
  if (!vault) return { refs, skipped, fatal: "set SHELL_VAULT to the business's 1Password vault name" };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { refs, skipped, fatal: "the refs file must be an object of NAME: op://vault/item/field" };
  for (const [name, ref] of Object.entries(raw)) {
    if (!NAME.test(name)) { skipped.push([name, "bad key name"]); continue; }
    if (blockedName(name)) { skipped.push([name, "a name that may never be set from a vault"]); continue; }
    const m = REF.exec(String(ref));
    if (!m) { skipped.push([name, "not an op:// reference"]); continue; }
    let refVault;
    try { refVault = decodeURIComponent(m[1]); } catch { skipped.push([name, "a malformed escape in the vault name"]); continue; } // one bad entry never drops the rest
    if (refVault !== vault) { skipped.push([name, "refers to a vault other than SHELL_VAULT"]); continue; }
    refs[name] = String(ref);
  }
  return { refs, skipped };
}

/** The strict reader, for checks and tooling: any skipped entry is an error. */
export function readRefs(file, vault) {
  const plan = planRefs(JSON.parse(fs.readFileSync(file, "utf8")), vault);
  if (plan.fatal) throw new Error(plan.fatal);
  if (plan.skipped.length) { const [name, why] = plan.skipped[0]; throw new Error(`${name}: ${why}`); }
  return plan.refs;
}

const limit = (p, ms) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("timed out")), Math.max(1, ms));
  Promise.resolve(p).then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
});

/** The 1Password SDK resolver. Loaded only when needed; the package passed a security sweep before it was added. */
export async function sdkResolver(token, load = () => import("@1password/sdk")) {
  let sdk;
  try { sdk = await load(); } catch { throw new Error("the 1Password SDK (@1password/sdk) is not installed in this deploy"); }
  let client;
  // Only a fixed message ever leaves here: an SDK error is never repeated, in case it quotes what it was given.
  try { client = await limit(sdk.createClient({ auth: token, integrationName: "crm-shell", integrationVersion: "1" }), PER_KEY_MS); } catch { throw new Error("could not sign in to 1Password with the service account token"); }
  return async (ref) => client.secrets.resolve(ref);
}

/** Read every key it can. A key that is slow, denied or empty is left out and named in `missing`; the rest load. */
export async function resolveAvailable(refs, resolve, { perKeyMs = PER_KEY_MS, totalMs = TOTAL_MS } = {}) {
  const started = Date.now(); const values = {}; const missing = [];
  await Promise.all(Object.entries(refs).map(async ([name, ref]) => {
    try {
      const left = totalMs - (Date.now() - started);
      const v = await limit(resolve(ref), Math.min(perKeyMs, left));
      if (typeof v !== "string" || !v) throw new Error("empty");
      values[name] = v;
    } catch { missing.push(name); }
  }));
  return { values, missing: missing.sort() };
}

/** --names: every name the refs file maps (blocked ones left out), one per line, whatever its reference looks like and
 *  even if SHELL_VAULT is not set. Needs no token and no network, so the wrapper can clear any host copy of those
 *  names even when it cannot load the keys. */
function namesMode() {
  try {
    const file = refsPath(process.env.SHELL_SECRET_REFS || "secrets.refs.json");
    const raw = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const names = Object.keys(raw).filter((n) => NAME.test(n) && !blockedName(n)).sort();
      process.stdout.write(names.join("\n") + (names.length ? "\n" : ""));
    }
  } catch { /* no names to clear */ }
  process.exit(0);
}

async function printMode() {
  const warn = (m) => console.error(`==> 1Password: ${m}`);
  const token = process.env.OP_SERVICE_ACCOUNT_TOKEN || process.env.SHELL_OP_TOKEN;
  if (!token) { warn("OP_SERVICE_ACCOUNT_TOKEN missing"); process.exit(1); }
  const file = refsPath(process.env.SHELL_SECRET_REFS || "secrets.refs.json");
  if (!file) { warn("SHELL_SECRET_REFS must name a .json file inside the shell folder"); process.exit(1); }
  if (!fs.existsSync(file)) { warn("the refs file was not found"); process.exit(1); }
  let plan;
  try { plan = planRefs(JSON.parse(fs.readFileSync(file, "utf8")), process.env.SHELL_VAULT); } catch { warn("the refs file is not valid JSON"); process.exit(1); }
  if (plan.fatal) { warn(plan.fatal); process.exit(1); }
  for (const [name, why] of plan.skipped) warn(`${name}: ${why}; skipped`);
  let resolve;
  try { resolve = await sdkResolver(token); } catch (e) { warn(String(e?.message ?? e)); process.exit(1); } // fixed messages only, see sdkResolver
  const { values, missing } = await resolveAvailable(plan.refs, resolve);
  const out = [];
  for (const name of Object.keys(plan.refs).sort()) out.push(name in values ? `V ${name} ${Buffer.from(values[name], "utf8").toString("base64")}` : `M ${name}`);
  console.error(`[secrets] ${Object.keys(values).length} keys from 1Password: ${Object.keys(values).sort().join(", ")}`);
  if (missing.length) warn(`not loaded, starting without: ${missing.join(" ")}`);
  process.stdout.write(out.join("\n") + (out.length ? "\n" : ""), () => process.exit(0));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === "--names") namesMode();
  if (process.argv[2] !== "--print") { console.error("[secrets] run this through shell/scripts/with-secrets.sh"); process.exit(2); }
  // Nothing is allowed to hang a start: the wasm client can keep handles open, so the process ends by force.
  setTimeout(() => { console.error("==> 1Password: timed out"); process.exit(1); }, TOTAL_MS + 15_000).unref();
  printMode().catch(() => { console.error("==> 1Password: keys could not be loaded"); process.exit(1); });
}
