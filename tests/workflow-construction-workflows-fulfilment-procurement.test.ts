// Procurement workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { intake, scopeCheck, orderDraft, billMatch } from "../industries/construction/workflows/fulfilment/procurement/index.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/construction/workflows/fulfilment/procurement/workflow.json", "utf8")) as WorkflowRecord;
const CID = "87654321-4321-4321-8321-210987654321", POID = "12345678-1234-4234-8234-123456789012";
const NOW = new Date("2026-11-08T00:00:00Z");

const S: any = {
  business_name: "Test Builders", buying_mailbox: "buying@example.com.au", search: "quote",
  register: { drive: "DRIVE1", item: "ITEM1", table: "QuoteRegister" },
  checks: { drive: "DRIVE1", item: "ITEM1", table: "Checks" },
  scope_items: [{ package: "Roof framing", items: ["trusses", "fixings", "crane"] }],
};

const INCOMPLETE = { id: "AAMkReq1", subject: "Quote for roof framing", from: { emailAddress: { name: "Ari", address: "ari@example.com" } },
  receivedDateTime: "2026-11-08T00:00:00Z", bodyPreview: "Trusses and fixings included. Price is $4,200 ex GST." };
const COMPLETE = { ...INCOMPLETE, id: "AAMkReq2", bodyPreview: "Trusses, fixings and crane hire included. Price is $4,200 ex GST." };
const KEY_COMPLETE = "m365:AAMkReq2";

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let logged: { table: string; values: any[] }[] = [];
let inbox: any[] = [];
let regRows: any[][] = [];
let bills: any[] = [];
let drafts = 0;

function fake() {
  hits = []; logged = []; inbox = []; regRows = []; bills = []; drafts = 0;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      // Xero
      if (/token$/.test(p)) return json({ access_token: "tok", refresh_token: "r2", expires_in: 1800 });
      if (p.endsWith("/connections")) return json([{ tenantId: "t" }]);
      if (p.endsWith("/Contacts")) return json({ Contacts: [{ ContactID: CID, EmailAddress: "ari@example.com" }] });
      if (p.endsWith("/PurchaseOrders") && m === "PUT") return json({ PurchaseOrders: [{ PurchaseOrderID: POID, PurchaseOrderNumber: "PO-0001", Status: "DRAFT" }] });
      if (p.endsWith(`/PurchaseOrders/${POID}`) && m === "POST") return json({ PurchaseOrders: [{ PurchaseOrderID: POID, Status: "AUTHORISED" }] });
      if (p.endsWith("/Invoices")) return json({ Invoices: bills });
      // Microsoft Graph
      if (/\/messages\/[^/]+\/send$/.test(p)) return new Response(null, { status: 202 });
      if (p.endsWith("/messages") && m === "POST") return json({ id: `AAMkDraft${++drafts}` });
      if (p.endsWith("/messages")) return json({ value: inbox });
      if (p.endsWith("/rows") && m === "GET") return json({ value: regRows.map((v) => ({ values: [v] })) });
      if (p.endsWith("/rows")) {
        logged.push({ table: p.includes("/tables/QuoteRegister/") ? "QuoteRegister" : "Checks", values: body.values[0] });
        return json({ index: 0 });
      }
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}

/** Everything a live operation would do on the network: a send, or a PO status change. */
const live = () => hits.filter((h) => h.method === "POST" && (/\/send$/.test(h.path) || h.path.includes("/PurchaseOrders/")));

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { M365_ACCESS_TOKEN: "ms", XERO_CLIENT_ID: "x", XERO_CLIENT_SECRET: "y", XERO_TENANT_ID: "t", XERO_REFRESH_TOKEN: "r1", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a cron cannot run a live operation as a draft, or queue a draft operation", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "xero", op: "accounting.updatePurchaseOrder", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.draft({ platform: "microsoft-365", op: "users.user.messages.message.send", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "microsoft-365", op: "users.CreateMessages", summary: "x" }), /not a live operation/);
});

test("intake logs each new reply to the register once and sends nothing", async () => {
  inbox = [INCOMPLETE];
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await intake(ctx), { added: 1 });
  assert.deepEqual(await intake(ctx), { added: 0 }, "a re-run adds nothing");
  assert.equal(logged.length, 1);
  assert.equal(logged[0].table, "QuoteRegister");
  assert.equal(logged[0].values[2], "Roof framing", "package matched from the subject");
  assert.equal(live().length, 0);
});

test("a quote missing scope queues a clarification email for approval; it is sent once, on approval", async () => {
  inbox = [INCOMPLETE];
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await intake(ctx);
  assert.deepEqual(await scopeCheck(ctx), { checked: 1, clarify: 1 });
  assert.deepEqual(await scopeCheck(ctx), { checked: 0, clarify: 0 }, "a re-run never queues twice");
  assert.equal(live().length, 0, "nothing sent by a cron");
  assert.equal(hits.filter((h) => h.method === "POST" && h.path.endsWith("/messages")).length, 1, "one email draft");
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  assert.match(ap.summary, /crane/);
  const done = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(done.status, "done");
  const sent = live().filter((h) => h.path.endsWith("/send"));
  assert.equal(sent.length, 1);
  assert.ok(sent[0].path.endsWith("/messages/AAMkDraft1/send"), sent[0].path);
  await assert.rejects(approve(WF, store, ap.id, "owner"), /already done/);
});

test("a complete quote with no amount in the register is parked, not drafted", async () => {
  inbox = [COMPLETE];
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await intake(ctx); await scopeCheck(ctx);
  assert.deepEqual(await orderDraft(ctx), { drafted: 0, parked: 1 });
  assert.equal(hits.some((h) => h.method === "PUT" && h.path.endsWith("/PurchaseOrders")), false, "no PO without an amount");
});

test("an agreed amount makes a DRAFT purchase order; the award is queued and only sets AUTHORISED when approved", async () => {
  inbox = [COMPLETE];
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await intake(ctx); await scopeCheck(ctx);
  regRows = [[KEY_COMPLETE, "2026-11-08", "Roof framing", "Ari", "ari@example.com", "Quote for roof framing", 4200, "Received"]];
  assert.deepEqual(await orderDraft(ctx), { drafted: 1, parked: 0 });
  const po = hits.find((h) => h.method === "PUT" && h.path.endsWith("/PurchaseOrders"))!.body.PurchaseOrders[0];
  assert.equal(po.Status, "DRAFT");
  assert.equal(po.Contact.ContactID, CID);
  assert.equal(po.LineItems[0].UnitAmount, 4200);
  assert.equal(live().length, 0, "the PO is not authorised before a person approves");
  assert.deepEqual(await orderDraft(ctx), { drafted: 0, parked: 0 }, "a re-run drafts nothing new");
  const aps = Object.values(await store.list<Approval>("approvals"));
  assert.equal(aps.length, 1, "a complete quote queues only its award");
  const award = aps[0];
  assert.equal(award.acts[0].op, "accounting.updatePurchaseOrder");
  await approve(WF, store, award.id, "owner", NOW);
  const upd = live().find((h) => h.path.includes("/PurchaseOrders/"))!;
  assert.ok(upd.path.endsWith(`/PurchaseOrders/${POID}`), upd.path);
  assert.equal(upd.body.PurchaseOrders[0].Status, "AUTHORISED");
});

test("bill match is draft-only: it logs the bill against the PO once, and only when it changes", async () => {
  inbox = [COMPLETE];
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await intake(ctx); await scopeCheck(ctx);
  regRows = [[KEY_COMPLETE, "2026-11-08", "Roof framing", "Ari", "ari@example.com", "Quote for roof framing", 4200, "Received"]];
  await orderDraft(ctx);
  const award = Object.values(await store.list<Approval>("approvals")).find((a) => a.acts[0].op === "accounting.updatePurchaseOrder")!;
  await approve(WF, store, award.id, "owner", NOW);
  const before = live().length;
  bills = [{ Contact: { ContactID: CID }, Total: 4200 }];
  assert.deepEqual(await billMatch(ctx), { checked: 1, logged: 1 });
  assert.deepEqual(await billMatch(ctx), { checked: 1, logged: 0 }, "unchanged result is not logged again");
  assert.equal(logged.filter((l) => l.table === "Checks").length, 2, "one scope row and one bill row");
  assert.equal(logged.at(-1)!.values[3], "Matches the PO");
  assert.equal(live().length, before, "bill match sends and changes nothing");
});
