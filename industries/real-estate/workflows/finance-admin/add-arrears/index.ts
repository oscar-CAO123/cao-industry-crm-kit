// The arrears ladder's two crons. Each reads or drafts; none sends on its own.
// Every reminder is an Outlook draft plus a queued send: a person approves each one in the CRM shell.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { type Settings, type Arrear, type Reminder, DAY, DEFAULT_LADDER, day, esc, money } from "./types.ts";
import { reLeased } from "./adapters/re-leased.ts";
import { mailDraft, registerRow } from "./adapters/microsoft-365.ts";

/** The reminder days, sorted and checked. Settings are the business's own config, so only the shape is checked here. */
const ladderOf = (s: Settings): number[] => {
  const raw = s.reminder_days?.length ? s.reminder_days : DEFAULT_LADDER;
  return [...new Set(raw.filter((n) => Number.isInteger(n) && n >= 0 && n <= 365))].sort((a, b) => a - b);
};

function reminderHtml(s: Settings, a: Arrear, days: number): string {
  const hi = a.first || a.contact || "there";
  return `<p>Hi ${esc(hi)},</p>`
    + `<p>Rent of ${esc(money(a.amount))} for ${esc(a.property || a.display)} was due on ${esc(a.due)} and is ${esc(days)} day${days === 1 ? "" : "s"} overdue.</p>`
    + `<p>Please pay it today. If you are having trouble paying, reply to this email so we can agree a plan together.</p>`
    + `<p>${esc(s.business_name ?? "")}</p>`;
}

/** Daily: read the overdue invoices from Re-Leased, keep one arrears row per invoice, and add a register row for each new one. Reads and drafts only. */
export async function scan(ctx: Ctx<Settings>) {
  const today = day(ctx.now);
  let added = 0;
  for (const a of await reLeased.overdue(ctx, today)) {
    const seen = await ctx.store.get<Arrear>("arrears", a.id);
    if (seen) { await ctx.store.put("arrears", a.id, { ...seen, amount: a.amount, email: a.email }); continue; }
    await registerRow(ctx, [a.display, a.property, a.contact, a.due, money(a.amount), today]);
    await ctx.store.put("arrears", a.id, { ...a, first_seen: today } satisfies Arrear);
    added++;
  }
  ctx.log(`scan: ${added} new overdue invoices`);
  return { added };
}

/** Daily: for each overdue invoice, draft the reminder for the highest ladder step it has reached and queue the send for approval. */
export async function remind(ctx: Ctx<Settings>) {
  const today = day(ctx.now);
  const ladder = ladderOf(ctx.settings);
  let queued = 0, skipped = 0;
  for (const row of Object.values(await ctx.store.list<Arrear>("arrears"))) {
    const days = Math.round((Date.parse(today) - Date.parse(row.due)) / DAY);
    const top = ladder.reduce((best, d, i) => (days >= d ? i : best), -1);
    if (top < 0) continue;
    const step = top + 1, rkey = `${row.id}-step${step}`;
    if (await ctx.store.get("reminders", rkey)) continue; // this step already went out or is waiting for approval
    const fresh = await reLeased.invoice(ctx, row.id, today);
    if (!fresh) { skipped++; ctx.log(`remind: ${row.display} is paid or no longer owing, skipped`); continue; }
    if (!fresh.email) { skipped++; ctx.log(`remind: ${row.display} has no valid contact email, skipped`); continue; }
    const d = await mailDraft(ctx, { to: fresh.email, subject: `Rent overdue: ${fresh.display || row.display}`, html: reminderHtml(ctx.settings, fresh, days) });
    const approval = await ctx.queue({ ...d.act, key: `remind:${row.id}:${step}` },
      `rent reminder ${step} for ${fresh.display || row.display}: ${money(fresh.amount)} overdue ${days} days, to ${fresh.email}`);
    await ctx.store.put("reminders", rkey, { invoice: row.id, step, draft: d.messageId, approval, queued: today } satisfies Reminder);
    queued++;
  }
  ctx.log(`remind: ${queued} queued, ${skipped} skipped`);
  return { queued, skipped };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { scan, remind };
