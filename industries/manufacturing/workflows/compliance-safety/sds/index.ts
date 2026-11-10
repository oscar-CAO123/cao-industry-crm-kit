// The SDS workflow's three crons. Each reads and drafts; nothing is sent, published or queued.
// A draft row is the register's own data laid out for the person who authors and checks the SDS. Hazard data is never
// invented: a field the register does not hold is listed as missing, and a person classifies and writes the sections.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../core/workflows/runtime.ts";
import { ids, readTable, createDraft } from "./adapters/airtable.ts";
import { type Chemical, type Row, type Settings, COL, REQUIRED } from "./types.ts";

const text = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, 500) : "");
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 864e5;

/** A date from the register as a UTC midnight timestamp, or null. Only a real calendar date counts. */
function dateOf(v: unknown): number | null {
  const s = text(v);
  if (!ISO.test(s)) return null;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s ? t : null;
}

/** Every 30 minutes: new chemical rows from the Chemicals table (status "New", or blank). */
export async function intake(ctx: Ctx<Settings>) {
  ids(ctx.settings);
  let added = 0;
  for (const row of await readTable(ctx, ctx.settings.airtable.chemicals_table)) {
    const name = text(row.fields[COL.product]);
    const status = text(row.fields[COL.status]).toLowerCase();
    if (!name || (status && status !== "new")) continue;
    if (await ctx.store.get("chemicals", row.id)) continue;
    await ctx.store.put("chemicals", row.id, { id: row.id, name, status: "new", seen: ctx.now.toISOString() } satisfies Chemical);
    added++;
  }
  ctx.log(`intake: ${added} new`);
  return { added };
}

/** The SDS draft fields for one chemical, and the list of what the register does not hold yet. */
export function sdsFields(row: Row): { fields: Record<string, unknown>; missing: string[] } {
  const f = row.fields;
  const missing: string[] = [];
  for (const c of REQUIRED) if (!text(f[c])) missing.push(`${c} blank`);
  for (const c of [COL.issued, COL.review]) if (text(f[c]) && dateOf(f[c]) === null) missing.push(`${c} is not a date (YYYY-MM-DD)`);
  const fields: Record<string, unknown> = {
    [COL.product]: text(f[COL.product]),
    [COL.draftType]: "SDS draft",
    [COL.supplier]: text(f[COL.supplier]),
    [COL.version]: text(f[COL.version]),
    [COL.issued]: text(f[COL.issued]),
    [COL.review]: text(f[COL.review]),
    [COL.signal]: text(f[COL.signal]),
    [COL.hazards]: text(f[COL.hazards]),
    [COL.precautions]: text(f[COL.precautions]),
    [COL.pictograms]: text(f[COL.pictograms]),
    [COL.storage]: text(f[COL.storage]),
    [COL.ppe]: text(f[COL.ppe]),
    [COL.missing]: missing.join("; ") || "None",
    [COL.draftStatus]: missing.length ? "Needs data" : "Ready to check",
  };
  return { fields, missing };
}

/** Every 30 minutes: one draft row per new chemical, in the Drafts table. A chemical is drafted once. */
export async function draft(ctx: Ctx<Settings>) {
  ids(ctx.settings);
  const todo = Object.values(await ctx.store.list<Chemical>("chemicals")).filter((c) => c.status === "new");
  if (!todo.length) return { drafted: 0, needs_data: 0 };
  const rows = new Map((await readTable(ctx, ctx.settings.airtable.chemicals_table)).map((r) => [r.id, r]));
  let drafted = 0, needs = 0;
  for (const c of todo) {
    const row = rows.get(c.id);
    if (!row) { ctx.log(`draft: ${c.name} is no longer in the register, skipped`); continue; }
    const d = sdsFields(row);
    if (d.missing.length) needs++;
    const id = await createDraft(ctx, d.fields);
    await ctx.store.put("chemicals", c.id, { ...c, status: "drafted", draft: id } satisfies Chemical);
    drafted++;
  }
  ctx.log(`draft: ${drafted} drafted, ${needs} need data`);
  return { drafted, needs_data: needs };
}

/** Daily: a chemical whose review date has passed, or falls within the window, gets one "Review due" row in the Drafts table. */
export async function currency(ctx: Ctx<Settings>) {
  ids(ctx.settings);
  const windowMs = (ctx.settings.review_window_days ?? 30) * DAY;
  const today = Date.parse(`${ctx.now.toISOString().slice(0, 10)}T00:00:00Z`);
  let flagged = 0;
  for (const row of await readTable(ctx, ctx.settings.airtable.chemicals_table)) {
    const name = text(row.fields[COL.product]);
    const review = dateOf(row.fields[COL.review]);
    if (!name || text(row.fields[COL.status]).toLowerCase() === "retired" || review === null || review - today > windowMs) continue;
    const key = safeKey(`review:${row.id}:${text(row.fields[COL.review])}`);
    if (await ctx.store.get("reviews", key)) continue;
    const overdue = review < today;
    await createDraft(ctx, {
      [COL.product]: name,
      [COL.draftType]: "Review due",
      [COL.supplier]: text(row.fields[COL.supplier]),
      [COL.version]: text(row.fields[COL.version]),
      [COL.review]: text(row.fields[COL.review]),
      [COL.note]: overdue ? "Review date has passed: get the supplier's current SDS and check it" : "Review date is within the window: get the supplier's current SDS and check it",
      [COL.draftStatus]: overdue ? "Review overdue" : "Review due soon",
    });
    await ctx.store.put("reviews", key, { key, row: row.id, flagged: ctx.now.toISOString() });
    flagged++;
  }
  ctx.log(`currency: ${flagged} flagged`);
  return { flagged };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { intake, draft, currency };
