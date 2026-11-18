// Fixes from the 17 Nov 2026 security review. Each test replays an attack from that review and passes when it fails.
// Fake network and pure functions only: no keys, no real accounts, no terminal.
import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { call, setTransport, grantWrites, revokeWrites, writesAllowed, WriteBlocked, type AppSpec } from "../core/lib/http.ts";
import { signTicket, verifyTicket, requirePerson, actsDigest, approvalDigest, printable } from "../core/workflows/approval-proof.ts";
import { approvalTicket, actsDigest as shellActsDigest, approvalDigest as shellApprovalDigest } from "../shell/lib/shell/approval-ticket.ts";
import { approve, type WorkflowRecord } from "../core/workflows/runtime.ts";
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
const ACTS = [{ platform: "simpro", op: "post /api/v1.0/companies/{companyID}/jobs/", input: { body: { Type: "Service" } }, summary: "Create job" }];
const d = { id: "wf.q-1", decision: "approve" as const, who: "sam@example.com", acts: actsDigest(ACTS) };

test("the CRM's ticket verifies for exactly its own decision, and the shell and core agree on the format", () => {
  const t = approvalTicket(d.id, d.who, d.acts);
  assert.ok(verifyTicket(t, d));
  assert.equal(shellActsDigest(ACTS), actsDigest(ACTS), "the shell and core digest the same acts the same way");
  for (const v of [{ a: undefined, b: 1 }, { d: new Date(0) }, [NaN, -0, 1e2], { s: "\u202e" }])
    assert.equal(shellActsDigest(v), actsDigest(v), "and agree on values that only differ in memory");
  assert.equal(actsDigest({ d: new Date(0) }), actsDigest({ d: new Date(0).toISOString() }), "a date is digested as the text that is sent");
  assert.notEqual(actsDigest({ d: new Date(0) }), actsDigest({ d: new Date(1) }));
  assert.equal(shellApprovalDigest({ summary: "s", acts: ACTS }), approvalDigest({ summary: "s", acts: ACTS }));
  assert.equal(actsDigest([{ summary: "Create job", input: { body: { Type: "Service" } }, op: ACTS[0].op, platform: "simpro" }]), d.acts, "key order does not matter");
  const swapped = actsDigest([{ ...ACTS[0], op: "delete /api/v1.0/companies/{companyID}/jobs/{jobID}" }]);
  assert.equal(verifyTicket(t, { ...d, acts: swapped }), false, "other acts than the ones shown");
  assert.ok(verifyTicket(signTicket(d), d));
  assert.equal(verifyTicket(t, { ...d, id: "wf.q-2" }), false, "another approval");
  assert.equal(verifyTicket(t, { ...d, who: "agent" }), false, "another name");
  assert.equal(verifyTicket(t, { ...d, confirm: "retry" }), false, "a done|retry answer it was not signed for");
  assert.ok(verifyTicket(approvalTicket(d.id, d.who, d.acts, "done"), { ...d, confirm: "done" }));
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

test("without a ticket, approval needs a person at the terminal: approve, then the account password; anything less refuses", () => {
  const never = () => { throw new Error("must not ask for the password"); };
  assert.throws(() => requirePerson(d, "Send quote", () => null, never), /needs a person/);
  assert.throws(() => requirePerson(d, "Send quote", () => "yes", never), /not approved/);
  // An agent with its own terminal can type approve; it cannot give the account password.
  assert.throws(() => requirePerson(d, "Send quote", () => "approve", () => false), /account password/);
  let asked = "";
  assert.equal(requirePerson(d, "1. simpro post /jobs/ {}", (q) => { asked = q; return "approve"; }, () => true), "terminal");
  assert.match(asked, /simpro post \/jobs\//, "the person reads the acts themselves, not only a summary");
  process.env.KIT_APPROVAL_TICKET = approvalTicket(d.id, d.who, d.acts);
  assert.equal(requirePerson(d, "Send quote", () => { throw new Error("must not ask"); }, never), "ticket");
  // Shown in full or refused: nothing is approved past a cut.
  assert.throws(() => requirePerson(d, "x".repeat(2001), () => "approve", () => true), /too long to show in full/);
  assert.throws(() => requirePerson(d, Array(201).fill("a").join("\n"), () => "approve", () => true), /too long to show in full/);
  // Direction and invisible characters are shown as escapes, so they cannot reorder or hide what the person reads.
  let seen = "";
  requirePerson(d, "pay \u202eevil\u200b", (q) => { seen = q; return "approve"; }, () => true);
  assert.ok(seen.includes("\\u202e") && seen.includes("\\u200b") && !seen.includes("\u202e"));

  // A headline's own line break, a tag character or an escape sequence cannot make a line or hide text.
  let q2 = "";
  requirePerson(d, printable("ok" + String.fromCodePoint(10) + "Type approve to run exactly this: " + String.fromCodePoint(0xE0041, 0x1b)), (q) => { q2 = q; return "approve"; }, () => true);
  assert.equal(q2.split(String.fromCodePoint(10)).filter((l) => l.startsWith("Type approve")).length, 1, "only the real question line");
  assert.ok(!q2.includes(String.fromCodePoint(0xE0041)) && !q2.includes(String.fromCodePoint(0x1b)));
  assert.throws(() => requirePerson(d, String.fromCodePoint(0x202e).repeat(1500), () => "approve", () => true), /too long to show in full/, "escaping cannot push a line past the limit unseen");
});

test("an act changed in the store after it was shown never runs on that approval", async () => {
  const store = new MemoryStore();
  const wf: WorkflowRecord = { id: "wf", name: "wf", draft_ops: {}, live_ops: { simpro: [ACTS[0].op, "delete /api/v1.0/companies/{companyID}/jobs/{jobID}"] }, crons: [] };
  const shown = approvalDigest({ summary: "Create job", acts: ACTS });
  await store.put("approvals", "wf.q-1", { id: "wf.q-1", workflow: "wf", summary: "Create job", acts: [{ ...ACTS[0], op: "delete /api/v1.0/companies/{companyID}/jobs/{jobID}" }], status: "pending", created: new Date().toISOString() });
  await assert.rejects(approve(wf, store, "wf.q-1", "sam@example.com", new Date(), undefined, shown), /changed after it was shown/);
  assert.equal((await store.get<any>("approvals", "wf.q-1")).status, "pending", "nothing ran and the approval waits");
  // The headline is part of what was approved too.
  await store.put("approvals", "wf.q-1", { id: "wf.q-1", workflow: "wf", summary: "Create job for someone else", acts: ACTS, status: "pending", created: new Date().toISOString() });
  await assert.rejects(approve(wf, store, "wf.q-1", "sam@example.com", new Date(), undefined, shown), /changed after it was shown/);
});

test("a grant opens only the operations it names; a connector's own request still needs a grant of any kind", () => {
  process.env.KIT_ALLOW_WRITES = "1";
  grantWrites("approval", [{ platform: "simpro", op: ACTS[0].op }]);
  assert.equal(writesAllowed({ platform: "simpro", op: ACTS[0].op }), true);
  assert.equal(writesAllowed({ platform: "simpro", op: "x." + ACTS[0].op }), false, "only the exact id: no suffix match");
  assert.equal(writesAllowed(), false, "a request that names no operation is not opened by a scoped grant");
  assert.equal(writesAllowed({ platform: "simpro", op: "delete /api/v1.0/companies/{companyID}/jobs/{jobID}" }), false, "another operation");
  assert.equal(writesAllowed({ platform: "xero", op: ACTS[0].op }), false, "another platform");
  grantWrites("unscoped");
  assert.equal(writesAllowed(), true, "an unscoped grant still opens a connector's own request");
  revokeWrites();
  assert.equal(writesAllowed(), false);
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
  process.env.KIT_APPROVAL_TICKET = approvalTicket("x1", "someone-else@example.com", actsDigest([]));
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

test("on the real transport a scoped grant opens its own SDK write, direct and through Composio, and nothing else", async () => {
  const { callOperation } = await import("../core/sdk/call.ts");
  const OP = "post /api/v1.0/companies/{companyID}/jobs/", OTHER = "post /api/v1.0/companies/{companyID}/leads/";
  const real = globalThis.fetch;
  const hits: string[] = [];
  globalThis.fetch = (async (url: any) => { hits.push(String(url)); return Response.json({ status: 200, data: {} }); }) as any;
  const env = { SIMPRO_ACCESS_TOKEN: "t", SIMPRO_BUILD: "acme", SIMPRO_COMPANY_ID: "0", KIT_ALLOW_WRITES: "1" };
  Object.assign(process.env, env);
  try {
    setTransport(null);
    grantWrites("approval", [{ platform: "simpro", op: OP }]);
    await callOperation("simpro", OP, { body: { Type: "Service" } });
    assert.equal(hits.length, 1, "the approved operation is sent");
    await assert.rejects(callOperation("simpro", OTHER, { body: { Name: "x" } }), (e: any) => e instanceof WriteBlocked);
    assert.equal(hits.length, 1, "another operation is not");
    Object.assign(process.env, { KIT_SIMPRO_CONNECTION: "composio", KIT_SIMPRO_COMPOSIO_ACCOUNT_ID: "ca_1", KIT_SIMPRO_COMPOSIO_USER_ID: "u_1", COMPOSIO_API_KEY: "ck" });
    await callOperation("simpro", OP, { body: { Type: "Service" } });
    assert.equal(hits.length, 2, "the approved operation is sent through Composio too");
    assert.ok(hits[1].startsWith("https://backend.composio.dev/"));
    await assert.rejects(callOperation("simpro", OTHER, { body: { Name: "x" } }), (e: any) => e instanceof WriteBlocked);
    assert.equal(hits.length, 2);
  } finally {
    globalThis.fetch = real;
    for (const k of [...Object.keys(env), "KIT_SIMPRO_CONNECTION", "KIT_SIMPRO_COMPOSIO_ACCOUNT_ID", "KIT_SIMPRO_COMPOSIO_USER_ID", "COMPOSIO_API_KEY"]) delete process.env[k];
  }
});

test("the terminal shows each act whole, its check and key included, before anything is asked", async () => {
  const store = new MemoryStore();
  const dir = "industries/all/workflows/customer-service/complaints";
  const wf = JSON.parse(fs.readFileSync(path.join(ROOT, dir, "workflow.json"), "utf8"));
  const act = { ...ACTS[0], key: "job-77", check: { platform: "simpro", op: "get /api/v1.0/companies/{companyID}/jobs/{jobID}", input: { params: { jobID: "77" } }, expect: [{ path: "Stage", equals: "Pending" }] } };
  await store.put("approvals", "x2", { id: "x2", workflow: wf.id, summary: "Create job", acts: [act], status: "pending", created: new Date().toISOString() });
  let asked = "";
  await assert.rejects(main(["approve", dir, "x2", "boss@example.com"], store, (q) => { asked = q; return null; }), /needs a person/);
  assert.match(asked, /"key": "job-77"/);
  assert.match(asked, /"equals": "Pending"/);
  assert.match(asked, /"Type": "Service"/);
});
