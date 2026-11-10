// The pminbox workflow's three crons. Each is deterministic: it reads, drafts and queues; it never sends.
// Judgment (an emergency the keyword rules missed, a reply no template covers) belongs to the agent skill in SKILL.md.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { WriteBlocked } from "../../../../../core/lib/http.ts";
import type { Category, Enquiry, Settings } from "./types.ts";
import { classify, replyFor, EMAIL, oneLine } from "./types.ts";
import * as gmail from "./adapters/google-workspace.ts";

const ORDER: Category[] = ["urgent", "maintenance", "owner", "tenant", "other"];
const LABEL: Record<Category, string> = { urgent: "Urgent", maintenance: "Maintenance", owner: "Owner", tenant: "Tenant", other: "Other", noise: "Noise" };

/** Every 15 minutes: new unread mail from the manager's inbox, sorted by keyword rules. Noise is skipped and never answered. */
export async function intake(ctx: Ctx<Settings>) {
  let added = 0;
  for (const m of await gmail.inbox(ctx)) {
    if (await ctx.store.get("enquiries", m.id)) continue;
    const category = classify(ctx.settings, m.subject, m.preview);
    await ctx.store.put("enquiries", m.id, { ...m, category, status: category === "noise" ? "skipped" : "triaged" } satisfies Enquiry);
    added++;
  }
  ctx.log(`intake: ${added} new`);
  return { added };
}

/** Every 15 minutes: where an approved template covers the mail, queue the reply for approval. Urgent mail is never queued. */
export async function draft(ctx: Ctx<Settings>) {
  const todo = Object.values(await ctx.store.list<Enquiry>("enquiries")).filter((e) => e.status === "triaged" && !e.replied);
  let queued = 0, needs_person = 0;
  for (const e of todo) {
    const text = replyFor(ctx.settings, e);
    // No template, or no address to reply to: a person answers it. One bad item never stops the run for the rest.
    if (!text || !e.sender.email || !EMAIL.test(e.sender.email)) { needs_person++; continue; }
    try {
      const approval = await gmail.queueReply(ctx, e, text);
      await ctx.store.put("enquiries", e.id, { ...e, replied: approval } satisfies Enquiry);
      queued++;
    } catch (err) {
      if (err instanceof WriteBlocked) throw err;   // a deploy that blocks writes must stop the run, not hide as "needs a person"
      needs_person++;
      ctx.log(`draft: ${e.id} could not be queued: ${String((err as Error)?.message ?? err).slice(0, 160)}`);
    }
  }
  ctx.log(`draft: ${queued} replies queued, ${needs_person} need a person`);
  return { queued, needs_person };
}

/** Daily, before the manager starts: one summary draft of the mail not yet summarised, urgent first. Noise is left out. */
export async function digest(ctx: Ctx<Settings>) {
  const to = ctx.settings.digest_to;
  if (!EMAIL.test(to ?? "")) throw new Error("pminbox: digest_to is not a valid address");
  const todo = Object.values(await ctx.store.list<Enquiry>("enquiries"))
    .filter((e) => e.status === "triaged" && !e.digested)
    .sort((a, b) => ORDER.indexOf(a.category) - ORDER.indexOf(b.category) || a.received.localeCompare(b.received));
  if (!todo.length) return { drafted: 0, items: 0 };
  const counts = ORDER.map((c) => [c, todo.filter((e) => e.category === c).length] as const).filter(([, n]) => n > 0)
    .map(([c, n]) => `${n} ${LABEL[c].toLowerCase()}`).join(", ");
  const lines = todo.map((e) => `- [${LABEL[e.category]}] ${oneLine(e.subject, 160) || "(no subject)"}, from ${oneLine(e.sender.name, 120) || "unnamed"} ${e.sender.email ?? "(no valid address)"}`);
  const text = [`Morning mail${ctx.settings.business_name ? ` for ${ctx.settings.business_name}` : ""}: ${todo.length} to look at.`, "", ...lines, "",
    "Replies waiting for approval are in the CRM approval queue. Nothing has been sent."].join("\n");
  const draftId = await gmail.draftSummary(ctx, to, `Morning mail: ${counts}`, text);
  for (const e of todo) await ctx.store.put("enquiries", e.id, { ...e, digested: ctx.now.toISOString() } satisfies Enquiry);
  ctx.log(`digest: summary draft ${draftId} with ${todo.length} items`);
  return { drafted: 1, items: todo.length, draft_id: draftId };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { intake, draft, digest };
