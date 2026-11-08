// The call-insights workflow's three crons. Each is deterministic: it reads and writes only this workflow's own store.
// No cron calls a write operation or queues an approval, because the workflow maps no live operation.
// Judgment (reading each call for pains, objections, offers and buying signals) belongs to the agent skill in SKILL.md,
// which writes one insight per call into the store. The tag cron keeps only the quotes that appear in the call.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { type CallRecord, type Category, type Finding, type Quote, type Settings, CATEGORIES } from "./types.ts";
import * as fireflies from "./adapters/fireflies.ts";
import * as hubspot from "./adapters/hubspot.ts";

const MAX_PER_RUN = 20;
const MAX_ITEMS = 10;

/** Case and spacing do not count when a quote is checked against the call. */
const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** An item the cron keeps: a quote of 8 to 300 characters that appears in the call, a note of 1 to 300, an optional speaker. */
function keepQuote(q: any, callText: string): boolean {
  return !!q && typeof q.quote === "string" && typeof q.note === "string"
    && q.quote.length >= 8 && q.quote.length <= 300 && callText.includes(norm(q.quote))
    && q.note.length >= 1 && q.note.length <= 300
    && (q.speaker === undefined || (typeof q.speaker === "string" && q.speaker.length <= 80));
}

/** Checks one insight against its call. Every category must be a list of at most ten items; items that are not in the call are dropped and counted. */
export function checkInsight(ins: any, transcript: string): { categories: Record<Category, Quote[]>; dropped: number } | undefined {
  if (!ins || typeof ins !== "object") return undefined;
  const text = norm(transcript);
  const categories = {} as Record<Category, Quote[]>;
  let dropped = 0;
  for (const c of CATEGORIES) {
    const items = ins[c];
    if (!Array.isArray(items) || items.length > MAX_ITEMS) return undefined;
    categories[c] = [];
    for (const q of items) {
      if (keepQuote(q, text)) categories[c].push({ quote: q.quote, speaker: q.speaker, note: q.note });
      else dropped++;
    }
  }
  return { categories, dropped };
}

/** Every 30 minutes: new Fireflies transcripts, stored once each. Reads only. */
export async function capture(ctx: Ctx<Settings>) {
  const max = Math.min(ctx.settings.max_calls_per_run ?? MAX_PER_RUN, 50);
  const since = (await ctx.store.get<{ since: string }>("state", "capture-fireflies"))?.since;
  const found = await fireflies.recent(ctx, since, max);
  let added = 0, newest = since;
  for (const c of found) {
    if (await ctx.store.get("calls", c.key)) continue;
    await ctx.store.put("calls", c.key, c);
    added++;
    if (!newest || c.happened > newest) newest = c.happened;
  }
  if (newest) await ctx.store.put("state", "capture-fireflies", { since: newest });
  ctx.log(`capture: ${added} new calls`);
  return { added };
}

/** Daily: for each call the agent has read, keep the quotes that appear in the call and record the finding. No platform call. */
export async function tag(ctx: Ctx<Settings>) {
  const calls = Object.values(await ctx.store.list<CallRecord>("calls"));
  const insights = await ctx.store.list<any>("insights");
  const findings = await ctx.store.list<Finding>("findings");
  let tagged = 0, dropped = 0;
  for (const c of calls) {
    if (findings[c.key]) continue;
    const ins = insights[c.key];
    if (!ins) continue;
    const checked = checkInsight(ins, c.transcript);
    if (!checked) { ctx.log(`tag: ${c.key} has an invalid insight, skipped`); continue; }
    dropped += checked.dropped;
    await ctx.store.put("findings", c.key, {
      key: c.key, call: c.key, ref: c.ref, title: c.title, happened: c.happened,
      categories: checked.categories, validated: ctx.now.toISOString(),
    } satisfies Finding);
    tagged++;
  }
  ctx.log(`tag: ${tagged} calls tagged, ${dropped} quotes dropped (not in the call)`);
  return { tagged, dropped };
}

/** Daily: for each tagged call, look up its outside attendees as HubSpot contacts and keep the ids. Reads only; off unless match_crm is set. */
export async function match(ctx: Ctx<Settings>) {
  if (ctx.settings.match_crm !== "hubspot") { ctx.log("match: no CRM set, nothing looked up"); return { matched: 0, contacts: 0 }; }
  const findings = Object.values(await ctx.store.list<Finding>("findings"));
  const calls = await ctx.store.list<CallRecord>("calls");
  let matched = 0, contacts = 0;
  for (const f of findings) {
    const c = calls[f.call];
    if (!c || c.matched) continue;
    const ids = new Set<string>();
    for (const email of c.attendees.slice(0, 5)) for (const id of await hubspot.contactsFor(ctx, email)) ids.add(id);
    await ctx.store.put("calls", c.key, { ...c, matched: ctx.now.toISOString(), contact_ids: [...ids] });
    contacts += ids.size;
    matched++;
  }
  ctx.log(`match: ${matched} calls looked up, ${contacts} contacts found`);
  return { matched, contacts };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { capture, tag, match };
