// The regulator-lodgements workflow's three crons. Each is deterministic: it reads, drafts an internal record or note,
// and queues the one email that leaves the business for a person to approve. Nothing here lodges a report, answers a
// regulator or changes a register status: a person does those in the regulator's portal and in the register.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { approvalId } from "../../../../../core/workflows/runtime.ts";
import type { Notice, Settings } from "./types.ts";
import { day, esc } from "./types.ts";
import { notices, registerRows, addRegisterRow, ownerDraft, noticeHtml } from "./adapters/microsoft-365.ts";

const DAY = 864e5;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** A register due cell as YYYY-MM-DD. Excel may hand a date back as its serial number, so both forms are read. */
export function dueOf(v: string): string {
  if (ISO.test(v)) return v;
  const n = Number(v);
  if (/^\d{5}(\.\d+)?$/.test(v) && Number.isFinite(n)) return new Date((Math.floor(n) - 25569) * DAY).toISOString().slice(0, 10);
  return "";
}

/** Every 30 minutes: read regulator notices that arrived in the compliance mailbox and store the new ones. Read only.
 *  The notice rules are matched against the title and body preview here; the preview itself is not stored. */
export async function intake(ctx: Ctx<Settings>) {
  let added = 0;
  for (const n of await notices(ctx)) {
    if (await ctx.store.get("notices", n.id)) continue;
    const { text, ...kept } = n;
    const rule = (ctx.settings.notice_rules ?? []).find((r) => r.match && `${n.title} ${text}`.toLowerCase().includes(r.match.toLowerCase()));
    await ctx.store.put("notices", n.id, { ...kept, status: "new", due_days: rule?.due_days } satisfies Notice);
    added++;
  }
  ctx.log(`intake: ${added} new notices`);
  return { added };
}

/** Hourly: log each new notice in the lodgement register, draft an internal note to the owner, and queue that note's send.
 *  The register row is written once: a notice whose note or queue step fails is retried without a second row. */
export async function register(ctx: Ctx<Settings>) {
  const todo = Object.values(await ctx.store.list<Notice>("notices")).filter((n) => n.status === "new");
  let logged = 0;
  for (const n of todo) {
    const written = await ctx.store.get<{ due: string }>("register-rows", n.id);
    const due = written ? written.due : n.due_days === undefined ? "" : day(new Date(ctx.now.getTime() + n.due_days * DAY));
    const rec: Notice = { ...n, due, registered: ctx.now.toISOString() };
    if (!written) {
      await addRegisterRow(ctx, rec);
      await ctx.store.put("register-rows", n.id, { due, at: ctx.now.toISOString() });
    }
    const d = await ownerDraft(ctx, `Regulator notice: ${n.title}`, noticeHtml(rec, ctx.settings.business_name ?? "the business"));
    const summary = `Send to ${ctx.settings.owner_email}: regulator notice "${n.title}"${rec.due ? `, due ${rec.due}` : ", no due date set"}`;
    await ctx.queue({ ...d.act, key: `notice:${n.id}`, summary }, summary);
    await ctx.store.put("notices", n.id, { ...rec, status: "registered" });
    logged++;
  }
  ctx.log(`register: ${logged} logged`);
  return { logged };
}

/** Daily: remind the owner about each open lodgement due within the window, overdue ones included. One reminder per item per day. */
export async function reminders(ctx: Ctx<Settings>) {
  const today = day(ctx.now);
  const limit = day(new Date(ctx.now.getTime() + (ctx.settings.reminder_days ?? 7) * DAY));
  const open = (await registerRows(ctx)).filter((r) => r[5] === "Open" && dueOf(r[4] ?? "") && dueOf(r[4] ?? "") <= limit).slice(0, 20);
  let queued = 0;
  for (const [, key, title, from, due] of open) {
    const when = dueOf(due ?? "");
    const k = `remind:${key}:${today}`;
    if (await ctx.store.get("approvals", approvalId(ctx.workflow.id, k))) continue; // already drafted and queued today
    const subject = `Reminder: ${title} due ${when}`;
    const html = `<p>Lodgement due ${esc(when)}: <b>${esc(title)}</b></p><p>From: ${esc(from ?? "unknown")}</p><p>Lodge it in the regulator's portal, then mark it Lodged in the register. Nothing has been sent to the regulator.</p>`;
    const d = await ownerDraft(ctx, subject, html);
    const summary = `Send to ${ctx.settings.owner_email}: reminder for "${title}", due ${when}`;
    await ctx.queue({ ...d.act, key: k, summary }, summary);
    queued++;
  }
  ctx.log(`reminders: ${queued} queued for approval`);
  return { queued };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { intake, register, reminders };
