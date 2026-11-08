// The food-labels workflow's two crons. Each reads and drafts; nothing is sent, published or queued.
// The draft is a starting point for a person: the ingredient declaration, per 100 g panel and allergens are arithmetic
// on the tables, and every row is checked against the Food Standards Code before a label is used.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { ids, readTable, createDraft } from "./adapters/airtable.ts";
import { type Product, type Row, type Settings, COL, NUTRIENTS } from "./types.ts";

const text = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, 200) : "");
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Every 30 minutes: new product rows from the Products table (status "New", or blank). */
export async function intake(ctx: Ctx<Settings>) {
  ids(ctx.settings);
  let added = 0;
  for (const row of await readTable(ctx, ctx.settings.airtable.products_table)) {
    const name = text(row.fields[COL.product]);
    const status = text(row.fields[COL.status]).toLowerCase();
    if (!name || (status && status !== "new")) continue;
    if (await ctx.store.get("products", row.id)) continue;
    await ctx.store.put("products", row.id, { id: row.id, name, status: "new", seen: ctx.now.toISOString() } satisfies Product);
    added++;
  }
  ctx.log(`intake: ${added} new`);
  return { added };
}

/** The declaration, the per 100 g panel and the allergens for one product, from its recipe lines. */
function panel(name: string, lines: Row[], byName: Map<string, Row>): { fields: Record<string, unknown>; missing: string[] } {
  const missing: string[] = [];
  const parts: { ing: string; g: number; row?: Row }[] = [];
  for (const l of lines) {
    const ing = text(l.fields[COL.ingredient]);
    const g = Number(l.fields[COL.grams]);
    if (!ing) { missing.push("a recipe line has no ingredient name"); continue; }
    if (!Number.isFinite(g) || g <= 0 || g > 1e6) { missing.push(`${ing}: grams missing or not a positive number`); continue; }
    parts.push({ ing, g, row: byName.get(ing.toLowerCase()) });
  }
  if (!parts.length) missing.push("no recipe lines");
  for (const x of parts) if (!x.row) missing.push(`${x.ing}: not in the ingredients table`);

  const known = parts.filter((x) => x.row);
  const total = parts.reduce((a, x) => a + x.g, 0);
  const allergens = new Set<string>();
  for (const x of known) for (const a of text(x.row!.fields[COL.allergens]).split(",")) if (a.trim()) allergens.add(a.trim());

  // Weighted by grams: a nutrient per 100 g of the mix is the sum of (value per 100 g x grams) over the grams in the mix.
  const nutrients: Record<string, number | null> = {};
  for (const n of NUTRIENTS) {
    let sum = 0, complete = parts.length > 0 && known.length === parts.length;
    for (const x of known) {
      const v = x.row!.fields[n];
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) { missing.push(`${x.ing}: ${n} not set`); complete = false; continue; }
      sum += v * x.g;
    }
    nutrients[`${n} per 100 g`] = complete ? round1(sum / total) : null;
  }

  const fields: Record<string, unknown> = {
    [COL.product]: name,
    [COL.declaration]: [...parts].sort((a, b) => b.g - a.g).map((x) => x.ing).join(", "),
    [COL.contains]: [...allergens].sort().join(", ") || "No allergens listed on the ingredients",
    [COL.missing]: missing.join("; ") || "None",
    [COL.draftStatus]: missing.length ? "Needs data" : "Ready to check",
    ...nutrients,
  };
  return { fields, missing };
}

/** Every 30 minutes: one draft row per new product, in the Drafts table. A product is drafted once. */
export async function draft(ctx: Ctx<Settings>) {
  ids(ctx.settings);
  const todo = Object.values(await ctx.store.list<Product>("products")).filter((p) => p.status === "new");
  if (!todo.length) return { drafted: 0, needs_data: 0 };
  const recipe = await readTable(ctx, ctx.settings.airtable.recipe_table);
  const ingredients = await readTable(ctx, ctx.settings.airtable.ingredients_table);
  const byName = new Map<string, Row>();
  for (const r of ingredients) {
    const n = text(r.fields[COL.ingredient]).toLowerCase();
    if (n && !byName.has(n)) byName.set(n, r);
  }
  let drafted = 0, needs = 0;
  for (const p of todo) {
    const lines = recipe.filter((r) => text(r.fields[COL.product]).toLowerCase() === p.name.toLowerCase());
    const d = panel(p.name, lines, byName);
    const rowId = await createDraft(ctx, d.fields);
    if (d.missing.length) needs++;
    await ctx.store.put("products", p.id, { ...p, status: "drafted", draft: rowId } satisfies Product);
    drafted++;
  }
  ctx.log(`draft: ${drafted} drafted, ${needs} need data`);
  return { drafted, needs_data: needs };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { intake, draft };
