// Fixes from the 17 Nov 2026 security review. Each test replays an attack from that review and passes when it fails.
// Fake network and pure functions only: no keys, no real accounts, no terminal.
import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { call, setTransport, grantWrites, revokeWrites, writesAllowed, WriteBlocked, type AppSpec } from "../core/lib/http.ts";
import { signTicket, verifyTicket, requirePerson } from "../core/workflows/approval-proof.ts";
import { approvalTicket } from "../shell/lib/shell/approval-ticket.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { main } from "../tools/workflow.ts";
import { describe } from "../core/sdk/call.ts";
import { jobs, keyNames, render as renderShell } from "../tools/shell-deploy.ts";
import { render as renderWorkflow, TARGETS } from "../tools/deploy.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const SECRET = "s".repeat(48);

beforeEach(() => { revokeWrites(); setTransport(null); process.env.BETTER_AUTH_SECRET = SECRET; delete process.env.KIT_APPROVAL_TICKET; delete process.env.KIT_ALLOW_WRITES; });
afterEach(() => { revokeWrites(); setTransport(null); delete process.env.KIT_ALLOW_WRITES; });

// ---------- the write gate ----------
test("KIT_ALLOW_WRITES=1 alone opens nothing on the real network: a write needs a grant from an entry point", () => {
  process.env.KIT_ALLOW_WRITES = "1";
  assert.equal(writesAllowed(), false);
  grantWrites("test");
  assert.equal(writesAllowed(), true);
  revokeWrites();
  assert.equal(writesAllowed(), false);
});

test("swapping only the logger (real fetch kept) does not open the gate", () => {
  process.env.KIT_ALLOW_WRITES = "1";
  setTransport({ log: () => {} });
  assert.equal(writesAllowed(), false);
});

test("a script importing a connector cannot write with the switch alone: refused before any socket", async () => {
  process.env.KIT_ALLOW_WRITES = "1";
  const spec: AppSpec = { app: "demo", hosts: ["api.example.com"] };
  // Real transport: a POST must be blocked before fetch is ever reached.
  await assert.rejects(call(spec, { method: "POST", url: "https://api.example.com/v1/things", json: { a: 1 } }), (e: any) => e instanceof WriteBlocked);
});

test("a grant never opens writes when the deploy switch is off", () => {
  grantWrites("test");
  assert.equal(writesAllowed(), false);
});

// ---------- approval proof ----------
const d = { id: "wf.q-1", decision: "approve" as const, who: "sam@example.com" };

test("the CRM's ticket verifies for exactly its own decision, and the shell and core agree on the format", () => {
  const t = approvalTicket(d.id, d.who);
  assert.ok(verifyTicket(t, d));
  assert.ok(verifyTicket(signTicket(d), d));
  assert.equal(verifyTicket(t, { ...d, id: "wf.q-2" }), false, "another approval");
  assert.equal(verifyTicket(t, { ...d, who: "agent" }), false, "another name");
  assert.equal(verifyTicket(t, { ...d, confirm: "retry" }), false, "a done|retry answer it was not signed for");
  assert.ok(verifyTicket(approvalTicket(d.id, d.who, "done"), { ...d, confirm: "done" }));
});

test("a ticket expires, cannot be forged without the CRM secret, and is refused when the secret is short", () => {
  const t = signTicket(d, Date.now() - 3 * 60_000);
  assert.equal(verifyTicket(t, d), false, "expired");
  const far = signTicket(d);
  assert.equal(verifyTicket(far.replace(/^\d+/, String(Date.now() + 3_600_000)), d), false, "expiry pushed out");
  process.env.BETTER_AUTH_SECRET = "x".repeat(48);
  assert.equal(verifyTicket(far, d), false, "another secret");
  process.env.BETTER_AUTH_SECRET = "short";
  assert.throws(() => signTicket(d), /BETTER_AUTH_SECRET/);
  assert.equal(verifyTicket(far, d), false);
});

test("without a ticket, approval needs a person typing approve at the terminal; no terminal or any other answer refuses", () => {
  assert.throws(() => requirePerson(d, "Send quote", () => null), /needs a person/);
  assert.throws(() => requirePerson(d, "Send quote", () => "yes"), /not approved/);
  assert.equal(requirePerson(d, "Send quote", () => "approve"), "terminal");
  process.env.KIT_APPROVAL_TICKET = approvalTicket(d.id, d.who);
  assert.equal(requirePerson(d, "Send quote", () => { throw new Error("must not ask"); }), "ticket");
});

test("the CLI approve refuses an agent: nothing runs and the approval stays pending", async () => {
  const store = new MemoryStore();
  const dir = "industries/all/workflows/customer-service/complaints";
  const wf = JSON.parse(fs.readFileSync(path.join(ROOT, dir, "workflow.json"), "utf8"));
  await store.put("approvals", "x1", { id: "x1", workflow: wf.id, summary: "Send reply", acts: [], status: "pending", created: new Date().toISOString() });
  process.env.KIT_ALLOW_WRITES = "1";
  await assert.rejects(main(["approve", dir, "x1", "boss@example.com"], store, () => null), /needs a person/);
  assert.equal((await store.get<any>("approvals", "x1")).status, "pending");
  assert.equal(writesAllowed(), false, "no grant was given");
  // A ticket signed for someone else's name does not pass either.
  process.env.KIT_APPROVAL_TICKET = approvalTicket("x1", "someone-else@example.com");
  await assert.rejects(main(["approve", dir, "x1", "boss@example.com"], store, () => null), /needs a person/);
});

// ---------- read or write ----------
test("Zenoti's collect-payment GET is a write, so it never skips the gate", () => {
  const o = describe("zenoti", "docs.get_Catalog_Payments_Invoice_IntializePayment");
  assert.equal(o.kind, "write");
  const src = fs.readFileSync(path.join(ROOT, "tools/sdk-generate.mjs"), "utf8");
  assert.match(src, /\|collect\|initiali\[sz\]e\|intiali\[sz\]e\|initiate\)/, "the generator treats collect and initialize as actions");
});

// ---------- generated deploy files ----------
test("no generated deploy file switches writes on", () => {
  const js = jobs(["construction"]);
  const keys = keyNames(["construction"]);
  assert.ok(keys.includes("KIT_TOKEN_KEY"));
  for (const t of ["docker", "server", "railway", "aws", "gcp", "azure", "vercel", "supabase", "cloudflare", "netlify"] as const) {
    const all = Object.values(renderShell(t, js, keys)).join("\n");
    assert.doesNotMatch(all, /KIT_ALLOW_WRITES(=|: ?|, Value: )"?1/, t);
  }
  const dir = "industries/construction/workflows/fulfilment/x-plant";
  for (const t of TARGETS) {
    const all = Object.values(renderWorkflow(dir, {}, t)).join("\n");
    assert.doesNotMatch(all, /KIT_ALLOW_WRITES(=|: ?|, Value: )"?1\b/, t);
  }
});

// ---------- saved sign-in tokens ----------
test("saved tokens are encrypted at rest; a plain or swapped file is never trusted; no key means no token", async () => {
  const { FileTokenStore } = await import("../core/lib/secrets.ts");
  const os = await import("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kit-tok-enc-"));
  try {
    process.env.KIT_TOKEN_KEY = "k".repeat(40);
    const s = new FileTokenStore(dir);
    await s.set("xero.refresh_token", "refresh-value-123");
    const raw = fs.readFileSync(path.join(dir, "xero.refresh_token"), "utf8");
    assert.ok(raw.startsWith("v1.") && !raw.includes("refresh-value-123"), "not plain text");
    assert.equal(await s.get("xero.refresh_token"), "refresh-value-123");
    fs.copyFileSync(path.join(dir, "xero.refresh_token"), path.join(dir, "google.refresh"));
    await assert.rejects(s.get("google.refresh"), /does not decrypt/, "a file moved to another token's name");
    fs.writeFileSync(path.join(dir, "planted"), "attacker-token");
    assert.equal(await s.get("planted"), null, "plain text is ignored");
    process.env.KIT_TOKEN_KEY = "j".repeat(40);
    await assert.rejects(s.get("xero.refresh_token"), /does not decrypt/);
    delete process.env.KIT_TOKEN_KEY;
    await assert.rejects(s.get("xero.refresh_token"), /KIT_TOKEN_KEY/);
    await assert.rejects(s.set("x", "v"), /KIT_TOKEN_KEY/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); delete process.env.KIT_TOKEN_KEY; }
});

test("Xero never spends its single-use refresh token when the new one could not be saved", async () => {
  const { FileTokenStore, setTokenStore } = await import("../core/lib/secrets.ts");
  const os = await import("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kit-tok-ready-"));
  const hits: string[] = [];
  setTransport({ fetch: (async (u: any) => { hits.push(String(u)); return new Response("{}", { status: 200 }); }) as any });
  try {
    delete process.env.KIT_TOKEN_KEY;
    process.env.XERO_REFRESH_TOKEN = "fake-refresh"; process.env.XERO_CLIENT_ID = "id"; process.env.XERO_CLIENT_SECRET = "s";
    setTokenStore(new FileTokenStore(dir));
    const xero = await import("../core/connectors/xero/client.ts");
    await assert.rejects(xero.accessToken(), /KIT_TOKEN_KEY/);
    assert.equal(hits.length, 0, "no token exchange was sent");
    assert.equal(fs.readdirSync(dir).length, 0, "no temp file left behind");
  } finally {
    setTokenStore(null); fs.rmSync(dir, { recursive: true, force: true });
    for (const k of ["XERO_REFRESH_TOKEN", "XERO_CLIENT_ID", "XERO_CLIENT_SECRET"]) delete process.env[k];
  }
});
