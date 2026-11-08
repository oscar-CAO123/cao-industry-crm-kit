// The complaints workflow's three crons. Each reads, categorises and queues; none sends.
// An acknowledgement goes out only after a person approves it in the CRM shell. Anything with an escalation word, or that no
// category matches, stays with a person (the agent skill in SKILL.md works the unmatched ones). Refunds are never issued here.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { Enquiry, Settings } from "./types.ts";
import { checkSettings, hit, DEFAULT_ESCALATE, HOUR } from "./types.ts";
import { gorgias } from "./adapters/gorgias.ts";

const signed = (text: string, signature?: string) => (signature ? `${text}\n\n${signature}` : text);

/** Every 10 minutes: new open tickets from the helpdesk, within the lookback window. Read only. */
export async function intake(ctx: Ctx<Settings>) {
  checkSettings(ctx.settings);
  let added = 0;
  for (const r of await gorgias.inbox(ctx)) {
    if (await ctx.store.get("enquiries", r.id)) continue;               // already seen: intake never adds it twice
    await ctx.store.put("enquiries", r.id, { ...r, status: "new" } satisfies Enquiry);
    added++;
  }
  ctx.log(`intake: ${added} new`);
  return { added };
}

/** Every 15 minutes: tag escalations for a person, record the category, and queue acknowledgements for approval. */
export async function draft(ctx: Ctx<Settings>) {
  checkSettings(ctx.settings);
  const s = ctx.settings;
  const escalateWords = s.escalate ?? DEFAULT_ESCALATE;
  const todo = Object.values(await ctx.store.list<Enquiry>("enquiries"))
    .filter((e) => e.status === "new")
    .sort((a, b) => a.received.localeCompare(b.received))
    .slice(0, s.per_run_limit ?? 20);
  let acks = 0, escalated = 0, categorised = 0, triage = 0;
  for (const e of todo) {
    const text = `${e.subject} ${e.complaint}`;
    const word = hit(escalateWords, text);
    if (word) {
      await gorgias.escalate(ctx, e);
      await ctx.store.put("enquiries", e.id, { ...e, status: "escalated", reason: `escalation word "${word}": a person handles it` } satisfies Enquiry);
      escalated++;
      continue;
    }
    const cat = s.categories.find((c) => hit(c.match, text));
    if (!cat) {
      await ctx.store.put("enquiries", e.id, { ...e, status: "needs-triage", reason: "no category matches: a person or the agent skill triages it" } satisfies Enquiry);
      triage++;
      continue;
    }
    await gorgias.setCategory(ctx, e, cat.name);
    if (!cat.ack) {
      await ctx.store.put("enquiries", e.id, { ...e, status: "categorised", category: cat.name } satisfies Enquiry);
      categorised++;
      continue;
    }
    const approval = await gorgias.queueAck(ctx, { ...e, category: cat.name }, signed(cat.ack, s.signature));
    await ctx.store.put("enquiries", e.id, { ...e, status: "ack-queued", category: cat.name, approval } satisfies Enquiry);
    acks++;
  }
  ctx.log(`draft: ${acks} acknowledgements queued, ${escalated} escalated, ${categorised} categorised, ${triage} need triage`);
  return { acknowledgements_queued: acks, escalated, categorised, needs_triage: triage };
}

/** Every hour: tag a complaint still open after the chase window, so it is not forgotten. Internal only. */
export async function overdue(ctx: Ctx<Settings>) {
  checkSettings(ctx.settings);
  const after = (ctx.settings.chase_after_hours ?? 4) * HOUR;
  const open = await gorgias.openIds(ctx);
  let tagged = 0;
  for (const e of Object.values(await ctx.store.list<Enquiry>("enquiries"))) {
    if ((e.status !== "escalated" && e.status !== "ack-queued") || e.overdue_tagged) continue;
    if (!open.has(e.ref.ticket_id)) continue;                           // closed or off the first page: nothing to do
    if (ctx.now.getTime() - Date.parse(e.received) < after) continue;
    await gorgias.overdue(ctx, e);
    await ctx.store.put("enquiries", e.id, { ...e, overdue_tagged: ctx.now.toISOString() } satisfies Enquiry);
    tagged++;
  }
  ctx.log(`overdue: ${tagged} tagged`);
  return { tagged };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { intake, draft, overdue };
