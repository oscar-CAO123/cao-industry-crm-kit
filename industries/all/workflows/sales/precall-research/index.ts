// The pre-call research workflow's three crons. prep reads HubSpot deals closing soon, builds a brief from HubSpot and Apollo and
// writes it once as an internal note on the deal. refresh re-reads Apollo's news and hiring for open briefs (store only).
// queue turns each brief into one approval that sets the deal's next step. Nothing reaches a customer, and nothing changes
// in HubSpot's deal record until a person approves it.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { Brief, Company, Settings } from "./types.ts";
import { DAY, checkSettings, esc, iso, questionsFor } from "./types.ts";
import { hubspot } from "./adapters/hubspot.ts";
import { apollo } from "./adapters/apollo.ts";

/** Apollo enrichment (contact and company) is re-read at most once a week per brief, because it uses credits. */
const ENRICH_DAYS = 7;

const stale = (at: string | undefined, now: Date, days: number) => !at || now.getTime() - Date.parse(at) >= days * DAY;

/** Fill only the fields that are still empty, so HubSpot's own values win. */
function fillMissing<T extends object>(base: T | undefined, extra: Partial<T>): T {
  const out: any = { ...(base ?? {}) };
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== "" && out[k] === undefined) out[k] = v;
  return out as T;
}

/** Apollo's news and hiring for a matched company. */
async function signals(ctx: Ctx<Settings>, b: Brief, now: string): Promise<void> {
  if (!b.apollo_org_id) return;
  b.news = await apollo.news(ctx, b.apollo_org_id);
  b.jobs = await apollo.jobs(ctx, b.apollo_org_id);
  b.checked.signals = now;
}

/** The brief as a plain HTML note. Every value from HubSpot, Apollo or a web page is escaped before it goes in. */
export function briefHtml(b: Brief, asOf: string): string {
  const rows: string[] = [];
  const line = (label: string, text: string) => { if (text.trim()) rows.push(`<p><strong>${esc(label)}:</strong> ${esc(text)}</p>`); };
  rows.push(`<p><strong>Pre-call brief</strong>, prepared ${esc(asOf.slice(0, 10))}. Research only: check it before you rely on it.</p>`);
  line("Deal", [b.name, b.closedate ? `closes ${b.closedate.slice(0, 10)}` : "", b.stage ? `stage ${b.stage}` : "", b.amount ? `amount ${b.amount}` : ""].filter(Boolean).join(", "));
  if (b.contact) line("Contact", [b.contact.name, b.contact.title, b.contact.headline].filter(Boolean).join(", "));
  if (b.company) {
    const c: Company = b.company;
    const facts = [c.name, c.domain, c.industry, c.employees ? `${c.employees} employees` : "", c.location].filter(Boolean).join(", ");
    line("Company", c.description ? `${facts}. ${c.description}` : facts);
  }
  if (b.news.length) rows.push(`<p><strong>Recent news:</strong></p><ul>${b.news.map((a) => `<li>${esc(a.title)} (${esc(a.url)})</li>`).join("")}</ul>`);
  if (b.jobs.length) line("Hiring", b.jobs.map((j) => j.title).join("; "));
  if (b.questions.length) rows.push(`<p><strong>Questions to ask:</strong></p><ul>${b.questions.map((q) => `<li>${esc(q)}</li>`).join("")}</ul>`);
  return rows.join("");
}

/** Every 60 minutes: brief each deal that closes in the window. Writes one internal note per deal, and never again. */
export async function prep(ctx: Ctx<Settings>) {
  const s = ctx.settings;
  checkSettings(s);
  const now = ctx.now.toISOString();
  const deals = (await hubspot.openDeals(ctx)).slice(0, s.max_deals);
  let briefed = 0, noted = 0;
  for (const d of deals) {
    const prior = await ctx.store.get<Brief>("briefs", d.id);
    const b: Brief = prior ?? { deal: d.id, name: d.name, stage: d.stage, closedate: "", news: [], jobs: [], questions: [], checked: {}, first_seen: now, updated: now };
    b.name = d.name; b.stage = d.stage; b.amount = d.amount; b.closedate = iso(d.closedate) ?? b.closedate;

    const [contactId] = await hubspot.associated(ctx, d.id, "contacts");
    const [companyId] = await hubspot.associated(ctx, d.id, "companies");
    let email: string | undefined;
    if (contactId) { const c = await hubspot.contact(ctx, contactId); b.contact = c.person; email = c.email; }
    if (companyId) b.company = await hubspot.company(ctx, companyId);

    if (s.use_apollo && stale(b.checked.enriched, ctx.now, ENRICH_DAYS)) {
      const domain = b.company?.domain;
      if (email || domain) {
        const p = await apollo.person(ctx, email, domain);
        if (p) b.contact = { ...(b.contact ?? {}), title: b.contact?.title ?? p.title, headline: p.headline };
      }
      if (domain) {
        const o = await apollo.org(ctx, domain);
        b.apollo_org_id = o.id ?? b.apollo_org_id;
        b.company = fillMissing<Company>(b.company, { ...o.company, id: b.company?.id });
      }
      b.checked.enriched = now;
    }
    if (s.use_apollo && b.apollo_org_id && !b.checked.signals) await signals(ctx, b, now);

    b.questions = questionsFor(b);
    b.updated = now;
    await ctx.store.put("briefs", d.id, b);
    briefed++;

    // The note is written once. A note that was created but not yet linked to its deal is only linked on the next run.
    if (!b.noteId) { b.noteId = await hubspot.createNote(ctx, d.id, briefHtml(b, now)); await ctx.store.put("briefs", d.id, b); }
    if (!b.noteLinked) { await hubspot.linkNote(ctx, b.noteId, d.id); b.noteLinked = true; await ctx.store.put("briefs", d.id, b); noted++; }
  }
  ctx.log(`prep: ${deals.length} deals in the window, ${briefed} briefed, ${noted} notes linked`);
  return { deals: deals.length, briefed, noted };
}

/** Daily at 22:00 UTC (8 or 9 am in eastern Australia): re-read Apollo news and hiring for open briefs. Stores only; the note is a snapshot. */
export async function refresh(ctx: Ctx<Settings>) {
  const s = ctx.settings;
  checkSettings(s);
  if (!s.use_apollo) return { refreshed: 0 };
  const now = ctx.now.toISOString(), t = ctx.now.getTime();
  const open = Object.values(await ctx.store.list<Brief>("briefs"))
    .filter((b) => b.apollo_org_id && Date.parse(b.closedate) >= t)
    .slice(0, s.max_deals);
  for (const b of open) {
    await signals(ctx, b, now);
    b.questions = questionsFor(b);
    b.updated = now;
    await ctx.store.put("briefs", b.deal, b);
  }
  ctx.log(`refresh: ${open.length} open briefs re-read`);
  return { refreshed: open.length };
}

/** Daily at 22:30 UTC: queue each open brief's next step for approval. The deal changes only when a person approves it. */
export async function queue(ctx: Ctx<Settings>) {
  checkSettings(ctx.settings);
  const t = ctx.now.getTime();
  let queued = 0;
  for (const b of Object.values(await ctx.store.list<Brief>("briefs"))) {
    if (!b.noteLinked || !(Date.parse(b.closedate) >= t)) continue;
    const text = `Before the call: ${b.questions[0] ?? "read the brief note on this deal"}`;
    b.next_step_approval = await hubspot.queueNextStep(ctx, b.deal, b.closedate.slice(0, 10), text);
    await ctx.store.put("briefs", b.deal, b);
    queued++;
  }
  ctx.log(`queue: ${queued} next steps queued for approval`);
  return { queued };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { prep, refresh, queue };
