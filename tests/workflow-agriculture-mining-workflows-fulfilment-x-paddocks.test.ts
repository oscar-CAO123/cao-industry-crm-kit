// Paddock records workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { register, paddockRead, review } from "../industries/agriculture-mining/workflows/fulfilment/x-paddocks/index.ts";
import { keyOf, type Settings, type JobRecord } from "../industries/agriculture-mining/workflows/fulfilment/x-paddocks/types.ts";
import fs from "node:fs";

const DIR = "industries/agriculture-mining/workflows/fulfilment/x-paddocks";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const BOX = "records@example.com.au", QC = "qc@example.com.au";
const DRAFT = "AAMkDraft1";
const NOW = new Date("2026-11-09T00:00:00Z");

const FIELDS = [
  { id: "F1", name: "North 4", farmId: "FARM1", totalArea: 42.5, unit: "HECTARE", landUse: "CROPPING", cropType: "Wheat" },
  { id: "F2", name: "<b>Creek flat</b>", farmId: "FARM1", totalArea: 9, unit: "HECTARE", landUse: null, cropType: null },
];

type Hit = { method: string; host: string; path: string; body: any; query: string };
let hits: Hit[] = [];
let existing: string[] = [];

function fake() {
  hits = []; existing = ["spray-old-1"];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      const query = String(body?.query ?? "");
      hits.push({ method: m, host: u.host, path: p, body, query });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      // AgriWebb (GraphQL)
      if (u.host.includes("agriwebb")) {
        if (/\bfields\b/.test(query)) return json({ data: { fields: FIELDS } });
        return new Response("not faked", { status: 404 });
      }
      // Microsoft 365 (Graph and the workbook)
      if (p.endsWith("/workbook/tables/PaddockJobs/rows") && m === "GET")
        return json({ value: existing.map((id) => ({ values: [[id, "2026-11-01"]] })) });
      if (p.endsWith("/workbook/tables/PaddockJobs/rows") && m === "POST") { existing.push(String(body?.values?.[0]?.[0])); return json({ index: 0 }); }
      if (p.endsWith("/messages") && m === "POST") return json({ id: DRAFT });
      if (p.endsWith(`/messages/${DRAFT}/send`)) return new Response(null, { status: 202 });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}

const sends = () => hits.filter((h) => h.path.endsWith("/send"));
const rowsWritten = () => hits.filter((h) => h.method === "POST" && h.path.endsWith("/rows"));
const agriReads = () => hits.filter((h) => h.host.includes("agriwebb"));
const drafts = () => hits.filter((h) => h.method === "POST" && h.path.endsWith("/messages"));
const SETTINGS: Settings = {
  business_name: "Example Station",
  microsoft_365: { mailbox: BOX, register: { drive: "D1", item: "I1", table: "PaddockJobs" }, qc_email: QC },
  agriwebb: { farm_ids: ["FARM1", "bad id!"] },
};

const rec = (id: string, over: Partial<JobRecord> = {}): JobRecord => ({
  key: keyOf(id), id, kind: "spray", date: "2026-11-08", paddock: "North 4", product: "Glyphosate 450", rate: "1.5 L/ha",
  weather: "8 km/h SW, 24 C, 55 percent", withholding_until: "2026-11-22", operator: "Sam", status: "new", ...over,
});

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { M365_ACCESS_TOKEN: "ms", AGRIWEBB_ACCESS_TOKEN: "ag", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a cron cannot send directly, and cannot queue a draft operation", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "microsoft-365", op: "users.user.messages.message.send", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "microsoft-365", op: "drives.items.workbook.tables.CreateRows", summary: "x" }), /not a live operation/);
  await assert.rejects(ctx.draft({ platform: "agriwebb", op: "mutation.addRecords", summary: "x" }), /not a draft operation/);
});

test("register: a complete record is written once, an incomplete one is written as needs-check, nothing is sent", async () => {
  const store = new MemoryStore();
  await store.put("records", keyOf("spray-1"), rec("spray-1"));
  await store.put("records", keyOf("spray-2"), rec("spray-2", { withholding_until: undefined }));
  await store.put("records", keyOf("spray-old-1"), rec("spray-old-1"));
  await store.put("records", keyOf("sow-1"), rec("sow-1", { kind: "sow", product: undefined, rate: undefined, weather: undefined, withholding_until: undefined }));
  const ctx = context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await register(ctx), { registered: 3, skipped: 1, needs_check: 1 });
  assert.equal(rowsWritten().length, 3);
  assert.equal(sends().length, 0, "nothing sent by a cron");
  const sow = await store.get<JobRecord>("records", keyOf("sow-1"));
  assert.equal(sow?.status, "registered", "a sow needs only date, paddock and operator");
  const spray2 = await store.get<JobRecord>("records", keyOf("spray-2"));
  assert.equal(spray2?.status, "needs-check");
  assert.deepEqual(spray2?.missing, ["withholding_until"]);
  assert.deepEqual(await register(ctx), { registered: 0, skipped: 0, needs_check: 0 }, "a re-run never writes a row twice");
  assert.equal(rowsWritten().length, 3);
});

test("a spreadsheet cell from the owner cannot become a formula", async () => {
  const store = new MemoryStore();
  await store.put("records", keyOf("spray-9"), rec("spray-9", { paddock: "=HYPERLINK(\"http://x\")" }));
  await register(context(WF, SETTINGS, store, NOW, () => {}));
  const row = rowsWritten()[0].body.values[0];
  assert.equal(row[3], "'=HYPERLINK(\"http://x\")");
});

test("paddock-read: reads the watched farm only, stores its paddocks, sends nothing", async () => {
  const store = new MemoryStore();
  assert.deepEqual(await paddockRead(context(WF, SETTINGS, store, NOW, () => {})), { paddocks: 2 });
  assert.equal(agriReads().length, 1, "the bad farm id is never queried");
  assert.match(agriReads()[0].query, /fields/);
  assert.equal((await store.get<any>("paddocks", "F1"))?.cropType, "Wheat");
  assert.equal(sends().length, 0);
});

test("review: one QC email is drafted and queued, nothing is sent until approved, nothing is listed twice", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await store.put("records", keyOf("spray-2"), rec("spray-2", { withholding_until: undefined, status: "needs-check", missing: ["withholding_until"] }));
  await paddockRead(ctx);
  assert.deepEqual(await review(ctx), { flagged: 1, bare_paddocks: 1 });
  assert.equal(drafts().length, 1);
  assert.equal(sends().length, 0, "nothing sent by a cron");
  const html = drafts()[0].body.body.content as string;
  assert.ok(html.includes("&lt;b&gt;Creek flat&lt;/b&gt;"), "paddock names are escaped in the email");
  assert.ok(!html.includes("<b>Creek flat</b>"));
  const pending = Object.values(await store.list<Approval>("approvals"));
  assert.equal(pending.length, 1);
  assert.deepEqual(await review(ctx), { flagged: 0, bare_paddocks: 0 }, "a second run lists nothing new");
  assert.equal(drafts().length, 1, "and drafts nothing new");
  assert.equal(Object.values(await store.list<Approval>("approvals")).length, 1, "and queues nothing new");
  const ap = await approve(WF, store, pending[0].id, "owner", NOW);
  assert.equal(ap.status, "done");
  assert.equal(sends().length, 1);
  assert.ok(sends()[0].path.endsWith(`/messages/${DRAFT}/send`));
  await assert.rejects(approve(WF, store, pending[0].id, "owner"), /already done/);
});

test("review with no qc_email drafts nothing", async () => {
  const store = new MemoryStore();
  await store.put("records", keyOf("spray-2"), rec("spray-2", { status: "needs-check", missing: ["operator"] }));
  const s: Settings = { ...SETTINGS, microsoft_365: { ...SETTINGS.microsoft_365, qc_email: undefined } };
  assert.deepEqual(await review(context(WF, s, store, NOW, () => {})), { flagged: 0, bare_paddocks: 0 });
  assert.equal(drafts().length, 0);
});
