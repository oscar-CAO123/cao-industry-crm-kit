// Orders workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { refreshKey } from "../core/connectors/google-workspace/auth.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord } from "../core/workflows/runtime.ts";
import { intake, draft } from "../industries/retail/workflows/finance-admin/orders/index.ts";
import { main } from "../tools/workflow.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FOLDER = "industries/retail/workflows/finance-admin/orders";
const LINES = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kit-orders-")), "lines.json");
const WF = JSON.parse(fs.readFileSync(`${FOLDER}/workflow.json`, "utf8")) as WorkflowRecord;
const MAILBOX = "orders@example.com.au";
const MSG = "18f0a1b2c3d4e5f6", THREAD = "18f0thread01", DRAFT = "r-1234567890";
const CID = "87654321-4321-4321-8321-210987654321", INV = "abcdefab-cdef-4abc-8def-abcdefabcdef";
const ITEMS = [
  { ItemID: "i1", Code: "TEA-GREEN", Name: "Green tea 100g", SalesDetails: { UnitPrice: 12.5 } },
  { ItemID: "i2", Code: "MUG-01", Name: "Ceramic mug", SalesDetails: { UnitPrice: 18 } },
];

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];

function fake() {
  hits = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (/token$/.test(p)) return json({ access_token: "tok", refresh_token: "r2", expires_in: 1800 });
      if (p.endsWith("/connections")) return json([{ tenantId: "t" }]);
      // Gmail
      if (p.endsWith("/messages") && m === "GET") return json({ messages: [{ id: MSG, threadId: THREAD }] });
      if (p.endsWith(`/messages/${MSG}`)) return json({ id: MSG, threadId: THREAD, internalDate: "1762560000000",
        payload: { headers: [{ name: "From", value: "Ari Lee <ari@example.com>" }, { name: "Subject", value: "Order 4412" }] } });
      if (p.endsWith("/drafts") && m === "POST") return json({ id: DRAFT, message: { id: "m-draft", threadId: THREAD } });
      if (p.endsWith("/drafts/send")) return json({ id: "18f0sent0001" });
      // Xero
      if (p.endsWith("/Items")) return json({ Items: ITEMS });
      if (p.endsWith("/Contacts")) return json({ Contacts: m === "GET" ? [] : [{ ContactID: CID }] });
      if (p.endsWith("/Invoices")) return json({ Invoices: [{ InvoiceID: INV, Status: "DRAFT" }] });
      return new Response("not faked: " + m + " " + p, { status: 404 });
    }) as any,
  });
}
const sends = () => hits.filter((h) => h.path.endsWith("/drafts/send"));
const invoices = () => hits.filter((h) => h.path.endsWith("/Invoices") && h.method === "PUT");
const S: any = { business_name: "Test Store", mailbox: MAILBOX, order_search: "label:orders is:unread" };
const NOW = new Date("2026-11-09T00:00:00Z");

beforeEach(async () => {
  fake();
  const tokens = new MemoryTokenStore();
  await tokens.set(refreshKey(MAILBOX), "refresh-1");
  setTokenStore(tokens);
  Object.assign(process.env, { GOOGLE_MAILBOX: MAILBOX, GOOGLE_CLIENT_ID: "gid", GOOGLE_CLIENT_SECRET: "gsecret",
    XERO_CLIENT_ID: "x", XERO_CLIENT_SECRET: "y", XERO_TENANT_ID: "t", XERO_REFRESH_TOKEN: "r1", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a draft cannot run a live operation and a cron cannot queue a draft one", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "google-workspace", op: "gmail.users.drafts.send", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "google-workspace", op: "gmail.users.messages.list", summary: "x" }), /not a live operation/);
  await assert.rejects(ctx.draft({ platform: "xero", op: "accounting.deleteInvoices", summary: "x" }), /not a draft operation/);
});

test("intake reads the order mail once and sends nothing", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await intake(ctx), { added: 1 });
  assert.deepEqual(await intake(ctx), { added: 0 }, "a second run adds nothing");
  const o = await store.get<any>("enquiries", `gmail-${MSG}`);
  assert.equal(o.status, "new");
  assert.equal(o.contact.email, "ari@example.com");
  assert.equal(sends().length, 0);
});

test("an order with no proposal waits; with lines it becomes a DRAFT invoice and a confirmation waiting for approval", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await intake(ctx);
  assert.deepEqual(await draft(ctx), { drafted: 0, needs_lines: 1 });
  fs.writeFileSync(LINES, JSON.stringify([{ code: "TEA-GREEN", qty: 2 }, { code: "MUG-01", qty: 1 }]));
  await main(["propose", FOLDER, `gmail-${MSG}`, LINES], store);
  assert.deepEqual(await draft(ctx), { drafted: 1, needs_lines: 0 });
  const inv = invoices()[0].body.Invoices[0];
  assert.equal(inv.Status, "DRAFT");
  assert.equal(inv.Type, "ACCREC");
  assert.deepEqual(inv.LineItems.map((l: any) => [l.ItemCode, l.Quantity, l.UnitAmount]), [["TEA-GREEN", 2, 12.5], ["MUG-01", 1, 18]]);
  assert.ok(hits.some((h) => h.path.endsWith("/drafts") && h.method === "POST"), "confirmation drafted");
  assert.equal(sends().length, 0, "nothing sent by a cron");
  const pending = await main(["approvals", FOLDER], store) as any[];
  assert.equal(pending.length, 1);
  assert.match(pending[0].summary, /ari@example\.com: 2 lines, \$43\.00 ex GST/);
});

test("re-runs never create or queue twice; approval sends the confirmation once", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await intake(ctx);
  fs.writeFileSync(LINES, JSON.stringify([{ code: "MUG-01", qty: 1 }]));
  await main(["propose", FOLDER, `gmail-${MSG}`, LINES], store);
  await draft(ctx); await intake(ctx); await draft(ctx);
  assert.equal(invoices().length, 1, "one invoice");
  const pending = await main(["approvals", FOLDER], store) as any[];
  assert.equal(pending.length, 1, "one approval");
  const ap = await approve(WF, store, pending[0].id, "owner", NOW);
  assert.equal(ap.status, "done");
  assert.equal(sends().length, 1, "sent once");
  assert.equal(sends()[0].body.id, DRAFT);
  await assert.rejects(approve(WF, store, pending[0].id, "owner"), /already done/);
});

test("a line code not on the Xero item list parks the order instead of inventing a price", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await intake(ctx);
  fs.writeFileSync(LINES, JSON.stringify([{ code: "NOPE-9", qty: 1 }]));
  await main(["propose", FOLDER, `gmail-${MSG}`, LINES], store);
  assert.deepEqual(await draft(ctx), { drafted: 0, needs_lines: 1 });
  assert.equal(invoices().length, 0);
  assert.equal(sends().length, 0);
});
