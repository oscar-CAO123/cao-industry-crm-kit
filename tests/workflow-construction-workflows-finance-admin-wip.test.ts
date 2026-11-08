// WIP and retention workflow tests. Every request goes to a fake network: no test reaches a real Xero account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { wipSnapshot, progressClaim, chase } from "../industries/construction/workflows/finance-admin/wip/index.ts";
import type { Settings, Job } from "../industries/construction/workflows/finance-admin/wip/types.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/construction/workflows/finance-admin/wip/workflow.json", "utf8")) as WorkflowRecord;
const CONTACT = "11111111-2222-4333-8444-555555555555";
const NOW = new Date("2026-11-09T22:00:00Z");
const DAY = 864e5;
const iso = (d: Date) => d.toISOString().slice(0, 10);

type Hit = { method: string; path: string; body: any };
type Inv = { InvoiceID: string; Type: string; Status: string; SubTotal: number; AmountDue: number; DueDate: string; InvoiceNumber: string; Contact: { ContactID: string } };
let hits: Hit[] = [];
let invoices: Inv[] = [];
let created = 0;

/** Read a query parameter whether the client sends repeated keys or one comma list. */
const multi = (u: URL, k: string) => u.searchParams.getAll(k).flatMap((s) => s.split(","));

function fake() {
  hits = []; invoices = []; created = 0;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (/token$/.test(p)) return json({ access_token: "tok", refresh_token: "r2", expires_in: 1800 });
      if (p.endsWith("/connections")) return json([{ tenantId: "t" }]);
      if (p.endsWith("/Invoices") && m === "GET") {
        const contacts = multi(u, "ContactIDs"), statuses = multi(u, "Statuses");
        const rows = invoices.filter((i) => (!contacts.length || contacts.includes(i.Contact.ContactID)) && (!statuses.length || statuses.includes(i.Status)));
        return json({ Invoices: rows });
      }
      if (p.endsWith("/Invoices") && m === "PUT") {
        const src = body.Invoices[0];
        const id = `00000000-0000-4000-8000-00000000000${++created}`;
        const sub = src.LineItems.reduce((a: number, l: any) => a + l.Quantity * l.UnitAmount, 0);
        invoices.push({ InvoiceID: id, Type: src.Type, Status: src.Status, SubTotal: sub, AmountDue: sub, DueDate: src.DueDate, InvoiceNumber: `DRAFT-${created}`, Contact: src.Contact });
        return json({ Invoices: [{ InvoiceID: id, Status: src.Status }] });
      }
      const upd = p.match(/\/Invoices\/([0-9a-f-]{36})$/i);
      if (upd && m === "POST") {
        const inv = invoices.find((i) => i.InvoiceID === upd[1]);
        if (inv && body?.Invoices?.[0]?.Status) inv.Status = body.Invoices[0].Status;
        return json({ Invoices: [{ InvoiceID: upd[1], Status: inv?.Status }] });
      }
      if (/\/Invoices\/[0-9a-f-]{36}\/Email$/i.test(p) && m === "POST") return new Response(null, { status: 204 });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const sends = () => hits.filter((h) => h.method === "POST" && /\/Email$/.test(h.path));
const creates = () => hits.filter((h) => h.method === "PUT" && h.path.endsWith("/Invoices"));
const JOB: Job = { id: "J-101", name: "Kitchen extension", contact_id: CONTACT, contract_value: 100000, percent_complete: 40, claim_every_days: 30, retention_percent: 5 };
const S: Settings = { business_name: "Test Builders", gst_rate: 0.1, due_days: 14, chase: { after_days: [7, 21] }, jobs: [JOB] };

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { XERO_CLIENT_ID: "x", XERO_CLIENT_SECRET: "y", XERO_TENANT_ID: "t", XERO_REFRESH_TOKEN: "r1", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a draft cannot authorise or email, and a cron cannot queue a draft operation", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  const id = "00000000-0000-4000-8000-000000000001";
  await assert.rejects(ctx.draft({ platform: "xero", op: "accounting.emailInvoice", input: { params: { InvoiceID: id } }, summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.draft({ platform: "xero", op: "accounting.updateInvoice", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "xero", op: "accounting.createInvoices", summary: "x" }), /not a live operation/);
  assert.equal(hits.length, 0);
});

test("WIP snapshot: billed against earned, reads only, nothing written", async () => {
  invoices = [
    { InvoiceID: "00000000-0000-4000-8000-0000000000a1", Type: "ACCREC", Status: "AUTHORISED", SubTotal: 30000, AmountDue: 30000, DueDate: iso(NOW), InvoiceNumber: "INV-1", Contact: { ContactID: CONTACT } },
    { InvoiceID: "00000000-0000-4000-8000-0000000000a2", Type: "ACCREC", Status: "PAID", SubTotal: 5000, AmountDue: 0, DueDate: iso(NOW), InvoiceNumber: "INV-2", Contact: { ContactID: CONTACT } },
    { InvoiceID: "00000000-0000-4000-8000-0000000000a3", Type: "ACCREC", Status: "DRAFT", SubTotal: 9999, AmountDue: 9999, DueDate: iso(NOW), InvoiceNumber: "INV-3", Contact: { ContactID: CONTACT } },
  ];
  const store = new MemoryStore();
  const out = await wipSnapshot(context(WF, S, store, NOW, () => {})) as any;
  assert.equal(out.jobs, 1);
  const row = out.rows[0];
  assert.deepEqual([row.earned, row.billed, row.over_under, row.invoices], [40000, 35000, -5000, 2], "the DRAFT invoice is not billing");
  assert.deepEqual(await store.get("wip", `${iso(NOW)}:J-101`), row);
  assert.equal(hits.filter((h) => h.method !== "GET" && !/token$/.test(h.path)).length, 0);
});

test("progress claim: a DRAFT invoice and one approval to authorise and email; nothing sent until approved; re-runs never repeat", async () => {
  const store = new MemoryStore();
  const ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await progressClaim(ctx), { drafted: 1 });
  assert.equal(creates().length, 1);
  const body = creates()[0].body.Invoices[0];
  assert.equal(body.Status, "DRAFT");
  assert.equal(body.LineAmountTypes, "Exclusive");
  assert.deepEqual(body.LineItems.map((l: any) => [l.Quantity, l.UnitAmount]), [[1, 40000]]);
  assert.equal(sends().length, 0, "nothing emailed by a cron");
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  assert.deepEqual(ap.acts.map((a) => a.op), ["accounting.updateInvoice", "accounting.emailInvoice"]);
  assert.match(ap.summary, /\$2,000\.00 retention held back/);
  assert.deepEqual(await progressClaim(context(WF, S, store, NOW, () => {})), { drafted: 0 }, "not due again");
  assert.equal(creates().length, 1);
  assert.equal(Object.keys(await store.list("approvals")).length, 1, "re-runs never queue twice");
  const done = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(done.status, "done");
  assert.equal(invoices[0].Status, "AUTHORISED");
  assert.equal(sends().length, 1);
  await assert.rejects(approve(WF, store, ap.id, "owner"), /already done/);
});

test("progress claim a month later bills only the new progress", async () => {
  const store = new MemoryStore();
  await progressClaim(context(WF, S, store, NOW, () => {}));
  const S2: Settings = { ...S, jobs: [{ ...JOB, percent_complete: 70 }] };
  assert.deepEqual(await progressClaim(context(WF, S2, store, new Date(NOW.getTime() + 10 * DAY), () => {})), { drafted: 0 }, "claim interval not passed");
  assert.deepEqual(await progressClaim(context(WF, S2, store, new Date(NOW.getTime() + 31 * DAY), () => {})), { drafted: 1 });
  assert.equal(creates()[1].body.Invoices[0].LineItems[0].UnitAmount, 30000, "70 per cent of 100000 less the 40000 already claimed");
});

test("chase: one reminder per stage, queued for approval and sent only once approved", async () => {
  invoices = [
    { InvoiceID: "00000000-0000-4000-8000-0000000000b1", Type: "ACCREC", Status: "AUTHORISED", SubTotal: 500, AmountDue: 500, DueDate: iso(new Date(NOW.getTime() - 8 * DAY)), InvoiceNumber: "INV-0042", Contact: { ContactID: CONTACT } },
    { InvoiceID: "00000000-0000-4000-8000-0000000000b2", Type: "ACCREC", Status: "AUTHORISED", SubTotal: 800, AmountDue: 800, DueDate: iso(new Date(NOW.getTime() + 3 * DAY)), InvoiceNumber: "INV-0043", Contact: { ContactID: CONTACT } },
  ];
  const store = new MemoryStore();
  assert.deepEqual(await chase(context(WF, S, store, NOW, () => {})), { queued: 1 }, "only the invoice past due");
  assert.equal(sends().length, 0);
  assert.deepEqual(await chase(context(WF, S, store, NOW, () => {})), { queued: 0 }, "same day, no second reminder");
  assert.equal(Object.keys(await store.list("approvals")).length, 1);
  const later = new Date(NOW.getTime() + 14 * DAY);
  assert.deepEqual(await chase(context(WF, S, store, later, () => {})), { queued: 2 }, "INV-0042 reaches its second stage (22 days late); INV-0043 reaches its first (11 days late)");
  const [first] = Object.values(await store.list<Approval>("approvals")).sort((a, b) => a.created.localeCompare(b.created));
  await approve(WF, store, first.id, "owner", later);
  assert.equal(sends().length, 1);
  assert.match(sends()[0].path, /\/Invoices\/00000000-0000-4000-8000-0000000000b1\/Email$/);
});

test("a job with a bad contact id is skipped, never called", async () => {
  const logs: string[] = [];
  const bad: Settings = { ...S, jobs: [{ ...JOB, contact_id: "not-a-guid" }] };
  const store = new MemoryStore();
  assert.deepEqual(await progressClaim(context(WF, bad, store, NOW, (m) => logs.push(m))), { drafted: 0 });
  assert.equal(hits.length, 0);
  assert.ok(logs.some((l) => /skip job: .*ContactID/.test(l)), logs.join(" | "));
});
