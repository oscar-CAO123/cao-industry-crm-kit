// Missing documents finder tests. Every request goes to a fake network: no test reaches a real Xero organisation or mailbox.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { scan, chase, CRONS } from "../industries/professional-services/workflows/finance-admin/add-missingdocs/index.ts";
import { sinceFilter } from "../industries/professional-services/workflows/finance-admin/add-missingdocs/adapters/xero.ts";

const DIR = "industries/professional-services/workflows/finance-admin/add-missingdocs";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const SETTINGS: any = { business_name: "Test Bookkeeping", messages: "microsoft-365", microsoft_365: { mailbox: "accounts@example.com.au" }, client_email: "accounts@acme.example.com", lookback_days: 90, chase_after_days: [7, 14] };
const NOW = new Date("2026-11-09T00:00:00Z");
const C1 = "11111111-2222-4333-8444-555555555555";   // Acme, has an email
const C2 = "66666666-7777-4888-8999-aaaaaaaaaaaa";   // No Email Co, no email
const T1 = "aaaaaaaa-bbbb-4ccc-8ddd-000000000001", T2 = "aaaaaaaa-bbbb-4ccc-8ddd-000000000002", T3 = "aaaaaaaa-bbbb-4ccc-8ddd-000000000003";
const B1 = "bbbbbbbb-bbbb-4ccc-8ddd-000000000001", B2 = "bbbbbbbb-bbbb-4ccc-8ddd-000000000002";

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let t1Attached = false, mailN = 0, bankFlood = false;

function fake() {
  hits = []; t1Attached = false; mailN = 0; bankFlood = false;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (/token$/.test(p)) return json({ access_token: "tok", refresh_token: "r2", expires_in: 1800 });
      if (p.endsWith("/connections")) return json([{ tenantId: "t" }]);
      // Xero accounting
      if (p.endsWith("/BankTransactions") && bankFlood) return json({ BankTransactions: Array.from({ length: 100 }, (_, i) => ({
        BankTransactionID: `cccccccc-0000-4000-8000-${String(i).padStart(12, "0")}`, Type: "SPEND", Status: "AUTHORISED", HasAttachments: true, Date: "2026-10-20T00:00:00", Total: 1 })) });
      if (p.endsWith("/BankTransactions")) return json({ BankTransactions: [
        { BankTransactionID: T1, Type: "SPEND", Status: "AUTHORISED", HasAttachments: t1Attached, Date: "2026-10-20T00:00:00", Total: 55.5, Reference: "Officeworks", Contact: { ContactID: C1, Name: "Acme Pty Ltd" }, LineItems: [{ Description: "Printer paper" }] },
        { BankTransactionID: T2, Type: "RECEIVE", Status: "AUTHORISED", HasAttachments: true, Date: "2026-10-21T00:00:00", Total: 900, Contact: { ContactID: C1, Name: "Acme Pty Ltd" } },
        { BankTransactionID: T3, Type: "SPEND-TRANSFER", Status: "AUTHORISED", HasAttachments: false, Date: "2026-10-22T00:00:00", Total: 100, Contact: { ContactID: C1, Name: "Acme Pty Ltd" } },
      ] });
      if (p.endsWith("/Invoices")) return json({ Invoices: [
        { InvoiceID: B1, Type: "ACCPAY", Status: "AUTHORISED", HasAttachments: false, Date: "2026-10-25T00:00:00", Total: 300, InvoiceNumber: "INV-9", Contact: { ContactID: C1, Name: "Acme Pty Ltd" } },
        { InvoiceID: B2, Type: "ACCPAY", Status: "AUTHORISED", HasAttachments: false, Date: "2026-10-26T00:00:00", Total: 40, Contact: { ContactID: C2, Name: "No Email Co" } },
      ] });
      if (p.endsWith("/Contacts")) return json({ Contacts: [
        { ContactID: C1, Name: "Acme Pty Ltd", EmailAddress: "ap@acme.example.com" },
        { ContactID: C2, Name: "No Email Co", EmailAddress: "" },
      ] });
      // Microsoft Graph (Outlook drafts and approved sends)
      if (/\/messages\/[^/]+\/send$/.test(p)) return new Response(null, { status: 202 });
      if (p.endsWith("/messages") && m === "POST") { mailN++; return json({ id: `AAMkDraft${mailN}` }); }
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const xeroWrites = () => hits.filter((h) => h.method !== "GET" && /BankTransactions|Invoices|Contacts/.test(h.path));
const drafts = () => hits.filter((h) => h.method === "POST" && h.path.endsWith("/messages"));
const sends = () => hits.filter((h) => /\/send$/.test(h.path));
const ctxFor = (store: MemoryStore, now = NOW, settings: any = SETTINGS) => context(WF, settings, store, now, () => {});

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { M365_ACCESS_TOKEN: "ms", XERO_CLIENT_ID: "x", XERO_CLIENT_SECRET: "y", XERO_TENANT_ID: "t", XERO_REFRESH_TOKEN: "r1", KIT_ALLOW_WRITES: "1" });
});

test("cron entries match the crons the workflow declares", () => {
  assert.deepEqual(Object.keys(CRONS).sort(), WF.crons.map((c) => c.entry).sort());
});

test("runtime: a cron cannot run a live operation as a draft, or queue a draft one", async () => {
  const ctx = ctxFor(new MemoryStore());
  await assert.rejects(ctx.draft({ platform: "microsoft-365", op: "users.user.messages.message.send", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "microsoft-365", op: "users.CreateMessages", summary: "x" }), /not a live operation/);
});

test("scan lists only unattached bank transactions and bills, with each client's email, and writes nothing to Xero", async () => {
  const store = new MemoryStore();
  assert.deepEqual(await scan(ctxFor(store)), { missing: 3, cleared: 0 });
  const rows = Object.values(await store.list<any>("missing"));
  assert.deepEqual(rows.map((r) => r.xero_id).sort(), [B1, B2, T1].sort(), "T2 has an attachment, T3 is a transfer");
  assert.equal(rows.find((r) => r.xero_id === B2).email, undefined, "an item whose contact has no email is still listed");
  assert.equal(xeroWrites().length, 0, "scan only reads");
  assert.equal(sends().length, 0);
});

test("the lookback window is a validated date filter, and a bad lookback is refused", async () => {
  assert.match(sinceFilter(90, NOW, `Status=="AUTHORISED"`), /Date>=DateTime\(2026,08,11\)/);
  await assert.rejects(scan(ctxFor(new MemoryStore(), NOW, { ...SETTINGS, lookback_days: 0 })), /lookback_days/);
  await assert.rejects(scan(ctxFor(new MemoryStore(), NOW, { ...SETTINGS, lookback_days: 400 })), /lookback_days/);
});

test("chase drafts one email to the client's own address, queues it for approval, and never sends", async () => {
  const store = new MemoryStore(), ctx = ctxFor(store);
  await scan(ctx);
  assert.deepEqual(await chase(ctx), { queued: 1 }, "one chase for the whole client");
  assert.equal(drafts().length, 1, "one Outlook draft");
  assert.equal(drafts()[0].body.toRecipients[0].emailAddress.address, "accounts@acme.example.com", "to the client, not a Xero contact");
  assert.equal(sends().length, 0, "nothing sent by a cron");
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  assert.equal(ap.status, "pending");
  assert.deepEqual(ap.acts.map((a) => a.op), ["users.user.messages.message.send"]);
  assert.match(ap.summary, /accounts@acme\.example\.com: 3 item\(s\) with no document, \$395\.50/);
});

test("chase refuses to run without the client's own address, and never falls back to a Xero contact", async () => {
  const store = new MemoryStore();
  const { client_email, ...noClient } = SETTINGS;
  await scan(ctxFor(store));
  await assert.rejects(chase(ctxFor(store, NOW, noClient)), /client_email is not set/);
  await assert.rejects(chase(ctxFor(store, NOW, { ...SETTINGS, client_email: "ap@acme.example.com; x" })), /client_email is not set/);
  assert.equal(drafts().length, 0, "no draft, so no email to a supplier or customer");
});

test("a scan that hits the page cap refuses, so nothing is cleared from a partial list", async () => {
  const store = new MemoryStore();
  await scan(ctxFor(store));
  bankFlood = true;
  await assert.rejects(scan(ctxFor(store)), /scan refused/);
  const rows = Object.values(await store.list<any>("missing"));
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.status === "missing"), "nothing cleared from the partial read");
});

test("re-runs never queue or draft the same chase twice", async () => {
  const store = new MemoryStore(), ctx = ctxFor(store);
  await scan(ctx); await chase(ctx);
  assert.deepEqual(await chase(ctx), { queued: 0 });
  await scan(ctx);
  assert.deepEqual(await chase(ctx), { queued: 0 });
  assert.equal(drafts().length, 1);
  assert.equal(Object.keys(await store.list<Approval>("approvals")).length, 1);
});

test("an approved chase sends once, then reminders come on the set days and then stop", async () => {
  const store = new MemoryStore();
  await scan(ctxFor(store)); await chase(ctxFor(store));
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  assert.equal((await approve(WF, store, ap.id, "owner", NOW)).status, "done");
  assert.equal(sends().length, 1, "sent once, on approval");
  await assert.rejects(approve(WF, store, ap.id, "owner", NOW), /already done/);

  const at = (d: number) => new Date(NOW.getTime() + d * 864e5);
  await scan(ctxFor(store, at(6)));
  assert.deepEqual(await chase(ctxFor(store, at(6))), { queued: 0 }, "day 6: too early");
  await scan(ctxFor(store, at(7)));
  assert.deepEqual(await chase(ctxFor(store, at(7))), { queued: 1 }, "day 7: reminder 2");
  await scan(ctxFor(store, at(8)));
  assert.deepEqual(await chase(ctxFor(store, at(8))), { queued: 0 });
  await scan(ctxFor(store, at(21)));
  assert.deepEqual(await chase(ctxFor(store, at(21))), { queued: 1 }, "day 21: reminder 3");
  await scan(ctxFor(store, at(40)));
  assert.deepEqual(await chase(ctxFor(store, at(40))), { queued: 0 }, "no reminder after the last one");
  assert.equal(sends().length, 1, "still only the approved send");
});

test("an item that gets its document drops off the list and is no longer chased", async () => {
  const store = new MemoryStore(), ctx = ctxFor(store);
  await scan(ctx);
  t1Attached = true;
  assert.deepEqual(await scan(ctx), { missing: 2, cleared: 1 });
  const cleared = Object.values(await store.list<any>("missing")).find((r) => r.xero_id === T1);
  assert.equal(cleared.status, "cleared");
  assert.deepEqual(await chase(ctx), { queued: 1 });
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  assert.match(ap.summary, /2 item\(s\)/, "the cleared transaction is left off; the two bills are still chased");
});
