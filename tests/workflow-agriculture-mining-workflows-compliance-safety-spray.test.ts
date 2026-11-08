// Spray and harvest records workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord } from "../core/workflows/runtime.ts";
import { register, review } from "../industries/agriculture-mining/workflows/compliance-safety/spray/index.ts";
import { keyOf, type Settings, type SprayRecord } from "../industries/agriculture-mining/workflows/compliance-safety/spray/types.ts";
import fs from "node:fs";

const DIR = "industries/agriculture-mining/workflows/compliance-safety/spray";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const BOX = "records@example.com.au", QC = "qc@example.com.au";
const DRAFT = "AAMkDraft1";
const REGISTERED_IDS = ["spray-old-1"];

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
      if (p.endsWith("/workbook/tables/SprayHarvest/rows") && m === "GET")
        return json({ value: existing.map((id) => ({ values: [[id, "2026-11-01"]] })) });
      if (p.endsWith("/workbook/tables/SprayHarvest/rows") && m === "POST") { existing.push(String(body?.values?.[0]?.[0])); return json({ index: 0 }); }
      if (p.endsWith("/messages") && m === "POST") return json({ id: DRAFT });
      if (p.endsWith(`/messages/${DRAFT}/send`)) return new Response(null, { status: 202 });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}

const sends = () => hits.filter((h) => h.path.endsWith("/send"));
const rowsWritten = () => hits.filter((h) => h.method === "POST" && h.path.endsWith("/rows"));
const SETTINGS: Settings = { business_name: "Example Grain Co", microsoft_365: { mailbox: BOX, register: { drive: "D1", item: "I1", table: "SprayHarvest" }, qc_email: QC } };
const NOW = new Date("2026-11-09T00:00:00Z");

const rec = (id: string, over: Partial<SprayRecord> = {}): SprayRecord => ({
  key: keyOf(id), id, kind: "spray", date: "2026-11-08", field: "North 4", product: "Glyphosate 450", rate: "1.5 L/ha",
  weather: "8 km/h SW, 24 C, 55 percent", withholding_until: "2026-11-22", operator: "Sam", status: "new", ...over,
});

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { M365_ACCESS_TOKEN: "ms", KIT_ALLOW_WRITES: "1" });
});

test("register: a complete record is written once, an incomplete one is written as needs-check, nothing is sent", async () => {
  const store = new MemoryStore();
  await store.put("records", keyOf("spray-1"), rec("spray-1"));
  await store.put("records", keyOf("harvest-1"), rec("harvest-1", { kind: "harvest", product: undefined, rate: undefined, weather: undefined, withholding_until: undefined, operator: undefined, load_ref: "L-88", grade: "APW1" }));
  await store.put("records", keyOf("spray-2"), rec("spray-2", { withholding_until: undefined }));
  const ctx = context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await register(ctx), { registered: 3, skipped: 0, needs_check: 1 });
  assert.equal(rowsWritten().length, 3);
  assert.equal(sends().length, 0, "nothing sent by a cron");
  assert.equal((await store.get<SprayRecord>("records", keyOf("spray-2")))?.status, "needs-check");
  assert.equal((await store.get<SprayRecord>("records", keyOf("spray-1")))?.status, "registered");
  // A second run has nothing new to do.
  assert.deepEqual(await register(ctx), { registered: 0, skipped: 0, needs_check: 0 });
  assert.equal(rowsWritten().length, 3, "re-runs never write a row twice");
});

test("register: a record whose row is already on the register is marked registered, not written again", async () => {
  const store = new MemoryStore();
  await store.put("records", keyOf("spray-old-1"), rec("spray-old-1"));
  const ctx = context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await register(ctx), { registered: 0, skipped: 1, needs_check: 0 });
  assert.equal(rowsWritten().length, 0);
  assert.equal((await store.get<SprayRecord>("records", keyOf("spray-old-1")))?.status, "registered");
});

test("register: a cell that starts with a formula character is written as text", async () => {
  const store = new MemoryStore();
  await store.put("records", keyOf("spray-f"), rec("spray-f", { product: "=HYPERLINK(\"http://x\")" }));
  await register(context(WF, SETTINGS, store, NOW, () => {}));
  const row = rowsWritten()[0].body.values[0] as string[];
  assert.equal(row[4], "'=HYPERLINK(\"http://x\")");
});

test("review: the QC email is drafted and its send only queued, then sent once approved", async () => {
  const store = new MemoryStore();
  await store.put("records", keyOf("spray-2"), rec("spray-2", { withholding_until: undefined, status: "needs-check", missing: ["withholding_until"] }));
  const ctx = context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await review(ctx), { flagged: 1 });
  assert.equal(sends().length, 0, "nothing sent by a cron");
  const drafts = hits.filter((h) => h.method === "POST" && h.path.endsWith("/messages"));
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].body.toRecipients[0].emailAddress.address, QC);
  // A second run the same day finds the record already flagged: no second draft, no second approval.
  assert.deepEqual(await review(ctx), { flagged: 0 });
  const pending = Object.values(await store.list<any>("approvals"));
  assert.equal(pending.length, 1);
  const ap = await approve(WF, store, pending[0].id, "owner", NOW);
  assert.equal(ap.status, "done");
  assert.equal(sends().length, 1, "the send runs only after approval");
});

test("review: a record with a bad date is listed for a check, never written as complete", async () => {
  const store = new MemoryStore();
  await store.put("records", keyOf("spray-bad"), rec("spray-bad", { date: "09/11/2026" }));
  await register(context(WF, SETTINGS, store, NOW, () => {}));
  const row = rowsWritten()[0].body.values[0] as string[];
  assert.match(row[11], /^Needs check: date/);
});
