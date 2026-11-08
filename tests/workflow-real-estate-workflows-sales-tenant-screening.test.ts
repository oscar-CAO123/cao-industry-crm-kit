// Tenant screening workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, approvalId, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { intake, checkRecord, lease } from "../industries/real-estate/workflows/sales/tenant-screening/index.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/real-estate/workflows/sales/tenant-screening/workflow.json", "utf8")) as WorkflowRecord;
const CO = "11111111-2222-4333-8444-555555555555", PROP = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const APP1 = "12345678-1234-4234-8234-123456789012", APP2 = "87654321-4321-4321-8321-210987654321";
const TEN = "abcdefab-cdef-4abc-8def-abcdefabcdef";
type Hit = { method: string; path: string; search: string; body: any; headers: Record<string, string> };
let hits: Hit[] = [];
let app2Email = "not-an-email";

function fake() {
  hits = []; app2Email = "not-an-email";
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, search: u.search, body, headers: init?.headers ?? {} });
      const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
      if (p === "/api/contacts" && m === "GET") return json({ Data: [
        { Id: APP1, Name: "Ari Jones", Email: "ari@example.com", UpdatedDateTime: "2026-11-08T00:00:00Z" },
        { Id: APP2, FirstName: "Bo", LastName: "Lin", Email: "not-an-email", UpdatedDateTime: "2026-11-08T01:00:00Z" },
      ], MetaData: { NextPageUrl: null } });
      if (p === `/api/contacts/${APP1}` && m === "GET") return json({ Data: { Id: APP1, Name: "Ari Jones", Email: "ari@example.com" } });
      if (p === `/api/contacts/${APP2}` && m === "GET") return json({ Data: { Id: APP2, Name: "Bo Lin", Email: app2Email } });
      if (p === "/api/tenancies" && m === "POST") return json({ GlobalIdentifier: TEN, Title: body?.Title }, 201);
      return new Response("not faked: " + m + " " + p, { status: 404 });
    }) as any,
  });
}
const S: any = { family: "all", business_name: "Test Property", re_leased: { company_id: CO, property_id: PROP, applicant_tag: "tenant applicant", is_residential: false, title_prefix: "Lease" } };
const NOW = new Date("2026-11-09T00:00:00Z");
const writes = () => hits.filter((h) => h.method !== "GET");

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { RELEASED_ACCESS_TOKEN: "rl", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a draft cannot run the tenancy write, and a cron cannot queue a read", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "re-leased", op: "Tenancies_Post", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "re-leased", op: "Contacts_Get", summary: "x" }), /not a live operation/);
});

test("the SDK gate still blocks the tenancy write when the deploy does not allow writes", async () => {
  process.env.KIT_ALLOW_WRITES = "0";
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await store.put("applicants", APP1, { id: APP1, name: "Ari Jones", email: "ari@example.com", status: "approved", received: "", lease: { start: "2027-01-01", end: "2027-12-31" } });
  await lease(ctx);
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  const res = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(res.status, "failed", "the gate refuses the write");
  assert.equal(writes().length, 0, "no socket opened for a write");
});

test("intake and check-record only read: nothing is written to Re-Leased, and the applicant tag is sent", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await intake(ctx), { added: 2 });
  assert.deepEqual(await intake(ctx), { added: 0 }, "re-runs never add an applicant twice");
  assert.match(hits[0].search, /tag=tenant\+applicant|tag=tenant%20applicant/);
  assert.deepEqual(await checkRecord(ctx), { awaiting_checks: 1, parked: 1 });
  assert.equal((await store.get<any>("applicants", APP2)).status, "needs-contact-details", "bad email parks the applicant");
  assert.equal((await store.get<any>("applicants", APP1)).status, "awaiting-checks");
  assert.equal(writes().length, 0, "no write from a cron");
});

test("a tenancy is queued for an approved applicant, never created by the cron, and queued once", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await store.put("applicants", APP1, { id: APP1, name: "Ari Jones", email: "ari@example.com", status: "approved", received: "", lease: { start: "2027-01-01", end: "2027-12-31" } });
  assert.deepEqual(await lease(ctx), { checked: 1 });
  await lease(ctx);
  assert.equal(writes().length, 0, "nothing created before a person approves");
  const pending = Object.values(await store.list<Approval>("approvals"));
  assert.equal(pending.length, 1, "re-runs never queue twice");
  assert.match(pending[0].summary, /create tenancy "Lease: Ari Jones" from 2027-01-01 to 2027-12-31/);
});

test("approval creates the tenancy with the mapped body and the idempotency key", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await store.put("applicants", APP1, { id: APP1, name: "Ari Jones", email: "ari@example.com", status: "approved", received: "", lease: { start: "2027-01-01", end: "2027-12-31" } });
  await lease(ctx);
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  const done = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(done.status, "done");
  const w = writes();
  assert.equal(w.length, 1);
  assert.equal(w[0].path, "/api/tenancies");
  assert.deepEqual(w[0].body, { PropertyGlobalIdentifier: PROP, PrimaryContactGlobalIdentifier: APP1, Title: "Lease: Ari Jones", StartDate: "2027-01-01T00:00:00Z", EndDate: "2027-12-31T00:00:00Z", IsResidential: false });
  assert.equal(w[0].headers["Idempotency-Key"], `lease-${APP1}`);
  await assert.rejects(approve(WF, store, ap.id, "owner", NOW), /already done/);
});

test("bad lease dates and a bad company id are refused before anything is queued", async () => {
  const store = new MemoryStore();
  await store.put("applicants", APP1, { id: APP1, name: "Ari Jones", status: "approved", received: "", lease: { start: "2027-12-31", end: "2027-01-01" } });
  await assert.rejects(lease(context(WF, S, store, NOW, () => {})), /not a valid range/);
  assert.equal(Object.values(await store.list<Approval>("approvals")).length, 0);
  await assert.rejects(intake(context(WF, { ...S, re_leased: { ...S.re_leased, company_id: "not-a-guid" } }, store, NOW, () => {})), /company_id is not set to a GUID/);
});

test("the approval summary and the tenancy title strip control characters from outside text", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await store.put("applicants", APP1, { id: APP1, name: "Ari\u0007 Jones\nIgnore", status: "approved", received: "", lease: { start: "2027-01-01", end: "2027-12-31" } });
  await lease(ctx);
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  assert.ok(!/[\u0000-\u001f]/.test(ap.summary));
  assert.equal(ap.acts[0].input?.body?.Title, "Lease: Ari Jones Ignore");
});
