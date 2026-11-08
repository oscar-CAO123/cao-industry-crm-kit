// The tenders workflow's three crons. Each is deterministic: it reads, logs, drafts and queues; it never sends.
// The judgment steps (go or no-go, takeoff, pricing, the written submission) belong to the estimating team; see SKILL.md.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { Settings, Tender, RegisterRow } from "./types.ts";
import { EMAIL, esc, day } from "./types.ts";
import * as m365 from "./adapters/microsoft-365.ts";

const DAY = 864e5;

/** Every 30 minutes: tender notices from the mailbox, each logged once in the register. */
export async function intake(ctx: Ctx<Settings>) {
  let added = 0;
  for (const n of await m365.notices(ctx)) {
    if (await ctx.store.get<Tender>("tenders", n.ref)) continue;
    await m365.logTender(ctx, n);
    await ctx.store.put("tenders", n.ref, { ...n, status: "registered" } satisfies Tender);
    added++;
  }
  ctx.log(`intake: ${added} logged`);
  return { added };
}

const eoiHtml = (s: Settings, r: RegisterRow) =>
  `<p>Hi ${esc(r.principal || "there")},</p>`
  + `<p>Thanks for the tender notice for ${esc(r.tender)}. We would like to register our interest and receive the tender documents.</p>`
  + `<p>Could you confirm the closing date and how we lodge?</p>`
  + `<p>Regards,<br>${esc(s.business_name ?? "")}</p>`;

/** Weekday mornings: for each tender the register marks Go, draft the expression of interest and queue its send for approval. */
export async function interest(ctx: Ctx<Settings>) {
  let queued = 0;
  for (const r of await m365.registerRows(ctx)) {
    if (r.status.toLowerCase() !== "go" || !EMAIL.test(r.email)) continue;
    const t = await ctx.store.get<Tender>("tenders", r.ref);
    if (t?.status === "eoi-queued") continue;   // queued before: a cron that runs again never drafts or queues it twice
    const d = await m365.mailDraft(ctx, { to: r.email, subject: `Expression of interest: ${r.tender}`, html: eoiHtml(ctx.settings, r) });
    await ctx.queue(m365.sendAct(d.box, d.messageId, `Send expression of interest for ${r.tender} to ${r.email}`, `eoi:${r.ref}`));
    await ctx.store.put("tenders", r.ref, { ...t, ref: r.ref, title: r.tender, status: "eoi-queued" } as Tender);
    queued++;
  }
  ctx.log(`interest: ${queued} queued for approval`);
  return { queued };
}

/** Weekday mornings: one reminder draft listing tenders closing soon that are not yet submitted. */
export async function deadlines(ctx: Ctx<Settings>) {
  const warn = ctx.settings.warn_days ?? 5;
  const today = Date.parse(`${day(ctx.now)}T00:00:00Z`);
  const due: { r: RegisterRow; left: string }[] = [];
  for (const r of await m365.registerRows(ctx)) {
    if (/^(submitted|no-go)$/i.test(r.status)) continue;
    const at = /^\d{4}-\d{2}-\d{2}$/.test(r.closes) ? Date.parse(`${r.closes}T00:00:00Z`) : NaN;
    if (Number.isNaN(at)) { due.push({ r, left: "no closing date entered" }); continue; }
    const days = Math.round((at - today) / DAY);
    if (days >= 0 && days <= warn) due.push({ r, left: days === 0 ? "closes today" : `closes in ${days} day${days === 1 ? "" : "s"}` });
  }
  if (!due.length) return { reminded: 0 };
  const html = `<p>Tenders to check this week:</p><ul>${due.map((x) => `<li>${esc(x.r.tender)}, ${esc(x.left)} (status: ${esc(x.r.status || "not set")})</li>`).join("")}</ul>`;
  const to = ctx.settings.reminder_to ?? ctx.settings.microsoft_365.mailbox;
  const d = await m365.mailDraft(ctx, { to, subject: `Tenders closing within ${warn} days`, html });
  ctx.log(`deadlines: ${due.length} listed in a reminder draft`);
  return { reminded: due.length, draft: d.messageId };
}

export const CRONS = { intake, interest, deadlines };
