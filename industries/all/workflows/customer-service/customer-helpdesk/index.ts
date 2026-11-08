// The customer-helpdesk workflow's three crons. Each reads, matches and queues; none sends.
// A reply goes out only after a person approves it in the CRM shell. Questions the business's own answers do not cover
// stay with a person (the agent skill in SKILL.md works them).
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { Adapter, Enquiry, Platform, Settings } from "./types.ts";
import { checkSettings, hit } from "./types.ts";
import { front } from "./adapters/front.ts";
import { gorgias } from "./adapters/gorgias.ts";

export const ADAPTERS: Record<Platform, Adapter> = { front, gorgias };
const HOUR = 3600e3;
const DEFAULT_ESCALATE = ["refund", "complaint", "injur", "lawyer", "legal", "chargeback", "unsafe", "urgent"];
const adapter = (p: string): Adapter => {
  const a = ADAPTERS[p as Platform];
  if (!a) throw new Error(`customer-helpdesk: unknown source ${p}`);
  return a;
};

/** Every 10 minutes: new open questions from each source, within the lookback window. Read only. */
export async function intake(ctx: Ctx<Settings>) {
  checkSettings(ctx.settings);
  const since = ctx.now.getTime() - (ctx.settings.lookback_hours ?? 24) * HOUR;
  let added = 0;
  for (const p of new Set(ctx.settings.sources)) {
    for (const r of await adapter(p).inbox(ctx)) {
      if (Date.parse(r.received) < since) continue;                         // old backlog is not answered automatically
      if (await ctx.store.get("enquiries", r.id)) continue;                 // already seen: intake never adds it twice
      await ctx.store.put("enquiries", r.id, { ...r, status: "new" } satisfies Enquiry);
      added++;
    }
  }
  ctx.log(`intake: ${added} new`);
  return { added };
}

/** Every 15 minutes: escalate sensitive questions, queue approved answers for approval, park the rest for a person. */
export async function draft(ctx: Ctx<Settings>) {
  checkSettings(ctx.settings);
  const escalateWords = ctx.settings.escalate ?? DEFAULT_ESCALATE;
  const todo = Object.values(await ctx.store.list<Enquiry>("enquiries"))
    .filter((e) => e.status === "new")
    .sort((a, b) => a.received.localeCompare(b.received))
    .slice(0, ctx.settings.per_run_limit ?? 20);
  let queued = 0, escalated = 0, parked = 0;
  for (const e of todo) {
    const a = adapter(e.source);
    const text = `${e.subject} ${e.question}`;
    const park = async (status: "escalated" | "needs-answer", reason: string) => {
      await ctx.store.put("enquiries", e.id, { ...e, status, reason } satisfies Enquiry);
    };
    if (hit(escalateWords, text)) {
      await a.escalate(ctx, e);
      await park("escalated", "an escalation word is in the question: a person answers");
      escalated++;
      continue;
    }
    const rule = (ctx.settings.answers ?? []).find((r) => hit(r.match, text));
    if (!rule) { await park("needs-answer", "no answer rule matches: a person or the agent skill answers it"); parked++; continue; }
    const answer = await a.knowledge(ctx, rule);
    if (!answer) { await park("needs-answer", `rule "${rule.name}" has no usable published ${e.source} article or macro`); parked++; continue; }
    const withSig = ctx.settings.signature ? `${answer.text}\n\n${ctx.settings.signature}` : answer.text;
    const approval = await a.queueReply(ctx, { ...e, rule: rule.name }, { text: withSig });
    await ctx.store.put("enquiries", e.id, { ...e, status: "answer-queued", rule: rule.name, approval } satisfies Enquiry);
    queued++;
  }
  ctx.log(`draft: ${queued} queued for approval, ${escalated} escalated, ${parked} need a person`);
  return { queued, escalated, needs_answer: parked };
}

/** Hourly: remind the teammate about a waiting question once it is older than the chase window. Internal only. */
export async function chase(ctx: Ctx<Settings>) {
  checkSettings(ctx.settings);
  const after = (ctx.settings.chase_after_hours ?? 4) * HOUR;
  let chased = 0;
  for (const e of Object.values(await ctx.store.list<Enquiry>("enquiries"))) {
    if (e.status !== "needs-answer" || e.chased) continue;
    const a = adapter(e.source);
    if (!a.chase || ctx.now.getTime() - Date.parse(e.received) < after) continue;
    await a.chase(ctx, e);
    await ctx.store.put("enquiries", e.id, { ...e, chased: ctx.now.toISOString() } satisfies Enquiry);
    chased++;
  }
  ctx.log(`chase: ${chased} reminders set`);
  return { chased };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { intake, draft, chase };
