// Quote-build workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { describe } from "../core/sdk/call.ts";
import { intake, draft, followUp, handover, CRONS } from "../industries/all/workflows/sales/quote-build/index.ts";
import { main } from "../tools/workflow.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const FOLDER = "industries/all/workflows/sales/quote-build";
const LINES = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kit-")), "lines.json");

const WF = JSON.parse(fs.readFileSync(`${FOLDER}/workflow.json`, "utf8")) as WorkflowRecord;
const JOB = "11111111-2222-4333-8444-555555555555", MAT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", PDF = "99999999-8888-4777-8666-555555555555";
const QID = "12345678-1234-4234-8234-123456789012", CID = "87654321-4321-4321-8321-210987654321", INV = "abcdefab-cdef-4abc-8def-abcdefabcdef";
type Hit = { method: string; path: string; search: string; body: any };
let hits: Hit[] = [];
let jobStatus = "Quote", xeroStatus = "DRAFT", produced = false, failXeroUpdate = 0;
/** The job's ServiceM8 lines, as the fake keeps them. dropLinePost makes a line write answer OK without keeping the line. */
let jobLines: any[] = [], dropLinePost = false;

function fake() {
  hits = []; jobStatus = "Quote"; xeroStatus = "DRAFT"; jobLines = []; dropLinePost = false; produced = false; failXeroUpdate = 0;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, search: u.search, body });
      const json = (d: unknown, h: Record<string, string> = {}) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json", ...h } });
      if (/token$/.test(p)) return json({ access_token: "tok", refresh_token: "r2", expires_in: 1800 });
      if (p.endsWith("/connections")) return json([{ tenantId: "t" }]);
      // ServiceM8
      if (p.endsWith("/job.json") && m === "GET") return json(u.searchParams.get("$filter")?.includes("uuid eq") ? [{ uuid: JOB, status: jobStatus }]
        : [{ uuid: JOB, status: "Quote", active: 1, job_description: "Hot water system leaking", job_address: "1 Test St", company_uuid: MAT, date: "2026-11-01" }]);
      if (p.endsWith("/job.json") && m === "POST") return json({ errorCode: 0 }, { "x-record-uuid": JOB });
      if (p.endsWith("/jobmaterial.json")) {
        if (m === "POST") { if (!dropLinePost) jobLines.push({ uuid: MAT, job_uuid: body.job_uuid, sort_order: body.sort_order, name: body.name, quantity: body.quantity, price: body.price }); return json({ errorCode: 0 }); }
        return json(jobLines.filter((l) => l.job_uuid === JOB));
      }
      if (p.endsWith("/material.json")) return json([{ uuid: MAT, item_number: "CALLOUT", name: "Call-out", price: "120.00" }, { uuid: PDF, item_number: "LAB-HR", name: "Labour hour", price: "95" }]);
      if (p.endsWith("/companycontact.json")) return json([{ first: "Sam", last: "Lee", email: "sam@example.com", mobile: "0412 345 678", is_primary_contact: "1" }]);
      if (p.endsWith("/platform_produce_document")) { produced = true; return new Response(new Uint8Array([37, 80, 68, 70]), { status: 200, headers: { "content-type": "application/pdf" } }); }
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
const S8: any = { family: "priced-job-from-site-visit", business_name: "Test Services", intake: ["servicem8"], quotes: "servicem8", rate_card: "servicem8", messages: "servicem8",
  job_templates: [{ match: "hot water", lines: [{ code: "CALLOUT", qty: 1 }, { code: "LAB-HR", qty: 2 }] }], follow_up: { after_days: [3, 7] } };
const XERO: any = { ...S8, intake: ["microsoft-365"], quotes: "xero", rate_card: "xero", messages: "microsoft-365", microsoft_365: { mailbox: "quotes@example.com" },
  job_templates: [{ match: "blocked drain", lines: [{ code: "CALLOUT", qty: 1 }] }], handover: { on_accept: "xero-invoice-draft", deposit_percent: 20 } };
const NOW = new Date("2026-11-08T00:00:00Z");

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { SERVICEM8_API_KEY: "s8", M365_ACCESS_TOKEN: "ms", XERO_CLIENT_ID: "x", XERO_CLIENT_SECRET: "y", XERO_TENANT_ID: "t", XERO_REFRESH_TOKEN: "r1", KIT_ALLOW_WRITES: "1" });
});

test("crons: the four entries in the record are the four crons in index.ts", () => {
  assert.deepEqual(Object.keys(CRONS).sort(), WF.crons.map((c) => c.entry).sort());
  assert.equal(WF.id, "quote-build");
  assert.equal(WF.status, "docs-only");
});

test("runtime: a draft cannot run a live operation and a cron cannot queue a draft one", async () => {
  const ctx = context(WF, S8, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "servicem8", op: "messaging-api.send_email", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "servicem8", op: "servicem8-api.createJobs", summary: "x" }), /not a live operation/);
  await assert.rejects(ctx.draft({ platform: "xero", op: "accounting.deleteQuote", summary: "x" }), /not a draft operation/);
});

test("every operation in workflow.json is mapped in the kit, and no operation is both draft and live", () => {
  const draftOps = Object.entries(WF.draft_ops).flatMap(([p, ops]) => ops.map((o) => [p, o] as const));
  const liveOps = Object.entries(WF.live_ops).flatMap(([p, ops]) => ops.map((o) => [p, o] as const));
  for (const [p, o] of [...draftOps, ...liveOps]) assert.ok(describe(p, o), `${p} ${o} is mapped`);
  const draftSet = new Set(draftOps.map(([p, o]) => `${p} ${o}`));
  for (const [p, o] of liveOps) assert.ok(!draftSet.has(`${p} ${o}`), `${p} ${o} is not in both lists`);
});

test("the SDK gate still blocks drafts when the deploy does not allow writes", async () => {
  process.env.KIT_ALLOW_WRITES = "0";
  const ctx = context(WF, S8, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "servicem8", op: "servicem8-api.createJobs", input: { body: { status: "Quote" } }, summary: "x" }));
  assert.equal(hits.filter((h) => h.method !== "GET").length, 0, "no write reached the network");
});

test("service quote in ServiceM8: drafted and queued, never sent until approved, queued once across re-runs", async () => {
  const store = new MemoryStore(), ctx = context(WF, S8, store, NOW, () => {});
  assert.deepEqual(await intake(ctx), { added: 1 });
  assert.deepEqual(await draft(ctx), { drafted: 1, needs_pricing: 0 });
  assert.equal(sends().length, 0, "nothing sent by a cron");
  const lines = hits.filter((h) => h.path.endsWith("/jobmaterial.json") && h.method === "POST").map((h) => h.body);
  assert.deepEqual(lines.map((l) => [l.name, l.quantity, l.price]), [["Call-out", "1", "120"], ["Labour hour", "2", "95"]]);
  const pending = await main(["approvals", FOLDER], store) as any[];
  assert.equal(pending.length, 1);
  assert.match(pending[0].summary, /2 lines, \$310\.00 ex GST/);
  await draft(ctx); await intake(ctx);
  assert.equal((await main(["approvals", FOLDER], store) as any[]).length, 1, "re-runs never queue twice");
  assert.equal(sends().length, 0, "still nothing sent after the re-runs");
  const ap = await approve(WF, store, pending[0].id, "owner", NOW);
  assert.equal(ap.status, "done");
  const email = sends().find((h) => h.path.endsWith("/platform_service_email"))!;
  assert.equal(email.body.to, "sam@example.com");
  assert.deepEqual(email.body.attachments, [PDF]);
  await assert.rejects(approve(WF, store, pending[0].id, "owner"), /already done/);
  assert.equal(sends().filter((h) => h.path.endsWith("/platform_service_email")).length, 1, "sent once");
});

test("a request with no template is parked, then drafted from the agent's proposal", async () => {
  const store = new MemoryStore(), ctx = context(WF, { ...S8, job_templates: [] }, store, NOW, () => {});
  await intake(ctx);
  assert.deepEqual(await draft(ctx), { drafted: 0, needs_pricing: 1 });
  fs.writeFileSync(LINES, JSON.stringify([{ code: "LAB-HR", qty: 3 }, { code: "NOPE", qty: 1 }]));
  await main(["propose", FOLDER, `servicem8:${JOB}`, LINES], store);
  assert.deepEqual(await draft(ctx), { drafted: 0, needs_pricing: 1 }, "an unknown code keeps it parked");
  fs.writeFileSync(LINES, JSON.stringify([{ code: "LAB-HR", qty: 3 }]));
  await main(["propose", FOLDER, `servicem8:${JOB}`, LINES], store);
  assert.deepEqual(await draft(ctx), { drafted: 1, needs_pricing: 0 });
  fs.rmSync(LINES);
});

test("an agent price far from the rate card parks the quote for a person; one near it is kept", async () => {
  const store = new MemoryStore(), ctx = context(WF, { ...S8, job_templates: [] }, store, NOW, () => {});
  await intake(ctx);
  fs.writeFileSync(LINES, JSON.stringify([{ code: "LAB-HR", qty: 3, unitPrice: 1 }]));   // rate card says 95
  await main(["propose", FOLDER, `servicem8:${JOB}`, LINES], store);
  assert.deepEqual(await draft(ctx), { drafted: 0, needs_pricing: 1 }, "a price of 1 against a rate of 95 is parked");
  const parked: any = Object.values(await store.list<any>("enquiries"))[0];
  assert.match(parked.reason, /differs from the rate card/);
  fs.writeFileSync(LINES, JSON.stringify([{ code: "LAB-HR", qty: 3, unitPrice: 100 }]));  // within 25%
  await main(["propose", FOLDER, `servicem8:${JOB}`, LINES], store);
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
  assert.equal(sends().length, 0, "nothing sent by a cron");
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  assert.deepEqual(ap.acts.map((a) => a.op), ["users.user.messages.message.send", "accounting.updateQuote"]);
  await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(sends().length, 2, "the email and the Xero status change ran once each, on approval");
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
});

test("retry: a line already on the job is not written again, the missing one is, and the job ends with every line", async () => {
  const store = new MemoryStore(), ctx = context(WF, S8, store, NOW, () => {});
  await intake(ctx);
  jobLines.push({ uuid: MAT, job_uuid: JOB, sort_order: "1", name: "Call-out", quantity: "1", price: "120" });   // written by the run that failed
  assert.deepEqual(await draft(ctx), { drafted: 1, needs_pricing: 0 });
  assert.deepEqual(hits.filter((h) => h.path.endsWith("/jobmaterial.json") && h.method === "POST").map((h) => h.body.name), ["Labour hour"]);
  assert.deepEqual(jobLines.map((l) => [l.sort_order, l.name]), [["1", "Call-out"], ["2", "Labour hour"]]);
  assert.equal((await main(["approvals", FOLDER], store) as any[]).length, 1, "the send is queued once the job has every line");
});

test("a quote line that does not reach the job stops the send: nothing is queued, and the next run finishes the job", async () => {
  const store = new MemoryStore(), ctx = context(WF, S8, store, NOW, () => {});
  await intake(ctx);
  dropLinePost = true;
  await assert.rejects(draft(ctx), /2 quote line\(s\) are not on job/);
  assert.equal((await main(["approvals", FOLDER], store) as any[]).length, 0, "no send queued from a short job");
  dropLinePost = false;
  assert.deepEqual(await draft(ctx), { drafted: 1, needs_pricing: 0 });
  assert.deepEqual(jobLines.map((l) => l.name), ["Call-out", "Labour hour"]);
  assert.equal((await main(["approvals", FOLDER], store) as any[]).length, 1);
});

test("a stored job id that is not a UUID never reaches an OData filter", async () => {
  const store = new MemoryStore(), ctx = context(WF, S8, store, NOW, () => {});
  await intake(ctx);
  const [e] = Object.values(await store.list<any>("enquiries"));
  await store.put("enquiries", e.id, { ...e, ref: { ...e.ref, job_uuid: "x' or 1 eq 1" } });
  await assert.rejects(draft(ctx), /bad uuid/);
  assert.equal(hits.filter((h) => decodeURIComponent(h.search).includes("1 eq 1")).length, 0, "the id never reached a request");
  assert.equal(hits.filter((h) => h.method !== "GET").length, 0, "no write either");
});
