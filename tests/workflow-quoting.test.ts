// Quoting workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { setTransport, WriteBlocked } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, approvalId, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { intake, draft, followUp, handover } from "../industries/construction/workflows/sales/quoting/index.ts";
import { render, awsCron, TARGETS } from "../tools/deploy.ts";
import { main } from "../tools/workflow.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const LINES = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kit-")), "lines.json");

const WF = JSON.parse(fs.readFileSync("industries/construction/workflows/sales/quoting/workflow.json", "utf8")) as WorkflowRecord;
const JOB = "11111111-2222-4333-8444-555555555555", MAT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", PDF = "99999999-8888-4777-8666-555555555555";
const QID = "12345678-1234-4234-8234-123456789012", CID = "87654321-4321-4321-8321-210987654321", INV = "abcdefab-cdef-4abc-8def-abcdefabcdef";
type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let jobStatus = "Quote", xeroStatus = "DRAFT", hasLines = false, produced = false, failXeroUpdate = 0;

function fake() {
  hits = []; jobStatus = "Quote"; xeroStatus = "DRAFT"; hasLines = false; produced = false; failXeroUpdate = 0;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown, h: Record<string, string> = {}) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json", ...h } });
      if (/token$/.test(p)) return json({ access_token: "tok", refresh_token: "r2", expires_in: 1800 });
      if (p.endsWith("/connections")) return json([{ tenantId: "t" }]);
      // ServiceM8
      if (p.endsWith("/job.json") && m === "GET") return json(u.searchParams.get("$filter")?.includes("uuid eq") ? [{ uuid: JOB, status: jobStatus }]
        : [{ uuid: JOB, status: "Quote", active: 1, job_description: "Hot water system leaking", job_address: "1 Test St", company_uuid: MAT, date: "2026-11-01" }]);
      if (p.endsWith("/job.json") && m === "POST") return json({ errorCode: 0 }, { "x-record-uuid": JOB });
      if (p.endsWith("/jobmaterial.json")) { if (m === "POST") hasLines = true; return json(m === "GET" ? (hasLines ? [{ uuid: MAT }] : []) : { errorCode: 0 }); }
      if (p.endsWith("/material.json")) return json([{ uuid: MAT, item_number: "CALLOUT", name: "Call-out", price: "120.00" }, { uuid: PDF, item_number: "LAB-HR", name: "Labour hour", price: "95" }]);
      if (p.endsWith("/companycontact.json")) return json([{ first: "Sam", last: "Lee", email: "sam@example.com", mobile: "0412 345 678", is_primary_contact: "1" }]);
      if (p.endsWith("/platform_produce_document")) produced = true;
      if (p.endsWith("/platform_produce_document")) return new Response(new Uint8Array([37, 80, 68, 70]), { status: 200, headers: { "content-type": "application/pdf" } });
      if (p.endsWith("/attachment.json")) return json([{ uuid: MAT, file_type: ".pdf", timestamp: "2026-10-01 09:00:00" }, ...(produced ? [{ uuid: PDF, file_type: ".pdf", timestamp: "2026-11-08 10:00:00" }] : [])]);
      if (p.endsWith("/platform_service_email") || p.endsWith("/platform_service_sms")) return json({ errorCode: 0 });
      // Xero
      if (p.endsWith("/Items")) return json({ Items: [{ ItemID: "i1", Code: "CALLOUT", Name: "Call-out", SalesDetails: { UnitPrice: 120 } }, { ItemID: "i2", Code: "LAB-HR", Name: "Labour hour", SalesDetails: { UnitPrice: 95 } }] });
      if (p.endsWith("/Contacts")) return json({ Contacts: m === "GET" ? [{ ContactID: CID, EmailAddress: "sam@example.com" }] : [{ ContactID: CID }] });
      if (p.endsWith("/Quotes") && m === "PUT") return json({ Quotes: [{ QuoteID: QID, Status: "DRAFT" }] });
      if (p.endsWith(`/Quotes/${QID}/pdf`)) return new Response(new Uint8Array([37, 80, 68, 70]), { status: 200, headers: { "content-type": "application/pdf" } });
      if (p.endsWith(`/Quotes/${QID}`) && m === "POST" && failXeroUpdate-- > 0) return new Response("{}", { status: 500 });
      if (p.endsWith(`/Quotes/${QID}`)) return json({ Quotes: [{ QuoteID: QID, Status: m === "POST" ? "SENT" : xeroStatus }] });
      if (p.endsWith("/Invoices")) return json({ Invoices: [{ InvoiceID: INV, Status: "DRAFT" }] });
      // Microsoft Graph
      if (/\/messages\/[^/]+\/send$/.test(p)) return new Response(null, { status: 202 });
      if (p.endsWith("/messages") && m === "POST") return json({ id: "AAMkDraft1" });
      if (p.endsWith("/messages")) return json({ value: [{ id: "AAMkReq1", subject: "Quote for blocked drain", from: { emailAddress: { name: "Ari", address: "ari@example.com" } }, receivedDateTime: "2026-11-08T00:00:00Z", bodyPreview: "Blocked drain at the back" }] });
      if (p.endsWith("/rows") && m === "GET") return json({ value: [{ values: [["CALLOUT", "Call-out", "each", 120]] }, { values: [["JETTER", "Drain jetter", "each", 250]] }] });
      if (p.endsWith("/rows")) return json({ index: 0 });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const sends = () => hits.filter((h) => /platform_service_(email|sms)$|\/send$/.test(h.path) || (h.path.includes("/Quotes/") && h.method === "POST"));
const S8: any = { family: "service-minor-works", business_name: "Test Plumbing", intake: ["servicem8"], quotes: "servicem8", rate_card: "servicem8", messages: "servicem8",
  job_templates: [{ match: "hot water", lines: [{ code: "CALLOUT", qty: 1 }, { code: "LAB-HR", qty: 2 }] }], follow_up: { after_days: [3, 7] } };
const XERO: any = { ...S8, intake: ["microsoft-365"], quotes: "xero", rate_card: "xero", messages: "microsoft-365", microsoft_365: { mailbox: "quotes@example.com" },
  job_templates: [{ match: "blocked drain", lines: [{ code: "CALLOUT", qty: 1 }] }], handover: { on_accept: "xero-invoice-draft", deposit_percent: 20 } };
const NOW = new Date("2026-11-08T00:00:00Z");

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { SERVICEM8_API_KEY: "s8", M365_ACCESS_TOKEN: "ms", XERO_CLIENT_ID: "x", XERO_CLIENT_SECRET: "y", XERO_TENANT_ID: "t", XERO_REFRESH_TOKEN: "r1", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a draft cannot run a live operation and a cron cannot queue a draft one", async () => {
  const ctx = context(WF, S8, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "servicem8", op: "messaging-api.send_email", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "servicem8", op: "servicem8-api.createJobs", summary: "x" }), /not a live operation/);
  await assert.rejects(ctx.draft({ platform: "xero", op: "accounting.deleteQuote", summary: "x" }), /not a draft operation/);
});

test("runtime: the SDK gate still blocks drafts when the deploy does not allow writes", async () => {
  process.env.KIT_ALLOW_WRITES = "0";
  const ctx = context(WF, S8, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "servicem8", op: "servicem8-api.createJobs", input: { body: { status: "Quote" } }, summary: "x" }), WriteBlocked);
  assert.equal(hits.length, 0);
});

test("service quote in ServiceM8: drafted and queued, never sent until approved", async () => {
  const store = new MemoryStore(), ctx = context(WF, S8, store, NOW, () => {});
  assert.deepEqual(await intake(ctx), { added: 1 });
  assert.deepEqual(await draft(ctx), { drafted: 1, needs_pricing: 0 });
  assert.equal(sends().length, 0, "nothing sent by a cron");
  const lines = hits.filter((h) => h.path.endsWith("/jobmaterial.json") && h.method === "POST").map((h) => h.body);
  assert.deepEqual(lines.map((l) => [l.name, l.quantity, l.price]), [["Call-out", "1", "120"], ["Labour hour", "2", "95"]]);
  const pending = await main(["approvals", "industries/construction/workflows/sales/quoting"], store) as any[];
  assert.equal(pending.length, 1);
  await draft(ctx); await intake(ctx);
  assert.equal((await main(["approvals", "industries/construction/workflows/sales/quoting"], store) as any[]).length, 1, "re-runs never queue twice");
  const ap = await approve(WF, store, pending[0].id, "owner", NOW);
  assert.equal(ap.status, "done");
  const email = sends().find((h) => h.path.endsWith("/platform_service_email"))!;
  assert.equal(email.body.to, "sam@example.com");
  assert.deepEqual(email.body.attachments, [PDF]);
  await assert.rejects(approve(WF, store, pending[0].id, "owner"), /already done/);
});

test("a request with no template is parked, then drafted from the agent's proposal", async () => {
  const store = new MemoryStore(), ctx = context(WF, { ...S8, job_templates: [] }, store, NOW, () => {});
  await intake(ctx);
  assert.deepEqual(await draft(ctx), { drafted: 0, needs_pricing: 1 });
  fs.writeFileSync(LINES, JSON.stringify([{ code: "LAB-HR", qty: 3 }, { code: "NOPE", qty: 1 }]));
  await main(["propose", "industries/construction/workflows/sales/quoting", `servicem8:${JOB}`, LINES], store);
  assert.deepEqual(await draft(ctx), { drafted: 0, needs_pricing: 1 }, "an unknown code keeps it parked");
  fs.writeFileSync(LINES, JSON.stringify([{ code: "LAB-HR", qty: 3 }]));
  await main(["propose", "industries/construction/workflows/sales/quoting", `servicem8:${JOB}`, LINES], store);
  assert.deepEqual(await draft(ctx), { drafted: 1, needs_pricing: 0 });
  fs.rmSync(LINES);
});

test("Xero quote from an Outlook request: DRAFT in Xero, email draft with the PDF, one approval sends and marks SENT", async () => {
  const store = new MemoryStore(), ctx = context(WF, XERO, store, NOW, () => {});
  await intake(ctx); await draft(ctx);
  const q = hits.find((h) => h.path.endsWith("/Quotes") && h.method === "PUT")!.body.Quotes[0];
  assert.equal(q.Status, "DRAFT");
  assert.deepEqual(q.LineItems, [{ ItemCode: "CALLOUT", Description: "Call-out", Quantity: 1, UnitAmount: 120 }]);
  const d = hits.find((h) => h.path.endsWith("/messages") && h.method === "POST")!.body;
  assert.equal(d.attachments[0].contentBytes, Buffer.from([37, 80, 68, 70]).toString("base64"));
  assert.equal(sends().length, 0);
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  assert.deepEqual(ap.acts.map((a) => a.op), ["users.user.messages.message.send", "accounting.updateQuote"]);
  await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(sends().length, 2);
});

test("follow-up comes due after the set days, once; acceptance hands over as a DRAFT deposit invoice", async () => {
  const store = new MemoryStore();
  await intake(context(WF, XERO, store, NOW, () => {})); await draft(context(WF, XERO, store, NOW, () => {}));
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  await approve(WF, store, ap.id, "owner", NOW);
  xeroStatus = "SENT";
  assert.deepEqual(await followUp(context(WF, XERO, store, new Date(NOW.getTime() + 2 * 864e5), () => {})), { queued: 0 });
  assert.deepEqual(await followUp(context(WF, XERO, store, new Date(NOW.getTime() + 4 * 864e5), () => {})), { queued: 1 });
  assert.deepEqual(await followUp(context(WF, XERO, store, new Date(NOW.getTime() + 5 * 864e5), () => {})), { queued: 0 });
  xeroStatus = "ACCEPTED";
  await followUp(context(WF, XERO, store, new Date(NOW.getTime() + 6 * 864e5), () => {}));
  assert.deepEqual(await handover(context(WF, XERO, store, new Date(NOW.getTime() + 6 * 864e5), () => {})), { handed_over: 1 });
  const inv = hits.find((h) => h.path.endsWith("/Invoices"))!.body.Invoices[0];
  assert.equal(inv.Status, "DRAFT");
  assert.equal(inv.LineItems[0].UnitAmount, 24);
  assert.equal(await store.get<Approval>("approvals", approvalId(WF.id, "send:xero:" + QID)) !== undefined, true);
});

test("deploy: every target renders every cron, with key names and no key values", () => {
  assert.equal(awsCron("*/10 * * * *"), "cron(0/10 * * * ? *)");
  assert.equal(awsCron("0 22 * * 1"), "cron(0 22 ? * 1 *)");
  for (const t of TARGETS) {
    const files = render("industries/construction/workflows/sales/quoting", S8, t);
    const all = Object.values(files).join("\n");
    for (const c of WF.crons) assert.ok(all.includes(c.name) || all.includes(c.schedule), `${t} has ${c.name}`);
    assert.ok(!/s8|tok-|Bearer [A-Za-z0-9]{8}/.test(all.replace(/SERVICEM8|kit|Bearer \$|Bearer \\\$|Bearer ' \|\||Bearer \${/g, "")), `${t} carries no key values`);
  }
});

test("HTTP runner: only an authenticated POST to /run/<cron> runs anything", async () => {
  process.env.KIT_RUNNER_TOKEN = "t".repeat(40);
  const { handler } = await import("../tools/workflow-http.ts");
  const ran: string[] = [];
  const srv = http.createServer(handler(async (c) => { ran.push(c); return { ok: 1 }; })).listen(0);
  const port = (srv.address() as any).port, url = (p: string) => `http://127.0.0.1:${port}${p}`;
  const auth = { authorization: `Bearer ${"t".repeat(40)}` };
  assert.equal((await fetch(url("/run/intake"), { method: "POST" })).status, 401);
  assert.equal((await fetch(url("/run/intake"), { method: "POST", headers: { authorization: "Bearer wrong" } })).status, 401);
  assert.equal((await fetch(url("/run/intake"), { headers: auth })).status, 404);
  assert.equal((await fetch(url("/approve/x"), { method: "POST", headers: auth })).status, 404);
  assert.equal((await fetch(url("/run/intake"), { method: "POST", headers: auth })).status, 200);
  assert.deepEqual(ran, ["intake"]);
  srv.close();
});

test("review fixes: one send under a double approve; a failed bundle resumes without re-sending; approvers see the total", async () => {
  const store = new MemoryStore(), ctx = context(WF, S8, store, NOW, () => {});
  await intake(ctx); await draft(ctx);
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  assert.match(ap.summary, /2 lines, \$310\.00 ex GST/);
  const both = await Promise.allSettled([approve(WF, store, ap.id, "a", NOW), approve(WF, store, ap.id, "b", NOW)]);
  assert.equal(both.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(sends().filter((h) => h.path.endsWith("/platform_service_email")).length, 1, "sent once");

  fake();
  const xs = new MemoryStore(), xc = context(WF, XERO, xs, NOW, () => {});
  await intake(xc); await draft(xc);
  const create = hits.find((h) => h.path.endsWith("/Quotes") && h.method === "PUT")!;
  assert.ok(create, "quote created");
  const [xa] = Object.values(await xs.list<Approval>("approvals"));
  failXeroUpdate = 1;
  // A 500 may have been processed by the app: the approval waits for a person to check, and nothing resends on its own.
  assert.equal((await approve(WF, xs, xa.id, "owner", NOW)).status, "needs-check");
  await assert.rejects(approve(WF, xs, xa.id, "owner", NOW), /needs a check/, "approving again without a confirmation sends nothing");
  assert.equal((await approve(WF, xs, xa.id, "owner", NOW, "retry")).status, "done");
  assert.equal(hits.filter((h) => /\/send$/.test(h.path)).length, 1, "the email went once across the retry");
  await followUp(context(WF, XERO, xs, NOW, () => {}));
  assert.equal(Object.values(await xs.list<any>("quotes"))[0].status, "sent");
});

test("review fixes: idempotency keys on Xero creates, register cells never formulas, non-ASCII auth refused", async () => {
  const { cell } = await import("../industries/construction/workflows/sales/quoting/types.ts");
  assert.equal(cell("=HYPERLINK(1)"), "'=HYPERLINK(1)");
  assert.equal(cell("Sam"), "Sam");
  let seen: Record<string, string> = {};
  setTransport({ sleep: async () => {}, log: () => {}, fetch: (async (url: any, init: any) => {
    if (String(url).endsWith("/Quotes")) seen = init.headers;
    if (/token$/.test(new URL(String(url)).pathname)) return new Response(JSON.stringify({ access_token: "a", refresh_token: "b", expires_in: 1800 }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ Contacts: [{ ContactID: CID, EmailAddress: "ari@example.com" }], Quotes: [{ QuoteID: QID }] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as any });
  const { xero } = await import("../industries/construction/workflows/sales/quoting/adapters/xero.ts");
  await xero.draftQuote!(context(WF, { ...XERO, messages: "xero" }, new MemoryStore(), NOW, () => {}), { id: "m365:abc", source: "microsoft-365", title: "t", contact: { email: "ari@example.com" }, received: "", status: "new" }, [{ code: "CALLOUT", name: "Call-out", qty: 1, unitPrice: 120 }]);
  assert.ok(Object.keys(seen).some((k) => k.toLowerCase() === "idempotency-key"));
  process.env.KIT_RUNNER_TOKEN = "t".repeat(40);
  const { handler } = await import("../tools/workflow-http.ts");
  const srv = http.createServer(handler(async () => ({}))).listen(0);
  const port = (srv.address() as any).port;
  const status = await new Promise<number>((res) => { const r = http.request({ port, method: "POST", path: "/run/intake", headers: { authorization: "Bearer " + "\u00e9".repeat(36) } }, (x) => res(x.statusCode!)); r.end(); });
  assert.equal(status, 401);
  srv.close();
});

test("runtime: created ids are kept; a lost outcome needs a person's check and is never repeated on its own", async () => {
  const store = new MemoryStore(), ctx = context(WF, S8, store, NOW, () => {});
  await intake(ctx); await draft(ctx);
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  // Simulate a crash after the send started: the outcome never came back.
  await store.put("approvals", ap.id, { ...ap, status: "running", started: NOW.toISOString(), results: [{ op: ap.acts[0].op, status: "started" }] });
  await assert.rejects(approve(WF, store, ap.id, "owner", NOW), /needs a check/);
  assert.equal((await store.get<Approval>("approvals", ap.id))!.status, "needs-check");
  assert.equal(sends().length, 0, "nothing re-sent");
  const done = await approve(WF, store, ap.id, "owner", NOW, "done");
  assert.equal(done.status, "done");
  assert.equal(sends().length, 0, "confirmed as already sent, so not sent again");
  // A fresh approval records ids from the reply.
  fake();
  const s2 = new MemoryStore(), c2 = context(WF, XERO, s2, NOW, () => {});
  await intake(c2); await draft(c2);
  const [a2] = Object.values(await s2.list<Approval>("approvals"));
  const r2 = await approve(WF, s2, a2.id, "owner", NOW);
  assert.equal(r2.results!.at(-1)!.ref!.QuoteID, QID);
  // An approval left running for over 15 minutes is flagged, not run.
  await s2.put("approvals", a2.id, { ...r2, status: "running", started: new Date(NOW.getTime() - 16 * 60_000).toISOString(), results: [] });
  await assert.rejects(approve(WF, s2, a2.id, "owner", NOW), /needs a check/);
});
