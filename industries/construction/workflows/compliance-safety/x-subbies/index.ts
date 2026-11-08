// The subcontractor compliance workflow's three crons. Each reads, drafts or queues; none sends.
// Judgment (reading a certificate, deciding a subcontractor is not fit for a site, writing a SWMS) stays with the
// agent skill in SKILL.md and with the owner.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { approvalId } from "../../../../../core/workflows/runtime.ts";
import { type Settings, EMAIL, esc, keyOf, daysUntil, day } from "./types.ts";
import * as m365 from "./adapters/microsoft-365.ts";
import * as dropbox from "./adapters/dropbox.ts";

/** Every 30 minutes: a subcontractor's reply becomes a register row to complete. Each message is handled once. */
export async function intake(ctx: Ctx<Settings>) {
  const known = new Set((await m365.register(ctx)).map((r) => r.email.toLowerCase()));
  let added = 0;
  for (const x of await m365.replies(ctx)) {
    const seen = keyOf(`reply:${x.messageId}`);
    if (await ctx.store.get("seen", seen)) continue;
    if (!known.has(x.email.toLowerCase())) {
      await m365.addRow(ctx, { subcontractor: x.name || x.email, email: x.email, trade: "", document: `Reply: ${x.subject}`, expiry: "", status: "reply received" });
      known.add(x.email.toLowerCase());
      added++;
    }
    await ctx.store.put("seen", seen, ctx.now.toISOString());
  }
  ctx.log(`intake: ${added} new`);
  return { added };
}

/** Weekdays: a document that has expired, or expires within expiry_days, gets a chase email. Its draft is made and the send is queued. */
export async function chase(ctx: Ctx<Settings>) {
  const windowDays = ctx.settings.expiry_days ?? 30;
  let queued = 0, skipped = 0;
  for (const r of await m365.register(ctx)) {
    if (!r.expiry || !r.document || !EMAIL.test(r.email)) { skipped++; continue; }
    const left = daysUntil(r.expiry, ctx.now);
    if (left > windowDays) continue;
    const key = `chase:${r.email.toLowerCase()}:${r.document.toLowerCase()}:${r.expiry}`;
    if (await ctx.store.get("approvals", approvalId(ctx.workflow.id, key))) continue; // already queued: never draft twice
    const when = left < 0 ? `expired on ${r.expiry}` : `expires on ${r.expiry}`;
    const d = await m365.mailDraft(ctx, { to: r.email, subject: `Updated ${r.document} needed`, html: `<p>Hi ${esc(r.subcontractor)},</p>`
      + `<p>Our records show your ${esc(r.document)} ${when}. Could you send an updated copy before then? Reply to this email with the file attached.</p>`
      + `<p>Thanks,<br>${esc(ctx.settings.business_name ?? "")}</p>` });
    await ctx.queue({ ...d.send, key }, `Chase ${r.document} from ${r.subcontractor} (${when}) to ${r.email}`);
    queued++;
  }
  ctx.log(`chase: ${queued} queued, ${skipped} rows without a document, email or expiry`);
  return { queued, skipped };
}

/** Weekdays: one file check per live job folder per day, drafted to the business's own mailbox for the owner to read. Nothing is sent. */
export async function records(ctx: Ctx<Settings>) {
  let drafted = 0;
  const today = day(ctx.now);
  for (const folder of ctx.settings.dropbox?.job_folders ?? []) {
    const key = keyOf(`records:${folder}:${today}`);
    if (await ctx.store.get("records", key)) continue;
    const list = await dropbox.listJob(ctx, folder);
    const items = list.files.map((f) => `<li>${esc(f.name)}${f.modified ? ` (modified ${esc(f.modified.slice(0, 10))})` : ""}</li>`).join("");
    await m365.mailDraft(ctx, { to: ctx.settings.microsoft_365?.mailbox ?? "", subject: `Job file check: ${folder}`,
      html: `<p>${list.files.length} files in ${esc(folder)}${list.more ? ", and the list is cut short at 200" : ""}.</p><ul>${items || "<li>No files yet.</li>"}</ul>` });
    await ctx.store.put("records", key, ctx.now.toISOString());
    drafted++;
  }
  ctx.log(`records: ${drafted} drafted`);
  return { drafted };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { intake, chase, records };
