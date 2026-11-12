// The shell's key launcher has to keep every protection the production CRM's entrypoint has. Each test below fails
// if one is removed: blocked names, a token that never survives into the service, a missing key that never stops
// the start, time limits, and values that can only ever be data.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const SH = path.join(ROOT, "shell/scripts/with-secrets.sh");
const MJS = path.join(ROOT, "shell/scripts/with-secrets.mjs");
const L = await import(MJS);
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
// A hung read must fail its own test, not stall the run and cancel the others.
const within = <T,>(p: Promise<T>, ms: number): Promise<T> => new Promise<T>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`still waiting after ${ms} ms`)), ms);
  p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
});

// ---- The resolver -------------------------------------------------------------------------------------------------
test("names that change how code runs are never set from a vault", () => {
  for (const n of ["PATH", "IFS", "ENV", "BASH_ENV", "HOME", "SHELL", "PS4", "CDPATH", "TMPDIR", "NODE_OPTIONS", "NODE_PATH", "NPM_CONFIG_REGISTRY",
    "SSL_CERT_FILE", "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "PYTHONPATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "OP_SERVICE_ACCOUNT_TOKEN", "OP_ANYTHING", "GCONV_PATH", "GLIBC_TUNABLES", "LOCPATH", "NLSPATH", "HOSTALIASES", "BASH_FUNC_x", "MALLOC_CONF", "OPENSSL_CONF", "OPENSSL_MODULES"]) {
    assert.ok(L.blockedName(n), `${n} is blocked`);
  }
  for (const n of ["DATABASE_URL", "BETTER_AUTH_SECRET", "SMTP_URL", "KIT_RUNNER_TOKEN", "STRIPE_KEY"]) assert.ok(!L.blockedName(n), `${n} is allowed`);
});

test("a refs file maps only allowed names, from the one vault, and skips the rest with a reason", () => {
  const plan = L.planRefs({
    DATABASE_URL: "op://Biz/db/url", NODE_OPTIONS: "op://Biz/x/y", LD_PRELOAD: "op://Biz/x/y", OP_X: "op://Biz/x/y", lower: "op://Biz/x/y",
    OTHER_VAULT: "op://Elsewhere/x/y", NOT_A_REF: "hunter2", PLAIN: 5,
  }, "Biz");
  assert.deepEqual(Object.keys(plan.refs), ["DATABASE_URL"]);
  assert.deepEqual(plan.skipped.map(([n]: string[]) => n).sort(), ["LD_PRELOAD", "NODE_OPTIONS", "NOT_A_REF", "OP_X", "OTHER_VAULT", "PLAIN", "lower"].sort());
  assert.ok(plan.skipped.every(([, why]: string[]) => !/hunter2|Biz\/|Elsewhere/.test(why)), "reasons never repeat a value or a reference");
  assert.match(L.planRefs({}, "").fatal, /SHELL_VAULT/);
  assert.match(L.planRefs([], "Biz").fatal, /object/);
});

test("the refs file must sit inside the shell folder and be .json", () => {
  const root = "/kit/shell";
  assert.equal(L.refsPath("secrets.refs.json", root), "/kit/shell/secrets.refs.json");
  assert.equal(L.refsPath("config/prod.json", root), "/kit/shell/config/prod.json");
  for (const bad of ["../secrets.refs.json", "/etc/passwd", "/kit/other/secrets.refs.json", "secrets.refs.json/../../x.json", "refs.txt", "", "."]) assert.equal(L.refsPath(bad, root), null, bad);
});

test("a slow, denied or empty key is left out and named; the others load; no value leaks", async () => {
  const SECRET = "SUPER-SECRET-VALUE";
  const resolve = (ref: string) => {
    if (ref.endsWith("/ok")) return Promise.resolve("fine");
    if (ref.endsWith("/hang")) return new Promise<string>(() => {});
    if (ref.endsWith("/denied")) return Promise.reject(new Error(`denied ${SECRET}`));
    return Promise.resolve("");
  };
  const t0 = Date.now();
  const r = await within(L.resolveAvailable({ A: "op://Biz/a/ok", B: "op://Biz/b/hang", C: "op://Biz/c/denied", D: "op://Biz/d/empty" }, resolve, { perKeyMs: 60, totalMs: 400 }), 2000);
  assert.deepEqual(r.values, { A: "fine" });
  assert.deepEqual(r.missing, ["B", "C", "D"]);
  assert.ok(Date.now() - t0 < 1000, "a hung read does not hold the start");
  assert.ok(!JSON.stringify(r).includes(SECRET));
});

test("the whole fetch has a time limit as well as each key", async () => {
  const t0 = Date.now();
  const r = await within(L.resolveAvailable({ A: "op://Biz/a/x", B: "op://Biz/b/x" }, () => new Promise<string>(() => {}), { perKeyMs: 5000, totalMs: 80 }), 2000);
  assert.deepEqual(r.missing, ["A", "B"]);
  assert.ok(Date.now() - t0 < 1000);
});

test("the resolver refuses to be started directly, so nothing runs as a long-lived parent holding the token", () => {
  const r = spawnSync(process.execPath, [MJS], { encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /with-secrets\.sh/);
});

// ---- The shell entry script ---------------------------------------------------------------------------------------
function stubNode() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-"));
  fs.mkdirSync(path.join(dir, "bin"));
  const seen = path.join(dir, "seen-token");
  fs.writeFileSync(path.join(dir, "bin/node"), `#!/bin/sh\nif [ "$2" = "--names" ]; then printf '%s' "$STUB_NAMES"; exit "\${STUB_NAMES_EXIT:-0}"; fi\nprintf '%s' "$OP_SERVICE_ACCOUNT_TOKEN" > "${seen}"\nprintf '%s' "$STUB_OUT"\nexit "\${STUB_EXIT:-0}"\n`, { mode: 0o755 });
  return { dir, bin: path.join(dir, "bin"), seen };
}
const run = (s: ReturnType<typeof stubNode>, cmd: string[], env: Record<string, string>) =>
  spawnSync("sh", [SH, "--", ...cmd], { encoding: "utf8", cwd: s.dir, env: { PATH: `${s.bin}:/usr/bin:/bin`, ...env } });
const show = ["sh", "-c", 'printf "%s|%s|%s|%s" "$FOO" "${BAR-unset}" "${OP_SERVICE_ACCOUNT_TOKEN-gone}" "${SHELL_OP_TOKEN-gone}"'];

test("keys reach the command; a stale host copy of a missing key is cleared; the token is gone", () => {
  const s = stubNode();
  const r = run(s, show, { STUB_OUT: `V FOO ${b64("val")}\nM BAR\n`, OP_SERVICE_ACCOUNT_TOKEN: "tok-1", SHELL_OP_TOKEN: "tok-2", BAR: "stale" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "val|unset|gone|gone");
  assert.equal(fs.readFileSync(s.seen, "utf8"), "tok-1", "only the resolver child receives the token");
});

test("the launcher replaces itself with the command: no process is left holding the token", async () => {
  const s = stubNode();
  const child = spawn("sh", [SH, "--", "sh", "-c", "echo $$"], { cwd: s.dir, env: { PATH: `${s.bin}:/usr/bin:/bin`, STUB_OUT: `V FOO ${b64("v")}\n`, OP_SERVICE_ACCOUNT_TOKEN: "tok" } });
  let out = ""; child.stdout.on("data", (d) => (out += d));
  await new Promise((res) => child.on("close", res));
  assert.equal(Number(out.trim()), child.pid, "the command runs as the very process that was started");
});

test("a value is only ever data: shell syntax, quotes and newlines in it are not run", () => {
  const s = stubNode();
  const nasty = 'a b "q" \'s\' $(touch PWNED) `touch PWNED2` ; | & > x\nsecond line * ?';
  const r = run(s, ["sh", "-c", 'printf "%s" "$FOO"'], { STUB_OUT: `V FOO ${b64(nasty)}\n`, OP_SERVICE_ACCOUNT_TOKEN: "t" });
  assert.equal(r.stdout, nasty);
  assert.ok(!fs.existsSync(path.join(s.dir, "PWNED")) && !fs.existsSync(path.join(s.dir, "PWNED2")));
});

test("names that change how code runs are ignored even if the resolver prints them", () => {
  const s = stubNode();
  const lines = ["NODE_OPTIONS", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "HTTPS_PROXY", "PYTHONPATH", "OP_FOO", "BASH_ENV", "IFS", "GCONV_PATH", "GLIBC_TUNABLES", "OPENSSL_CONF", "foo", "A-B", "PATH"].map((n) => `V ${n} ${b64("evil")}`);
  const r = run(s, ["sh", "-c", 'printf "%s|%s|%s|%s|%s|%s|%s|%s|%s|%s" "${NODE_OPTIONS-u}" "${LD_PRELOAD-u}" "${HTTPS_PROXY-u}" "${PYTHONPATH-u}" "${OP_FOO-u}" "${BASH_ENV-u}" "${GCONV_PATH-u}" "${GLIBC_TUNABLES-u}" "${OPENSSL_CONF-u}" "$PATH"'],
    { STUB_OUT: lines.join("\n") + `\nV GOOD ${b64("ok")}\n`, OP_SERVICE_ACCOUNT_TOKEN: "t" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `u|u|u|u|u|u|u|u|u|${s.bin}:/usr/bin:/bin`);
});

test("a loading problem never stops the start: the command still runs, with a warning and no token", () => {
  const s = stubNode();
  const r = run(s, ["sh", "-c", 'printf "ran:%s" "${OP_SERVICE_ACCOUNT_TOKEN-gone}"'], { STUB_OUT: "", STUB_EXIT: "1", OP_SERVICE_ACCOUNT_TOKEN: "tok" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "ran:gone");
  assert.match(r.stderr, /starting without 1Password keys/);
  assert.ok(!r.stderr.includes("tok"), "a warning never repeats the token");
});

test("with no token the command still starts, and the resolver is never run", () => {
  const s = stubNode();
  const r = run(s, ["sh", "-c", "printf ran"], { STUB_OUT: `V FOO ${b64("v")}\n` });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "ran");
  assert.match(r.stderr, /OP_SERVICE_ACCOUNT_TOKEN missing/);
  assert.ok(!fs.existsSync(s.seen), "the resolver was not started");
});

test("a token in a mounted secret file reaches only the resolver, never the command's environment", () => {
  const s = stubNode();
  const f = path.join(s.dir, "op-token");
  fs.writeFileSync(f, "file-token-1\n");
  const r = run(s, show, { STUB_OUT: `V FOO ${b64("val")}\n`, SHELL_OP_TOKEN_FILE: f });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "val|unset|gone|gone", "keys load and no token variable is left for the service");
  assert.equal(fs.readFileSync(s.seen, "utf8"), "file-token-1", "the resolver got the file's token, trimmed");
  assert.ok(!r.stderr.includes("file-token-1"));
});

test("the token file wins over a token variable, and a missing, empty or unreadable file never stops the start", () => {
  const s = stubNode();
  const f = path.join(s.dir, "op-token");
  fs.writeFileSync(f, "file-token");
  const both = run(s, show, { STUB_OUT: `V FOO ${b64("v")}\n`, OP_SERVICE_ACCOUNT_TOKEN: "env-token", SHELL_OP_TOKEN_FILE: f });
  assert.equal(both.status, 0);
  assert.equal(both.stdout, "v|unset|gone|gone", "the variable is still dropped before the service starts");
  assert.equal(fs.readFileSync(s.seen, "utf8"), "file-token");
  fs.rmSync(s.seen);
  // An empty file falls back to the variable, so a platform that offers only variables still starts with its keys.
  const empty = path.join(s.dir, "empty-first"); fs.writeFileSync(empty, "\n");
  const fallback = run(s, show, { STUB_OUT: `V FOO ${b64("v")}\n`, OP_SERVICE_ACCOUNT_TOKEN: "env-token", SHELL_OP_TOKEN_FILE: empty });
  assert.equal(fallback.status, 0);
  assert.equal(fs.readFileSync(s.seen, "utf8"), "env-token");
  fs.rmSync(s.seen);
  for (const [label, file] of [["missing", path.join(s.dir, "nope")], ["empty", (() => { const e = path.join(s.dir, "empty"); fs.writeFileSync(e, "  \n"); return e; })()], ["a directory", s.dir]] as const) {
    const r = run(s, ["sh", "-c", "printf ran"], { STUB_OUT: `V FOO ${b64("v")}\n`, SHELL_OP_TOKEN_FILE: file });
    assert.equal(r.status, 0, label);
    assert.equal(r.stdout, "ran", label);
    assert.match(r.stderr, /starting without 1Password keys/, label);
    assert.ok(!fs.existsSync(s.seen), `${label}: the resolver was not started`);
  }
});

test("systemd's credential (LoadCredential=op-token:...) is read from CREDENTIALS_DIRECTORY and wins over a variable", () => {
  const s = stubNode();
  const creds = path.join(s.dir, "creds"); fs.mkdirSync(creds);
  fs.writeFileSync(path.join(creds, "op-token"), "systemd-token\n");
  const r = run(s, show, { STUB_OUT: `V FOO ${b64("val")}\n`, CREDENTIALS_DIRECTORY: creds, OP_SERVICE_ACCOUNT_TOKEN: "env-token" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "val|unset|gone|gone");
  assert.equal(fs.readFileSync(s.seen, "utf8"), "systemd-token");
});

test("a mapped name is cleared even when nothing loads: no token, or a resolver that fails", () => {
  const show2 = ["sh", "-c", 'printf "%s|%s|%s" "${BAR-unset}" "${BAZ-unset}" "${KEEP-unset}"'];
  const names = "BAR\nBAZ\nNODE_OPTIONS\nbad-name\n";
  const s = stubNode();
  const noToken = run(s, show2, { STUB_NAMES: names, BAR: "stale", BAZ: "stale2", KEEP: "mine" });
  assert.equal(noToken.status, 0);
  assert.equal(noToken.stdout, "unset|unset|mine", "no token: stale host copies of mapped names are gone, other settings are kept");
  const failed = run(s, show2, { STUB_NAMES: names, STUB_OUT: "", STUB_EXIT: "1", OP_SERVICE_ACCOUNT_TOKEN: "t", BAR: "stale", BAZ: "stale2", KEEP: "mine" });
  assert.equal(failed.stdout, "unset|unset|mine", "resolver failed: same");
  const blocked = run(s, ["sh", "-c", 'printf "%s" "${NODE_OPTIONS-unset}"'], { STUB_NAMES: "NODE_OPTIONS\n", NODE_OPTIONS: "--require /x.js" });
  assert.equal(blocked.stdout, "--require /x.js", "a blocked name is never touched, in either direction");
});

test("--names prints every mapped name that may be set, with no token, no network and whatever its reference looks like", () => {
  const f = path.join(ROOT, "shell", `.tmp-refs-${process.pid}.json`);
  fs.writeFileSync(f, JSON.stringify({ B_KEY: "op://Biz/b/x", A_KEY: "op://Biz/a/x", NODE_OPTIONS: "op://Biz/n/x", WRONG: "op://Elsewhere/w/x" }));
  try {
    const r = spawnSync(process.execPath, [MJS, "--names"], { encoding: "utf8", env: { PATH: process.env.PATH, SHELL_VAULT: "Biz", SHELL_SECRET_REFS: path.basename(f) } });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "A_KEY\nB_KEY\nWRONG\n", "a mapped name is cleared even if its reference is for another vault; a blocked name is never listed");
    const noVault = spawnSync(process.execPath, [MJS, "--names"], { encoding: "utf8", env: { PATH: process.env.PATH, SHELL_SECRET_REFS: path.basename(f) } });
    assert.equal(noVault.stdout, "A_KEY\nB_KEY\nWRONG\n", "still lists them when SHELL_VAULT is not set");
    const none = spawnSync(process.execPath, [MJS, "--names"], { encoding: "utf8", env: { PATH: process.env.PATH, SHELL_VAULT: "Biz", SHELL_SECRET_REFS: "../outside.json" } });
    assert.equal(none.stdout, "");
  } finally { fs.rmSync(f, { force: true }); }
});

test("a sign-in error never leaves the resolver with the token in it", async () => {
  const TOKEN = "not-a-real-token-value-for-the-test";
  const fake = async () => ({ createClient: async (cfg: { auth: string }) => { throw new Error(`bad token ${cfg.auth}`); } });
  await assert.rejects(L.sdkResolver(TOKEN, fake), (e: Error) => !e.message.includes(TOKEN) && /could not sign in/.test(e.message));
  await assert.rejects(L.sdkResolver(TOKEN, async () => { throw new Error(`load failed ${TOKEN}`); }), (e: Error) => !e.message.includes(TOKEN) && /not installed/.test(e.message));
  const ok = await L.sdkResolver(TOKEN, async () => ({ createClient: async () => ({ secrets: { resolve: async (r: string) => `v:${r}` } }) }));
  assert.equal(await ok("op://Biz/a/b"), "v:op://Biz/a/b");
});

test("a value keeps its trailing newline, so a PEM-style key survives intact", () => {
  const s = stubNode();
  const pem = "-----BEGIN PRIVATE KEY-----\nAAAA\nBBBB\n-----END PRIVATE KEY-----\n";
  const r = run(s, ["sh", "-c", 'printf "%s" "$FOO"'], { STUB_OUT: `V FOO ${b64(pem)}\n`, OP_SERVICE_ACCOUNT_TOKEN: "t" });
  assert.equal(r.stdout, pem);
  const r2 = run(s, ["sh", "-c", 'printf "%s" "$BAR"'], { STUB_OUT: `V BAR ${b64("x\n\n")}\n`, OP_SERVICE_ACCOUNT_TOKEN: "t" });
  assert.equal(r2.stdout, "x\n\n");
});

test("a value that does not decode is dropped whole, never exported in part", () => {
  const s = stubNode();
  // A decoder that prints part of a value and then fails, as GNU base64 does on bad input.
  fs.writeFileSync(path.join(s.bin, "base64"), "#!/bin/sh\ncat >/dev/null\nprintf PARTIAL\nexit 1\n", { mode: 0o755 });
  const r = run(s, ["sh", "-c", 'printf "%s" "${FOO-unset}"'], { STUB_OUT: `V FOO ${b64("anything")}\n`, STUB_NAMES: "FOO\n", OP_SERVICE_ACCOUNT_TOKEN: "t", FOO: "stale" });
  assert.equal(r.stdout, "unset", "neither the partial output nor the stale host copy survives");
});

test("the command's own exit code comes back unchanged", () => {
  const s = stubNode();
  assert.equal(run(s, ["sh", "-c", "exit 7"], { STUB_OUT: "", OP_SERVICE_ACCOUNT_TOKEN: "t" }).status, 7);
});

test("every deploy starts the service through the shell entry script", () => {
  const docker = fs.readFileSync(path.join(ROOT, "shell/Dockerfile"), "utf8");
  assert.match(docker, /ENTRYPOINT \["sh", "shell\/scripts\/with-secrets\.sh", "--"\]/);
  const deploy = fs.readFileSync(path.join(ROOT, "tools/shell-deploy.ts"), "utf8");
  // Every way a deploy can name the command: one string, a --command/--args pair, or a quoted argument list.
  assert.ok(!/with-secrets\.mjs/.test(deploy), "no deploy starts the resolver directly");
  assert.ok(!/(--command\s+node\b|\bnode\b[\s,"']+(--args[\s"']+)?(shell\/)?scripts\/with-secrets)/.test(deploy), "no deploy runs the entry script with node");
  assert.ok((deploy.match(/(--command sh --args|\bsh shell\/scripts\/with-secrets\.sh)/g) ?? []).length >= 4, "the deploys that name the script run it with sh");
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "shell/package.json"), "utf8"));
  for (const [name, cmd] of Object.entries<string>(pkg.scripts)) assert.ok(!/with-secrets\.mjs/.test(cmd), `${name} uses the entry script`);
});
