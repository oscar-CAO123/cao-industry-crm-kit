// The landing-pages workflow's three crons. inventory and results only read the platforms. queue turns each requested
// page content change into one approval. Nothing here publishes: a person publishes the page in Webflow.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { type Change, type FormRow, type Platform, type Results, type Settings, DAY, GHL_ID, WEBFLOW_ID, days, iso, keyOf } from "./types.ts";
import { webflow } from "./adapters/webflow.ts";
import { gohighlevel } from "./adapters/gohighlevel.ts";

const sources = (s: Settings): Platform[] => {
  const out: Platform[] = [];
  if (s.webflow) out.push("webflow");
  if (s.gohighlevel) out.push("gohighlevel");
  if (!out.length) throw new Error("landing-pages: set webflow or gohighlevel in settings");
  return out;
};

/** A change is only queued when it is complete and its ids are the platform's own shape. */
export function changeProblem(c: Change, s: Settings): string | undefined {
  if (c.platform !== "webflow") return "only Webflow page changes are queued by this workflow";
  if (!s.webflow) return "settings.webflow is not set";
  if (!WEBFLOW_ID.test(String(s.webflow.site_id))) return "settings.webflow.site_id is not a Webflow site id";
  if (!s.webflow.locale_id) return "settings.webflow.locale_id is not set (a Webflow content update needs the locale)";
  if (!WEBFLOW_ID.test(String(c.page_id))) return "page id is not a Webflow page id";
  if (!Array.isArray(c.nodes) || c.nodes.length < 1 || c.nodes.length > 200) return "nodes must be a list of 1 to 200 DOM nodes";
  if (c.nodes.some((n) => !n || typeof n !== "object" || typeof n.id !== "string" || n.id.length > 64)) return "every node needs a string id of 64 characters or fewer";
  return undefined;
}

/** Every 6 hours: list the pages and forms on each platform the business uses, for the owner's view. Reads only. */
export async function inventory(ctx: Ctx<Settings>) {
  let pages = 0, forms = 0;
  for (const p of sources(ctx.settings)) {
    const got = p === "webflow" ? await webflow.inventory(ctx) : await gohighlevel.inventory(ctx);
    for (const x of got.pages) { await ctx.store.put("pages", keyOf(`${p}:${x.id}`), x); pages++; }
    for (const x of got.forms) { await ctx.store.put("forms", keyOf(`${p}:${x.id}`), x); forms++; }
  }
  ctx.log(`inventory: ${pages} pages, ${forms} forms`);
  return { pages, forms };
}

/** Daily: count each form's submissions over the last N days, for the owner's review. Reads only. */
export async function results(ctx: Ctx<Settings>) {
  const since = iso(new Date(ctx.now.getTime() - days(ctx.settings) * DAY));
  let counted = 0;
  for (const f of Object.values(await ctx.store.list<FormRow>("forms"))) {
    const n = f.platform === "webflow" ? await webflow.submissions(ctx, f, since) : await gohighlevel.submissions(ctx, f, since);
    const row: Results = { platform: f.platform, form_id: f.id, form: f.name, since, submissions: n, seen: ctx.now.toISOString() };
    await ctx.store.put("results", keyOf(`${f.platform}:${f.id}`), row);
    counted++;
  }
  ctx.log(`results: ${counted} forms counted since ${since}`);
  return { forms: counted };
}

/** Every 30 minutes: each requested content change becomes one approval. Queues only; a person approves it in the CRM shell. */
export async function queue(ctx: Ctx<Settings>) {
  const todo = Object.values(await ctx.store.list<Change>("changes")).filter((c) => c.status === "requested");
  let queued = 0, skipped = 0;
  for (const c of todo) {
    const why = changeProblem(c, ctx.settings);
    if (why) { await ctx.store.put("changes", c.id, { ...c, status: "skipped", reason: why }); skipped++; continue; }
    const acts = webflow.acts(ctx, c, keyOf(`change:${c.id}`));
    const approval = await ctx.queue(acts, `Webflow page ${c.page_id}: ${c.nodes.length} content nodes. Live once approved.${c.publish ? " Publish the page in Webflow yourself: this workflow never publishes." : ""}`);
    await ctx.store.put("changes", c.id, { ...c, status: "queued", approval, reason: undefined });
    queued++;
  }
  ctx.log(`queue: ${queued} queued, ${skipped} skipped`);
  return { queued, skipped };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { inventory, results, queue };
