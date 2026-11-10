// Data-sync workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport, WriteBlocked } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, approvalId, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { contacts, newCompanies, bills, CRONS } from "../industries/all/workflows/finance-admin/data-sync/index.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/all/workflows/finance-admin/data-sync/workflow.json", "utf8")) as WorkflowRecord;
const C1 = "11111111-2222-4333-8444-555555555555", C2 = "66666666-7777-4888-8999-000000000000";
const NEWC = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const BILL1 = "12345678-1234-4234-8234-123456789012", BILL2 = "87654321-4321-4321-8321-210987654321";
const NOW = new Date("2026-11-08T00:00:00Z");

type Hit = { method: string; path: string; body: any; headers: Record<string, string> };
let hits: Hit[] = [];
let contactRows: any[] = [];                 // Xero contacts returned by the changed-since read
let matchesByName: Record<string, any[]> = {}; // Xero contacts returned by a name search
let billRows: any[] = [];                    // Xero draft supplier bills
let companyRows: any[] = [];                 // HubSpot companies with no Xero contact

function fake() {
  hits = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      const headers: Record<string, string> = Object.fromEntries(new Headers(init?.headers ?? {}).entries());
      hits.push({ method: m, path: p, body, headers });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (/token$/.test(p)) return json({ access_token: "tok", refresh_token: "r2", expires_in: 1800 });
      if (p.endsWith("/connections")) return json([{ tenantId: "t" }]);
      // Xero
      if (p.endsWith("/Contacts") && m === "GET") {
        const term = u.searchParams.get("searchTerm");
        if (term) return json({ Contacts: matchesByName[term] ?? [] });
        return json({ Contacts: u.searchParams.get("page") === "1" ? contactRows : [] });
      }
      if (p.endsWith("/Contacts") && m === "PUT") return json({ Contacts: [{ ContactID: NEWC }] });
      if (p.endsWith("/Invoices") && m === "GET") return json({ Invoices: u.searchParams.get("page") === "1" ? billRows : [] });
      if (/\/Invoices\/[^/]+$/.test(p) && m === "POST") return json({ Invoices: [{ InvoiceID: p.split("/").pop(), Status: "AUTHORISED" }] });
      // HubSpot
      if (p.endsWith("/crm/v3/objects/companies/search")) return json({ results: companyRows });
      if (p.endsWith("/crm/v3/objects/companies/batch/upsert")) return json({ status: "COMPLETE", results: (body?.inputs ?? []).map((i: any) => ({ id: i.id })) });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const writes = () => hits.filter((h) => h.method !== "GET");
const upserts = () => hits.filter((h) => h.path.endsWith("/batch/upsert"));
const sends = () => hits.filter((h) => /\/Email$|\/send$/.test(h.path));
const S: any = { business_name: "Test Builders", hubspot: { idProperty: "xero_contact_id" }, sync_bills: true };

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  contactRows = []; matchesByName = {}; billRows = []; companyRows = [];
  Object.assign(process.env, { HUBSPOT_ACCESS_TOKEN: "hs", XERO_CLIENT_ID: "x", XERO_CLIENT_SECRET: "y", XERO_TENANT_ID: "t", XERO_REFRESH_TOKEN: "r1", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a cron cannot draft a live operation and cannot queue a draft one", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "xero", op: "accounting.updateInvoice", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "xero", op: "accounting.createContacts", summary: "x" }), /not a live operation/);
});

test("the cron entries match workflow.json", () => {
  assert.deepEqual(Object.keys(CRONS).sort(), WF.crons.map((c) => c.entry).sort());
});

test("contacts: mirrors Xero contacts into HubSpot by Xero id, skips a bad id, sends nothing", async () => {
  contactRows = [{ ContactID: C1, Name: "Harbour Builders" }, { ContactID: "not-a-guid", Name: "Bad" }, { ContactID: C2, Name: "Ridge Civil" }];
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await contacts(ctx), { mirrored: 2 });
  assert.equal(upserts().length, 1);
  assert.deepEqual(upserts()[0].body.inputs.map((i: any) => [i.id, i.idProperty, i.properties.name, i.properties.xero_contact_id]),
    [[C1, "xero_contact_id", "Harbour Builders", C1], [C2, "xero_contact_id", "Ridge Civil", C2]]);
  assert.equal(sends().length, 0, "nothing sent");
  assert.equal(hits.find((h) => h.method === "GET" && h.path.endsWith("/Contacts"))!.headers["if-modified-since"], undefined, "first run reads everything");
  await contacts(ctx);
  const again = hits.filter((h) => h.method === "GET" && h.path.endsWith("/Contacts")).at(-1)!;
  assert.match(again.headers["if-modified-since"] ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/, "later runs read only what changed");
  assert.ok(await store.get("links", C1));
});

test("contacts: a blocked write stops at the SDK gate and nothing reaches HubSpot", async () => {
  process.env.KIT_ALLOW_WRITES = "0";
  contactRows = [{ ContactID: C1, Name: "Harbour Builders" }];
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(contacts(ctx), WriteBlocked);
  assert.equal(upserts().length, 0);
});

test("new companies: reuse one exact match, create the rest, leave a conflict alone, link back to HubSpot", async () => {
  companyRows = [
    { id: "1001", properties: { name: "Harbour Builders" } },
    { id: "1002", properties: { name: "Dune Plant Hire" } },
    { id: "1003", properties: { name: "New Co Pty" } },
    { id: "BAD", properties: { name: "Ignored" } },
  ];
  matchesByName = {
    "Harbour Builders": [{ ContactID: C1, Name: "Harbour Builders" }],
    "Dune Plant Hire": [{ ContactID: C1, Name: "Dune Plant Hire" }, { ContactID: C2, Name: "Dune Plant Hire" }],
  };
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  assert.deepEqual(await newCompanies(ctx), { linked: 2, skipped: 1 });
  const creates = hits.filter((h) => h.method === "PUT" && h.path.endsWith("/Contacts"));
  assert.equal(creates.length, 1, "only the company with no match gets a Xero contact");
  assert.equal(creates[0].body.Contacts[0].Name, "New Co Pty");
  assert.equal(creates[0].headers["idempotency-key"], "company:1003");
  const linked = upserts().flatMap((h) => h.body.inputs);
  assert.deepEqual(linked.map((i: any) => [i.id, i.properties.xero_contact_id]), [["1001", C1], ["1003", NEWC]]);
  assert.equal(sends().length, 0, "nothing sent");
});

test("bills: each draft bill is queued once for a person, and authorising one runs only on approval", async () => {
  billRows = [
    { InvoiceID: BILL1, InvoiceNumber: "INV-884", Contact: { Name: "Steel Co" }, Total: 1320.5 },
    { InvoiceID: BILL2, InvoiceNumber: "INV-885", Contact: { Name: "Fuel Depot" }, Total: 88 },
  ];
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await bills(ctx), { queued: 2 });
  assert.equal(writes().filter((h) => /\/Invoices\//.test(h.path)).length, 0, "no bill changed before approval");
  await bills(ctx);
  const queued = Object.values(await store.list<Approval>("approvals"));
  assert.equal(queued.length, 2, "a re-run never queues the same bill twice");
  assert.ok(queued.every((a) => a.status === "pending"));
  const ap = await approve(WF, store, approvalId(WF.id, `bill:${BILL1}`), "owner", NOW);
  assert.equal(ap.status, "done");
  const authorised = hits.find((h) => h.method === "POST" && h.path.endsWith(`/Invoices/${BILL1}`))!;
  assert.equal(authorised.body.Invoices[0].Status, "AUTHORISED");
  assert.equal(sends().length, 0, "nothing sent");
});

test("bills: off unless sync_bills is set", async () => {
  billRows = [{ InvoiceID: BILL1, InvoiceNumber: "INV-884", Contact: { Name: "Steel Co" }, Total: 10 }];
  const store = new MemoryStore(), ctx = context(WF, { ...S, sync_bills: false }, store, NOW, () => {});
  assert.deepEqual(await bills(ctx), { skipped: "sync_bills is off" });
  assert.equal(Object.keys(await store.list("approvals")).length, 0);
});
