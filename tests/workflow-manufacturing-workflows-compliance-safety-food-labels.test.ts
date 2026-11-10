// Food-labels workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport, WriteBlocked } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, type WorkflowRecord } from "../core/workflows/runtime.ts";
import { intake, draft, CRONS } from "../industries/manufacturing/workflows/compliance-safety/food-labels/index.ts";

const DIR = "industries/manufacturing/workflows/compliance-safety/food-labels";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const NOW = new Date("2026-11-09T01:00:00Z");
const S = { airtable: { base_id: "app12345678901234", products_table: "tbl00000000000001", recipe_table: "tbl00000000000002",
  ingredients_table: "tbl00000000000003", drafts_table: "tbl00000000000004" } };

const PRODUCTS = [
  { id: "rec00000000000001", fields: { Product: "Lemon Myrtle Biscuit", Status: "New" } },
  { id: "rec00000000000002", fields: { Product: "Plain Oat Bar", Status: "New" } },
];
const RECIPE = [
  { id: "rec00000000000011", fields: { Product: "Lemon Myrtle Biscuit", Ingredient: "Wheat flour", Grams: 50 } },
  { id: "rec00000000000012", fields: { Product: "Lemon Myrtle Biscuit", Ingredient: "Butter", Grams: 30 } },
  { id: "rec00000000000013", fields: { Product: "Lemon Myrtle Biscuit", Ingredient: "Sugar", Grams: 20 } },
  { id: "rec00000000000014", fields: { Product: "Plain Oat Bar", Ingredient: "Rolled oats", Grams: 60 } },
  { id: "rec00000000000015", fields: { Product: "Plain Oat Bar", Ingredient: "Honey", Grams: 40 } },
  { id: "rec00000000000016", fields: { Product: "Plain Oat Bar", Ingredient: "Mystery syrup", Grams: 10 } },
];
const INGREDIENTS = [
  { id: "rec00000000000021", fields: { Ingredient: "Wheat flour", "Energy (kJ)": 1500, "Protein (g)": 10, "Fat, total (g)": 1, "Saturated fat (g)": 0.2, "Carbohydrate (g)": 76, "Sugars (g)": 0.3, "Sodium (mg)": 2, Allergens: "Gluten (wheat)" } },
  { id: "rec00000000000022", fields: { Ingredient: "Butter", "Energy (kJ)": 3000, "Protein (g)": 0.6, "Fat, total (g)": 81, "Saturated fat (g)": 51, "Carbohydrate (g)": 0.1, "Sugars (g)": 0.1, "Sodium (mg)": 10, Allergens: "Milk" } },
  { id: "rec00000000000023", fields: { Ingredient: "Sugar", "Energy (kJ)": 1680, "Protein (g)": 0, "Fat, total (g)": 0, "Saturated fat (g)": 0, "Carbohydrate (g)": 100, "Sugars (g)": 100, "Sodium (mg)": 0, Allergens: "" } },
  { id: "rec00000000000024", fields: { Ingredient: "Rolled oats", "Energy (kJ)": 1600, "Protein (g)": 13, "Fat, total (g)": 6, "Saturated fat (g)": 1, "Carbohydrate (g)": 60, "Sugars (g)": 1, "Sodium (mg)": 2, Allergens: "Gluten (oats)" } },
  { id: "rec00000000000025", fields: { Ingredient: "Honey", "Energy (kJ)": 1280, "Protein (g)": 0.3, "Fat, total (g)": 0, "Saturated fat (g)": 0, "Carbohydrate (g)": 82, "Sugars (g)": 82, "Sodium (mg)": 4, Allergens: "" } },
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
      if (p.endsWith(`/${S.airtable.products_table}`)) return json({ records: PRODUCTS });
      if (p.endsWith(`/${S.airtable.recipe_table}`)) return json({ records: RECIPE });
      if (p.endsWith(`/${S.airtable.ingredients_table}`)) return json({ records: INGREDIENTS });
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

test("crons are the entries the workflow record names", () => {
  assert.deepEqual(Object.keys(CRONS).sort(), WF.crons.map((c) => c.entry).sort());
  assert.equal(WF.id, "manufacturing:food-labels");
  assert.deepEqual(WF.live_ops, {});
});

test("intake records each new product once, and reads only the products table", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await intake(ctx), { added: 2 });
  assert.deepEqual(await intake(ctx), { added: 0 });
  assert.equal(hits.length, 2);
  assert.ok(hits.every((h) => h.method === "GET" && h.path.endsWith(`/${S.airtable.products_table}`)));
});

test("draft works out the declaration, per 100 g panel and allergens, and flags missing data", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await intake(ctx);
  assert.deepEqual(await draft(ctx), { drafted: 2, needs_data: 1 });
  const [biscuit, bar] = created;

  // Biscuit: 50 g flour, 30 g butter, 20 g sugar (100 g total).
  assert.equal(biscuit.Product, "Lemon Myrtle Biscuit");
  assert.equal(biscuit["Ingredients (by weight, most first)"], "Wheat flour, Butter, Sugar");
  assert.equal(biscuit["Energy (kJ) per 100 g"], 1986);        // (1500*50 + 3000*30 + 1680*20) / 100
  assert.equal(biscuit["Protein (g) per 100 g"], 5.2);         // (10*50 + 0.6*30 + 0*20) / 100 = 5.18, one decimal
  assert.equal(biscuit["Contains"], "Gluten (wheat), Milk");
  assert.equal(biscuit["Missing data"], "None");
  assert.equal(biscuit["Draft status"], "Ready to check");

  // Oat bar: the mystery syrup has no row in the ingredients table, so every nutrient is left blank.
  assert.equal(bar["Ingredients (by weight, most first)"], "Rolled oats, Honey, Mystery syrup");
  assert.equal(bar["Energy (kJ) per 100 g"], null);
  assert.match(String(bar["Missing data"]), /Mystery syrup: not in the ingredients table/);
  assert.equal(bar["Draft status"], "Needs data");
});

test("a re-run never writes a second draft for a product", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await intake(ctx); await draft(ctx);
  const before = created.length;
  assert.deepEqual(await draft(ctx), { drafted: 0, needs_data: 0 });
  assert.equal(created.length, before);
});

test("crons only read, and write only to the drafts table", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await intake(ctx); await draft(ctx);
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
