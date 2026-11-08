// Investment maths workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport, WriteBlocked } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, type WorkflowRecord } from "../core/workflows/runtime.ts";
import { propertyFacts, cashFlowNote, analyse } from "../industries/real-estate/workflows/sales/investment/index.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/real-estate/workflows/sales/investment/workflow.json", "utf8")) as WorkflowRecord;
const VID = 123456, DID = "2000000000";
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
      const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
      if (/\/properties\/\d+\/notes$/.test(p) && m === "POST") return json({ id: 9001 }, 201);
      if (/\/api\/v1\.3\/properties\/\d+$/.test(p) && m === "GET") return json({ id: VID, address: { display: "12 Example St" } });
      if (/\/v1\/properties\/[^/]+\/priceEstimate$/.test(p) && m === "GET") return json({ lower: 760000, upper: 840000 });
      return new Response("not faked: " + m + " " + p, { status: 404 });
    }) as any,
  });
}
const writes = () => hits.filter((h) => h.method !== "GET");
const WATCH = {
  id: "example-st-12", address: "12 Example St, Suburb NSW 2000", vaultre_property_id: VID, domain_property_id: DID,
  assumptions: { price: 800000, weekly_rent: 800, annual_costs: 6000, loan_amount: 600000, loan_rate_pct: 6 },
};
const SETTINGS: any = { business_name: "Test Buyers Agency", note_type_id: 1, watchlist: [WATCH] };
const NOW = new Date("2026-11-09T21:00:00Z");

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { VAULTRE_ACCESS_TOKEN: "vt", VAULTRE_API_KEY: "vk", DOMAIN_API_KEY: "dk", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a cron cannot draft a non-draft operation or queue a draft one", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "vaultre", op: "deleteProperty", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "vaultre", op: "addPropertyNote", summary: "x" }), /not a live operation/);
  assert.deepEqual(WF.live_ops, {}, "this workflow has no live operations");
});

test("analyse: yield and interest-only cash flow from the assumptions", () => {
  assert.deepEqual(analyse(WATCH.assumptions), { gross_yield_pct: 5.2, cash_flow_year: -400 });
  assert.deepEqual(analyse({ price: 500000, weekly_rent: 600, annual_costs: 4000 }), { gross_yield_pct: 6.24, cash_flow_year: 27200 });
});

test("analyse: refuses assumptions that are not numbers in range", () => {
  assert.throws(() => analyse({ ...WATCH.assumptions, price: 0 }), /price/);
  assert.throws(() => analyse({ ...WATCH.assumptions, loan_rate_pct: 45 }), /loan_rate_pct/);
  assert.throws(() => analyse({ ...WATCH.assumptions, weekly_rent: "lots" as any }), /weekly_rent/);
});

test("property-facts reads VaultRE and Domain only, and sends nothing", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await propertyFacts(ctx), { read: 1 });
  assert.equal(writes().length, 0, "no writes from the read cron");
  assert.ok(hits.some((h) => h.path.endsWith(`/properties/${VID}`)), "VaultRE property read");
  assert.ok(hits.some((h) => h.path.endsWith(`/v1/properties/${DID}/priceEstimate`)), "Domain price estimate read");
  const facts = await store.get<any>("facts", WATCH.id);
  assert.equal(facts.vaultre_found, true);
  assert.deepEqual(facts.price_estimate, { lower: 760000, upper: 840000 });
});

test("cash-flow-note drafts one note on the property, never twice for the same inputs", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await propertyFacts(ctx);
  assert.deepEqual(await cashFlowNote(ctx), { noted: 1, skipped: 0 });
  assert.equal(writes().length, 1, "one write: the property note");
  const note = writes()[0];
  assert.equal(note.method, "POST");
  assert.ok(note.path.endsWith(`/properties/${VID}/notes`));
  assert.equal(note.body.type, 1);
  assert.equal(note.body.readOnly, false);
  assert.match(note.body.body, /Gross yield 5\.2%/);
  assert.match(note.body.body, /-\$400/);

  assert.deepEqual(await cashFlowNote(ctx), { noted: 0, skipped: 1 }, "a re-run with the same inputs files nothing");
  assert.equal(writes().length, 1);

  SETTINGS.watchlist[0].assumptions.weekly_rent = 900;
  assert.deepEqual(await cashFlowNote(ctx), { noted: 1, skipped: 0 }, "a changed assumption files a new note");
  assert.equal(writes().length, 2);
  SETTINGS.watchlist[0].assumptions.weekly_rent = 800;
});

test("cash-flow-note skips a watch with no facts yet, and writes nothing", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  assert.deepEqual(await cashFlowNote(ctx), { noted: 0, skipped: 1 });
  assert.equal(writes().length, 0);
});

test("a bad watch id is refused before any call", async () => {
  const ctx = context(WF, { ...SETTINGS, watchlist: [{ ...WATCH, id: "../etc" }] }, new MemoryStore(), NOW, () => {});
  await assert.rejects(propertyFacts(ctx), /watch id/);
  assert.equal(hits.length, 0);
});

test("the write gate still blocks the note when the deploy does not allow writes", async () => {
  process.env.KIT_ALLOW_WRITES = "0";
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await store.put("facts", WATCH.id, { watch: WATCH.id, checked: NOW.toISOString(), vaultre_found: true });
  await assert.rejects(cashFlowNote(ctx), WriteBlocked);
  assert.equal(writes().length, 0);
});
