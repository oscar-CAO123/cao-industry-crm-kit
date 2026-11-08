// The policy renewals workflow's three crons. Each reads, drafts or queues. Nothing sends: every email is an Outlook
// draft, and its send waits in the approval queue for the broker. Judgment (what the client changed, the premium,
// what to tell the client) belongs to the broker, who works from SKILL.md.
import type { Approval, Ctx } from "../../../../../core/workflows/runtime.ts";
import { approvalId } from "../../../../../core/workflows/runtime.ts";
import { EMAIL, POLICY, DAY, esc, keyOf, day, longDate, renewalDate, type Item, type Settings } from "./types.ts";
import { listMail, readRegister, draftMail } from "./adapters/microsoft-365.ts";

const ENDORSE = /endorse|(add|remove|delete|change)\b.{0,30}\b(vehicle|car|driver|trailer)|vehicle change|car change/i;
const POLICY_NO = /policy\s*(?:no\.?|number|#)?\s*[:\-]?\s*([A-Za-z0-9][A-Za-z0-9/_-]{3,29})/i;

/** Creates the Outlook draft and queues its send. The approval key is the item's, so a re-run never queues twice. */
async function queueEmail(ctx: Ctx<Settings>, to: string, subject: string, html: string, key: string, summary: string) {
  const d = await draftMail(ctx, to, subject, html);
  const approval = await ctx.queue({ ...d.send, key }, summary);
  return { messageId: d.messageId, approval };
}

/** Every 15 minutes: endorsement requests, underwriter replies and client replies from the renewals folder. */
export async function intake(ctx: Ctx<Settings>) {
  const uw = ctx.settings.microsoft_365.underwriter?.email?.toLowerCase();
  const items = Object.values(await ctx.store.list<Item>("renewals"));
  let added = 0, replied = 0;
  for (const m of await listMail(ctx)) {
    const seen = keyOf(`mail:${m.id}`);
    if (await ctx.store.get("mail", seen)) continue;
    await ctx.store.put("mail", seen, { at: ctx.now.toISOString() });
    // A reply from an address we wrote to. Drafted counts too: the daily follow-up marks the send as sent, which may be later.
    const sentTo = items.find((i) => (i.status === "sent" || i.status === "drafted") && i.email?.toLowerCase() === m.from);
    if (sentTo) { await ctx.store.put("renewals", sentTo.id, { ...sentTo, status: "replied" }); replied++; }
    const text = `${m.subject}\n${m.preview}`;
    const kind = uw && m.from === uw ? "underwriter-reply" : ENDORSE.test(text) ? "endorsement" : sentTo ? undefined : "needs-review";
    if (!kind) continue;
    const policy = POLICY_NO.exec(text)?.[1];
    const item: Item = {
      id: keyOf(`item:${m.id}`), kind, status: kind === "endorsement" ? "new" : "needs-review",
      policy: policy && POLICY.test(policy) ? policy : undefined,
      client: m.fromName || undefined, email: EMAIL.test(m.from) ? m.from : undefined,
      title: m.subject || "(no subject)", text: m.preview.slice(0, 1000), received: m.received || ctx.now.toISOString(),
      reason: kind === "underwriter-reply" ? "underwriter reply: read it and answer" : kind === "needs-review" ? "not a renewal or endorsement request" : undefined,
      ref: { message_id: m.id },
    };
    await ctx.store.put("renewals", item.id, item);
    added++;
  }
  ctx.log(`intake: ${added} new, ${replied} replied`);
  return { added, replied };
}

/** Every 30 minutes: pre-renewal emails for policies inside the lead window, and endorsement emails to the underwriter. */
export async function draft(ctx: Ctx<Settings>) {
  const s = ctx.settings, lead = s.renewal_lead_days ?? 45, name = s.business_name ?? "us";
  let drafted = 0, parked = 0;
  for (const p of await readRegister(ctx)) {
    const when = renewalDate(p.renewal);
    const key = keyOf(`renewal:${p.policy}:${when ? day(when) : String(p.renewal)}`);
    if (await ctx.store.get("renewals", key)) continue;
    if (!when) {
      await ctx.store.put("renewals", key, { id: key, kind: "needs-review", status: "needs-review", policy: p.policy, client: p.client, title: `Renewal ${p.policy}`, received: ctx.now.toISOString(), reason: "renewal date not readable: use dd/mm/yyyy or a date" } satisfies Item);
      parked++; continue;
    }
    const left = (when.getTime() - ctx.now.getTime()) / DAY;
    if (left < 0 || left > lead) continue;   // not due yet, or already past: checked again on the next run
    if (!EMAIL.test(p.email)) {
      await ctx.store.put("renewals", key, { id: key, kind: "needs-review", status: "needs-review", policy: p.policy, client: p.client, title: `Renewal ${p.policy}`, received: ctx.now.toISOString(), reason: "no usable client email in the register" } satisfies Item);
      parked++; continue;
    }
    const html = `<p>Hi ${esc(p.client || "there")},</p><p>Your ${esc(p.details || "policy")} (policy ${esc(p.policy)}) renews on ${esc(longDate(when))}.</p>`
      + `<p>Has anything changed since last year, such as vehicles, drivers, address or how the car is used? Reply to this email with the changes and we will take it from there.</p><p>${esc(name)}</p>`;
    const q = await queueEmail(ctx, p.email, `Your policy renews on ${longDate(when)}`, html, `send:${key}`, `Renewal email to ${p.email} for ${p.policy}`);
    await ctx.store.put("renewals", key, { id: key, kind: "renewal", status: "drafted", policy: p.policy, client: p.client, email: p.email, title: `Renewal ${p.policy}`, received: ctx.now.toISOString(), ref: { draft_message: q.messageId, approval: q.approval } } satisfies Item);
    drafted++;
  }
  const uw = s.microsoft_365.underwriter;
  for (const it of Object.values(await ctx.store.list<Item>("renewals"))) {
    if (it.kind !== "endorsement" || it.status !== "new") continue;
    if (!uw || !EMAIL.test(uw.email)) {
      await ctx.store.put("renewals", it.id, { ...it, status: "needs-review", reason: "no underwriter email in settings" });
      parked++; continue;
    }
    const html = `<p>Hi ${esc(uw.name)},</p><p>An endorsement request came in for policy ${esc(it.policy ?? "(number not found in the request)")}`
      + `${it.client ? `, client ${esc(it.client)}` : ""}:</p><blockquote>${esc(it.text ?? "")}</blockquote>`
      + `<p>Could you confirm the premium change and any documents you need? Thanks,</p><p>${esc(name)}</p>`;
    const q = await queueEmail(ctx, uw.email, `Endorsement request${it.policy ? ` ${it.policy}` : ""}`, html, `send:${it.id}`, `Endorsement email to underwriter ${uw.email}`);
    await ctx.store.put("renewals", it.id, { ...it, status: "drafted", email: uw.email, ref: { ...it.ref, draft_message: q.messageId, approval: q.approval } });
    drafted++;
  }
  ctx.log(`draft: ${drafted} drafted, ${parked} need a look`);
  return { drafted, needs_review: parked };
}

/** Daily: mark what was sent, then queue follow-ups on sent emails with no reply that are due. */
export async function followUp(ctx: Ctx<Settings>) {
  const days = ctx.settings.follow_up?.after_days ?? [7, 14];
  const uw = ctx.settings.microsoft_365.underwriter;
  const items = Object.values(await ctx.store.list<Item>("renewals"));
  let sent = 0, queued = 0;
  for (const it of items) {
    if (it.status !== "drafted" || !it.ref?.approval) continue;
    const ap = await ctx.store.get<Approval>("approvals", it.ref.approval);
    if (ap?.status === "rejected") { await ctx.store.put("renewals", it.id, { ...it, status: "needs-review", reason: "the send was rejected" }); continue; }
    // Sent once the send act itself succeeded, even if the approval was left unfinished after it.
    if (ap && (ap.status === "done" || (ap.results?.[0]?.status ?? 999) < 300)) {
      await ctx.store.put("renewals", it.id, { ...it, status: "sent", sent_at: ap.decided ?? ap.started ?? ctx.now.toISOString() });
      sent++;
    }
  }
  for (const it of items) {
    const current = (await ctx.store.get<Item>("renewals", it.id)) ?? it;
    if (current.status !== "sent" || !current.sent_at || !current.email) continue;
    const n = current.followups?.length ?? 0;
    if (n >= days.length || ctx.now.getTime() - Date.parse(current.sent_at) < days[n] * DAY) continue;
    const greet = current.kind === "endorsement" ? (uw?.name ?? "there") : (current.client || "there");
    const html = `<p>Hi ${esc(greet)},</p><p>Just checking you got our last email about ${esc(current.title)}. Happy to answer any questions.</p>`;
    const q = await queueEmail(ctx, current.email, `Following up: ${current.title}`, html, `follow${n + 1}:${current.id}`, `Follow-up ${n + 1} to ${current.email} about ${current.title}`);
    await ctx.store.put("renewals", current.id, { ...current, followups: [...(current.followups ?? []), ctx.now.toISOString()], ref: { ...current.ref, follow_up_approval: q.approval } });
    queued++;
  }
  ctx.log(`follow-up: ${sent} marked sent, ${queued} queued`);
  return { sent, queued };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { intake, draft, "follow-up": followUp };
