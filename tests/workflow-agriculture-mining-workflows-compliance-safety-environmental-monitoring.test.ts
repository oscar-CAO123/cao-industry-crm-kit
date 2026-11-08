// Environmental monitoring workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord } from "../core/workflows/runtime.ts";
import { register, review } from "../industries/agriculture-mining/workflows/compliance-safety/environmental-monitoring/index.ts";
import { keyOf, type Settings, type Reading } from "../industries/agriculture-mining/workflows/compliance-safety/environmental-monitoring/types.ts";
import fs from "node:fs";

const DIR = "industries/agriculture-mining/workflows/compliance-safety/environmental-monitoring";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const BOX = "environment@example.com.au", QC = "qc@example.com.au", TABLE = "MonitoringRegister", DRAFT = "AAMkDraft1";
const REGISTERED_IDS = ["env-old-1"];

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let existing: string[] = [];

function fake() {
  hits = []; existing = [...REGISTERED_IDS];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (p.endsWith(`/workbook/tables/${TABLE}/rows`) && m === "GET")
        return json({ value: existing.map((id) => ({ values: [[id, "2026-11-01"]] })) });
      if (p.endsWith(`/workbook/tables/${TABLE}/rows`) && m === "POST") { existing.push(String(body?.values?.[0]?.[0])); return json({ index: 0 }); }
      if (p.endsWith("/messages") && m === "POST") return json({ id: DRAFT });
      if (p.endsWith(`/messages/${DRAFT}/send`)) return new Response(null, { status: 202 });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}

const sends = () => hits.filter((h) => h.path.endsWith("/send"));
const rowsWritten = () => hits.filter((h) => h.method === "POST" && h.path.endsWith("/rows"));
const LIMITS: Settings["limits"] = [
  { parameter: "pH", min: 6.5, max: 8.5, unit: "pH units" },
  { parameter: "Turbidity", point: "DP1", max: 50, unit: "NTU" },
];
const SETTINGS: Settings = { business_name: "Example Mining Co", microsoft_365: { mailbox: BOX, register: { drive: "D1", item: "I1", table: TABLE }, qc_email: QC }, limits: LIMITS };
const NOW = new Date("2026-11-09T00:00:00Z");

const rd = (id: string, over: Partial<Reading> = {}): Reading => ({
  key: keyOf(id), id, site: "North outfall", point: "DP1", parameter: "pH", date: "2026-11-08", value: 7.2, unit: "pH units",
  source: "lab report LR-101", status: "new", ...over,
});

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { M365_ACCESS_TOKEN: "ms", KIT_ALLOW_WRITES: "1" });
});

test("register: a complete result is written once, an incomplete one is written as needs-check, nothing is sent", async () => {
  const store = new MemoryStore();
  await store.put("readings", keyOf("reading-1"), rd("reading-1"));
  await store.put("readings", keyOf("reading-2"), rd("reading-2", { unit: "" }));
  const ctx = context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await register(ctx), { registered: 2, skipped: 0, needs_check: 1 });
  assert.equal(rowsWritten().length, 2);
  assert.equal(sends().length, 0, "nothing sent by a cron");
  assert.equal((await store.get<Reading>("readings", keyOf("reading-2")))?.status, "needs-check");
  assert.equal((await store.get<Reading>("readings", keyOf("reading-1")))?.status, "registered");
  assert.deepEqual(await register(ctx), { registered: 0, skipped: 0, needs_check: 0 });
  assert.equal(rowsWritten().length, 2, "re-runs never write a row twice");
});

test("register: a result whose row is already on the register is marked registered, not written again", async () => {
  const store = new MemoryStore();
  await store.put("readings", keyOf("env-old-1"), rd("env-old-1"));
  assert.deepEqual(await register(context(WF, SETTINGS, store, NOW, () => {})), { registered: 0, skipped: 1, needs_check: 0 });
  assert.equal(rowsWritten().length, 0);
  assert.equal((await store.get<Reading>("readings", keyOf("env-old-1")))?.status, "registered");
});

test("register: a cell that starts with a formula character is written as text", async () => {
  const store = new MemoryStore();
  await store.put("readings", keyOf("reading-f"), rd("reading-f", { source: "=HYPERLINK(\"http://x\")" }));
  await register(context(WF, SETTINGS, store, NOW, () => {}));
  const row = rowsWritten()[0].body.values[0] as unknown[];
  assert.equal(row[7], "'=HYPERLINK(\"http://x\")");
});

test("review: out-of-limit and unlimited results are listed in one draft, the send is only queued, then sent on approval", async () => {
  const store = new MemoryStore();
  await store.put("readings", keyOf("ph-high"), rd("ph-high", { value: 9.1, status: "registered" }));
  await store.put("readings", keyOf("ph-ok"), rd("ph-ok", { value: 7.2, status: "registered" }));
  await store.put("readings", keyOf("dust-1"), rd("dust-1", { parameter: "PM10", value: 12, unit: "ug/m3", status: "registered" }));
  const ctx = context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await review(ctx), { flagged: 2, checked: 1 });
  assert.equal(sends().length, 0, "nothing sent by a cron");
  const drafts = hits.filter((h) => h.method === "POST" && h.path.endsWith("/messages"));
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].body.toRecipients[0].emailAddress.address, QC);
  assert.equal((await store.get<Reading>("readings", keyOf("ph-ok")))?.status, "checked");
  const high = await store.get<Reading>("readings", keyOf("ph-high"));
  assert.equal(high?.status, "needs-check");
  assert.match(high?.issue ?? "", /above the maximum 8\.5/);
  assert.deepEqual(await review(ctx), { flagged: 0, checked: 0 });
  const pending = Object.values(await store.list<any>("approvals"));
  assert.equal(pending.length, 1);
  const ap = await approve(WF, store, pending[0].id, "owner", NOW);
  assert.equal(ap.status, "done");
  assert.equal(sends().length, 1, "the send runs only after approval");
});

test("review: a value that is text, such as a below-detection result, is listed for a check and never passed", async () => {
  const store = new MemoryStore();
  await store.put("readings", keyOf("turb-lt"), rd("turb-lt", { parameter: "Turbidity", unit: "NTU", value: "<0.5", status: "registered" }));
  assert.deepEqual(await review(context(WF, SETTINGS, store, NOW, () => {})), { flagged: 1, checked: 0 });
  assert.match((await store.get<Reading>("readings", keyOf("turb-lt")))?.issue ?? "", /missing value/);
});

test("the workflow cannot draft a live operation", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "microsoft-365", op: "users.user.messages.message.send", summary: "x" }), /not a draft operation/);
});
