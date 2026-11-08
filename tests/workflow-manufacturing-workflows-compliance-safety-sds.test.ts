// SDS workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport, WriteBlocked } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, type WorkflowRecord } from "../core/workflows/runtime.ts";
import { intake, draft, currency, CRONS } from "../industries/manufacturing/workflows/compliance-safety/sds/index.ts";

const DIR = "industries/manufacturing/workflows/compliance-safety/sds";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const NOW = new Date("2026-11-09T01:00:00Z");
const S = { airtable: { base_id: "app12345678901234", chemicals_table: "tbl00000000000001", drafts_table: "tbl00000000000002" } };

const FULL = { Supplier: "Example Supplier", "SDS version": "3.1", "Issue date": "2026-06-01", "Review date": "2027-06-01",
  "Signal word": "Warning", "Hazard statements": "H315, H319", "Precautionary statements": "P264, P280", Pictograms: "GHS07",
  Storage: "Bunded cabinet, bay 2", PPE: "Gloves, goggles" };
const CHEMICALS = [
  { id: "rec00000000000001", fields: { Product: "Degreaser A", Status: "New", ...FULL } },
  { id: "rec00000000000002", fields: { Product: "Caustic Soda 50%", Status: "New", ...FULL, "SDS version": "", "Review date": "2026-11-20",
      "Signal word": "Danger", "Hazard statements": "H314", Storage: "", PPE: "Face shield" } },
  { id: "rec00000000000003", fields: { Product: "Solvent B", Status: "Current", ...FULL, "Review date": "2026-08-01" } },
  { id: "rec00000000000004", fields: { Product: "Lube oil", Status: "", ...FULL, "Issue date": "1 Nov 2026", "Review date": "" } },
  { id: "rec00000000000005", fields: { Product: "Old Glue", Status: "Retired", ...FULL, "Review date": "2026-10-01" } },
];

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let created: Record<string, unknown>[] = [];

function fake() {
  hits = []; created = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
      if (p.endsWith(`/${S.airtable.chemicals_table}`)) return json({ records: CHEMICALS });
      if (p.endsWith(`/${S.airtable.drafts_table}`) && m === "POST") {
        const rows = body?.records ?? [];
        created.push(...rows.map((r: any) => r.fields));
        return json({ records: rows.map((_: unknown, i: number) => ({ id: "rec" + String(created.length - rows.length + i).padStart(14, "0"), fields: {} })) });
      }
      return json({ error: "unexpected" }, 404);
    }) as typeof fetch,
  });
}

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { AIRTABLE_ACCESS_TOKEN: "pat-test-token", KIT_ALLOW_WRITES: "1" });
});

test("crons are the entries the workflow record names, and nothing is live", () => {
  assert.deepEqual(Object.keys(CRONS).sort(), WF.crons.map((c) => c.entry).sort());
  assert.equal(WF.id, "manufacturing:sds");
  assert.deepEqual(WF.live_ops, {});
});

test("intake records each new chemical once, and skips rows that are not new", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await intake(ctx), { added: 3 });
  assert.deepEqual(await intake(ctx), { added: 0 });
  assert.ok(hits.every((h) => h.method === "GET" && h.path.endsWith(`/${S.airtable.chemicals_table}`)));
});

test("draft writes one SDS row per new chemical, lists what is missing, and never invents hazard data", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await intake(ctx);
  assert.deepEqual(await draft(ctx), { drafted: 3, needs_data: 2 });
  const [degreaser, caustic, lube] = created;

  assert.equal(degreaser.Product, "Degreaser A");
  assert.equal(degreaser["Draft type"], "SDS draft");
  assert.equal(degreaser["Hazard statements"], "H315, H319");
  assert.equal(degreaser["Missing data"], "None");
  assert.equal(degreaser["Draft status"], "Ready to check");

  assert.match(String(caustic["Missing data"]), /SDS version blank/);
  assert.match(String(caustic["Missing data"]), /Storage blank/);
  assert.equal(caustic["Draft status"], "Needs data");

  assert.match(String(lube["Missing data"]), /Issue date is not a date \(YYYY-MM-DD\)/);
  assert.match(String(lube["Missing data"]), /Review date blank/);
  assert.equal(lube["Draft status"], "Needs data");
});

test("a re-run never writes a second SDS row for a chemical", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await intake(ctx); await draft(ctx);
  const before = created.length;
  assert.deepEqual(await draft(ctx), { drafted: 0, needs_data: 0 });
  assert.equal(created.length, before);
});

test("currency flags a review date that has passed or falls within 30 days, once, and skips retired and distant ones", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await currency(ctx), { flagged: 2 });
  const due = created.filter((r) => r["Draft type"] === "Review due");
  assert.deepEqual(due.map((r) => [r.Product, r["Draft status"]]), [["Caustic Soda 50%", "Review due soon"], ["Solvent B", "Review overdue"]]);
  assert.ok(due.every((r) => /get the supplier's current SDS/.test(String(r.Note))));
  assert.deepEqual(await currency(ctx), { flagged: 0 }, "a review date is flagged once");
  assert.equal(created.length, 2);
});

test("crons only read, and write only to the drafts table", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await intake(ctx); await draft(ctx); await currency(ctx);
  assert.ok(hits.every((h) => h.method === "GET" || (h.method === "POST" && h.path.endsWith(`/${S.airtable.drafts_table}`))));
});

test("a live operation is only ever queued, and no write goes out without KIT_ALLOW_WRITES", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await assert.rejects(ctx.queue({ platform: "airtable", op: "docs.post_baseId_tableIdOrName", summary: "x", input: {} }), /not a live operation/);
  process.env.KIT_ALLOW_WRITES = "0";
  await intake(ctx);
  await assert.rejects(draft(ctx), WriteBlocked);
  assert.equal(created.length, 0);
});

test("a malformed id is refused before any request is made", async () => {
  const bad = { airtable: { ...S.airtable, base_id: "../../etc" } };
  const ctx = context(WF, bad, new MemoryStore(), NOW, () => {});
  await assert.rejects(intake(ctx), /base_id/);
  assert.equal(hits.length, 0);
});
