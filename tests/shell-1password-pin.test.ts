// The shell's 1Password launcher depends on one audited SDK release. Its version and package hashes are pinned here,
// so a different release or tarball cannot reach the shell without this test (and the sweep it records) being redone.
// Audit: 10 Nov 2026, repo-security-sweep. Both packages: registry hash equals the published tarball, sdk-core wasm and glue
// byte-identical to GitHub tag v0.5.0 (335aef34ca), all 32 sdk files byte-identical to a fresh compile of the tag.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PINNED = {
  "@1password/sdk": { version: "0.5.0", integrity: "sha512-k6kov3pcA7PRg2tev9CgTfEf/3JSyAp11BPQNCEsqAD32QbqM032OXC1rfjyC8Ba0sfH+NHYZxcifUZToyGyYA==" },
  "@1password/sdk-core": { version: "0.5.0", integrity: "sha512-9g7LWOKRKdePZ85evVgE9xEom3DAg3hRIyQdOwLPvpL/F7KpDXmUHMi72rsqJxKaDbWApXmrYjDExMSPqUg7xw==" },
};

test("the shell pins @1password/sdk to the audited release", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "shell/package.json"), "utf8"));
  assert.equal(pkg.dependencies["@1password/sdk"], PINNED["@1password/sdk"].version);
});

test("the shell lockfile holds the audited tarball hashes, and nothing else from 1Password", () => {
  const lock = fs.readFileSync(path.join(ROOT, "shell/pnpm-lock.yaml"), "utf8");
  for (const [name, want] of Object.entries(PINNED)) {
    const m = new RegExp(`'${name}@${want.version.replace(/\./g, "\\.")}':\\n    resolution: \\{integrity: ([^,}]+)`).exec(lock);
    assert.ok(m, `${name} is locked at ${want.version}`);
    assert.equal(m![1], want.integrity, `${name} hash is the audited one`);
  }
  const names = [...lock.matchAll(/^  '(@1password\/[^@']+)@/gm)].map((x) => x[1]).sort();
  assert.deepEqual([...new Set(names)], ["@1password/sdk", "@1password/sdk-core"]);
});

test("the launcher uses only the SDK calls the audit read", () => {
  const src = fs.readFileSync(path.join(ROOT, "shell/scripts/with-secrets.mjs"), "utf8");
  // Every member reached through the imported module or the client: nothing beyond the two calls the audit covered.
  const calls = [...new Set([...src.matchAll(/\b(?:sdk|client)\.[A-Za-z_][\w.]*/g)].map((m) => m[0]))].sort();
  assert.deepEqual(calls, ["client.secrets.resolve", "sdk.createClient"]);
  assert.match(src, /createClient\(\{ auth: token, integrationName/);
  assert.ok(!/DesktopAuth|accountName/.test(src), "never desktop-app sign-in: that path loads a native library");
});
