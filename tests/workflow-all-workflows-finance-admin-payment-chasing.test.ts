// Payment-chasing workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { refresh, draft, summary } from "../industries/all/workflows/finance-admin/payment-chasing/index.ts";
import { parseXeroDate, daysOverdue, stageFor, type Settings, type InvoiceRow } from "../industries/all/workflows/finance-admin/payment-chasing/types.ts";
import { render, TARGETS } from "../tools/deploy.ts";

const DIR = "industries/all/workflows/finance-admin/payment-chasing";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const NOW = new Date("2026-11-08T00:00:00Z");

const A = "aaaa1000-0000-4000-8000-000000000001", B = "bbbb1000-0000-4000-8000-000000000002", C = "cccc1000-0000-4000-8000-000000000003";
const D = "dddd1000-0000-4000-8000-000000000004", E = "eeee1000-0000-4000-8000-000000000005", F = "ffff1000-0000-4000-8000-000000000006";
const C1 = "c1c10000-0000-4000-8000-000000000001", C2 = "c2c20000-0000-4000-8000-000000000002", C3 = "c3c30000-0000-4000-8000-000000000003", C4 = "c4c40000-0000-4000-8000-000000000004";
const PDF = [37, 80, 68, 70], PDF_B64 = Buffer.from(PDF).toString("base64");

const CONTACTS: Record<string, any> = {
  [C1]: { FirstName: "Jo", Name: "Jo Smith", EmailAddress: "jo@example.com" },
  [C2]: { FirstName: "Ari", Name: "<img src=x onerror=1> Ari Lee", EmailAddress: "ari@example.com" },
  [C3]: { FirstName: "Sam", Name: "Sam Pause", EmailAddress: "sam@example.com" },
  [C4]: { FirstName: "Kim", Name: "Kim No Email" },
};
const inv = (id: string, number: string, due: string, amount: number, contact: string) =>
  ({ InvoiceID: id, InvoiceNumber: number, Type: "ACCREC", Status: "AUTHORISED", DueDate: due, AmountDue: amount, Contact: { ContactID: contact, Name: CONTACTS[contact].Name } });
const FIXTURE = () => [
  inv(A, "INV-1001", "2026-10-20T00:00:00", 500, C1),                                  // 19 days: firm step
  inv(B, "INV-1002", `/Date(${Date.parse("2026-09-01T00:00:00Z")}+0000)/`, 1200, C2),  // 68 days: jumps to final
  inv(C, "INV-1003", "2026-10-20T00:00:00", 20, C1),                                   // under the minimum
  inv(D, "INV-1004", "2026-10-01T00:00:00", 300, C3),                                  // client paused
  inv(E, "INV-1005", "2026-11-05T00:00:00", 90, C1),                                   // 3 days: no step yet
  inv(F, "INV-1006", "2026-10-25T00:00:00", 400, C4),                                  // no email on the client
];

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let invoices: any[] = [];
let drafts = 0;
let failPdfFor = new Set<string>();

function fake() {
  hits = []; drafts = 0; failPdfFor = new Set();
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (/token$/.test(p)) return json({ access_token: "tok", refresh_token: "r2", expires_in: 1800 });
      if (p.endsWith("/connections")) return json([{ tenantId: "t" }]);
      if (p.endsWith("/Invoices") && m === "GET") return json({ Invoices: invoices });
      const pdf = /\/Invoices\/([^/]+)\/pdf$/.exec(p);
      if (pdf) return failPdfFor.has(pdf[1]) ? new Response("{}", { status: 500 }) : new Response(new Uint8Array(PDF), { status: 200, headers: { "content-type": "application/pdf" } });
      if (/\/Contacts\/[^/]+$/.test(p) && m === "GET") return json({ Contacts: [CONTACTS[p.split("/").pop()!]] });
      if (/\/Invoices\/[^/]+\/History$/.test(p) && m === "PUT") return json({ HistoryRecords: [{ Details: "ok" }] });
      if (/\/users\/[^/]+\/messages$/.test(p) && m === "POST") return json({ id: `AAMkDraft${++drafts}` });
      if (/\/messages\/[^/]+\/send$/.test(p)) return new Response(null, { status: 202 });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const drafted = () => hits.filter((h) => /\/messages$/.test(h.path) && h.method === "POST");
const sends = () => hits.filter((h) => /\/send$/.test(h.path));
const notes = () => hits.filter((h) => /\/History$/.test(h.path) && h.method === "PUT");

const S: Settings = {
  business_name: "Test Accounts", mailbox: "accounts@example.com", owner_email: "owner@example.com",
  ladder: [{ days_overdue: 7, tone: "friendly" }, { days_overdue: 14, tone: "firm" }, { days_overdue: 30, tone: "final" }],
  min_amount: 50, pause_contacts: [C3], pause_invoices: [],
};

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore()); invoices = FIXTURE();
  Object.assign(process.env, { XERO_CLIENT_ID: "x", XERO_CLIENT_SECRET: "y", XERO_TENANT_ID: "t", XERO_REFRESH_TOKEN: "r1", M365_ACCESS_TOKEN: "ms", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a cron cannot run a live operation, and a live operation cannot be drafted", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "microsoft-365", op: "users.user.messages.message.send", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "xero", op: "accounting.getInvoices", summary: "x" }), /not a live operation/);
  await assert.rejects(ctx.draft({ platform: "xero", op: "accounting.emailInvoice", summary: "x" }), /not a draft operation/);
});

test("refresh records what is overdue and closes an invoice that has dropped off the open list", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await refresh(ctx), { open: 6, closed: 0 });
  assert.equal((await store.get<InvoiceRow>("invoices", A))!.days_overdue, 19);
  invoices = invoices.filter((i) => i.InvoiceID !== B);     // paid in Xero
  assert.deepEqual(await refresh(ctx), { open: 5, closed: 1 });
  assert.ok((await store.get<InvoiceRow>("invoices", B))!.closed);
});

test("the crons read and draft: nothing is sent and nothing is noted in Xero before approval", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await refresh(ctx);
  assert.deepEqual(await draft(ctx), { queued: 2, skipped: 4, errors: 0 });
  assert.deepEqual(await summary(ctx), { drafted: 1, overdue: 6 });
  assert.equal(sends().length, 0, "no send by a cron");
  assert.equal(notes().length, 0, "no Xero note by a cron");
  assert.equal(drafted().length, 3, "two reminder drafts and one owner digest");
  assert.equal(Object.keys(await store.list<Approval>("approvals")).length, 2);
});

test("a re-run never drafts or queues anything twice", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await refresh(ctx); await draft(ctx); await summary(ctx);
  await refresh(ctx); await draft(ctx); await summary(ctx);
  assert.equal(drafted().length, 3);
  assert.equal(Object.keys(await store.list<Approval>("approvals")).length, 2);
});

test("a reminder is drafted with the client's own email and the invoice PDF, and its text is escaped", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await refresh(ctx); await draft(ctx);
  const final = drafted().find((h) => h.body?.subject === "Final reminder: invoice INV-1002")!;
  assert.ok(final, "final reminder drafted for INV-1002");
  assert.equal(final.body.toRecipients[0].emailAddress.address, "ari@example.com");
  assert.equal(final.body.attachments[0].contentBytes, PDF_B64);
  assert.equal(final.body.attachments[0].name, "invoice-INV-1002.pdf");
  assert.ok(!final.body.body.content.includes("<img"), "no raw HTML from the client name");
  assert.match(final.body.body.content, /Hi Ari,/);
});

test("an invoice past several steps is drafted once, at the latest step, not at each one", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await refresh(ctx); await draft(ctx);
  const chase = await store.get<any>("chases", B);
  assert.deepEqual(Object.keys(chase.stages), ["3"]);
  const [ap] = Object.values(await store.list<Approval>("approvals")).filter((a) => a.summary.includes("INV-1002"));
  assert.match(ap.summary, /reminder 3 \(final\)/);
});

test("a client with no email, a paused client, a small debt and a not-yet-due invoice are all left alone", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await refresh(ctx); await draft(ctx);
  const text = Object.values(await store.list<Approval>("approvals")).map((a) => a.summary).join("\n");
  for (const n of ["INV-1003", "INV-1004", "INV-1005", "INV-1006"]) assert.ok(!text.includes(n), `${n} not queued`);
  assert.equal(await store.get("chases", C), undefined);
  assert.equal(await store.get("chases", D), undefined);
});

test("an invoice paid before its reminder is drafted is never chased", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await refresh(ctx);
  invoices = invoices.filter((i) => i.InvoiceID !== A && i.InvoiceID !== B);
  await refresh(ctx); await draft(ctx);
  assert.equal(drafted().filter((h) => h.body?.subject?.includes("INV-1001") || h.body?.subject?.includes("INV-1002")).length, 0);
  assert.equal(Object.keys(await store.list<Approval>("approvals")).length, 0);
});

test("one failed invoice is left for the next run and does not stop the others", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await refresh(ctx);
  failPdfFor = new Set([A]);
  assert.deepEqual(await draft(ctx), { queued: 1, skipped: 4, errors: 1 });
  failPdfFor = new Set();
  assert.deepEqual(await draft(ctx), { queued: 1, skipped: 4, errors: 0 });
  assert.equal(Object.keys(await store.list<Approval>("approvals")).length, 2);
});

test("an approved reminder is sent first, then noted on the invoice in Xero, and runs only once", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await refresh(ctx); await draft(ctx);
  const chase = (await store.get<any>("chases", A))!;
  const ap = Object.values(await store.list<Approval>("approvals")).find((a) => a.summary.includes("INV-1001"))!;
  assert.deepEqual(ap.acts.map((a) => a.op), ["users.user.messages.message.send", "accounting.createInvoiceHistory"]);
  const done = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(done.status, "done");
  assert.equal(sends().length, 1);
  assert.match(sends()[0].path, new RegExp(`/messages/${chase.stages["2"].message_id}/send$`));
  assert.ok(hits.indexOf(sends()[0]) < hits.indexOf(notes()[0]), "send before the Xero note");
  assert.ok(notes()[0].path.endsWith(`/Invoices/${A}/History`), "the note goes to the invoice it reminds about");
  assert.match(JSON.stringify(notes()[0].body), /Payment reminder 2 emailed to jo@example.com/);
  await assert.rejects(approve(WF, store, ap.id, "owner", NOW), /already done/);
  assert.equal(sends().length, 1);
});

test("the owner digest is drafted once a day and lists the overdue invoices, escaped", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await refresh(ctx);
  await summary(ctx); await summary(ctx);
  const digests = drafted().filter((h) => h.body?.subject?.startsWith("Overdue invoices"));
  assert.equal(digests.length, 1);
  assert.equal(digests[0].body.toRecipients[0].emailAddress.address, "owner@example.com");
  assert.ok(!digests[0].body.body.content.includes("<img"));
});

test("Xero's two date formats, days overdue and the step reached", () => {
  assert.equal(parseXeroDate(`/Date(${Date.parse("2026-09-01T00:00:00Z")}+0000)/`), "2026-09-01");
  assert.equal(parseXeroDate("2026-10-20T00:00:00"), "2026-10-20");
  assert.equal(parseXeroDate(""), "");
  assert.equal(parseXeroDate("not a date"), "");
  assert.equal(daysOverdue("2026-10-20", NOW), 19);
  assert.equal(daysOverdue("2026-11-30", NOW), 0);
  const ladder = [...S.ladder];
  assert.equal(stageFor(ladder, 3), 0);
  assert.equal(stageFor(ladder, 19), 2);
  assert.equal(stageFor(ladder, 68), 3);
});

test("deploy: every target renders every cron", () => {
  for (const t of TARGETS) {
    const all = Object.values(render(DIR, S, t)).join("\n");
    for (const c of WF.crons) assert.ok(all.includes(c.name) || all.includes(c.schedule), `${t} has ${c.name}`);
  }
});
