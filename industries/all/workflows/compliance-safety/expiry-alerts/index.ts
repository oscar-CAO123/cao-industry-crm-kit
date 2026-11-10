// The expiry-alerts workflow's three crons. Each is deterministic: it reads, drafts and queues; it never sends.
// The holder reminder is drafted in Outlook and its send is queued for a person. The owner digest stays a draft.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { readRegister, mailDraft } from "./adapters/microsoft-365.ts";
import { type RegisterRow, type Reminder, type Settings, esc, keyOf } from "./types.ts";

const ITEMS = "expiry-items", REMINDERS = "reminders", DIGESTS = "digests";
const day = (d: Date) => d.toISOString().slice(0, 10);

/** Read the register and store each row's status. Reads only. */
async function refresh(ctx: Ctx<Settings>): Promise<RegisterRow[]> {
  const rows = await readRegister(ctx);
  for (const r of rows) await ctx.store.put(ITEMS, r.key, r);
  return rows;
}

/** Daily: read the register and record each item's status. Drafts and queues nothing. */
export async function scan(ctx: Ctx<Settings>) {
  const rows = await refresh(ctx);
  const n = (s: RegisterRow["status"]) => rows.filter((r) => r.status === s).length;
  const out = { items: rows.length, expired: n("expired"), due: n("due"), ok: n("ok"), unknown: n("unknown") };
  ctx.log(`scan: ${JSON.stringify(out)}`);
  return out;
}

/** Daily: draft a renewal reminder to each holder inside the window (or lapsed) and queue its send for approval. */
export async function remind(ctx: Ctx<Settings>) {
  const rows = await refresh(ctx);
  const within = ctx.settings.remind_within_days ?? 30;
  let drafted = 0, no_email = 0;
  for (const r of rows) {
    if (!r.expiry || r.days_left === undefined || r.days_left > within) continue;
    if (!r.email) { no_email++; continue; }                       // the owner sees these in the digest
    const rkey = keyOf(`${r.key}:${r.expiry}`);
    if (await ctx.store.get(REMINDERS, rkey)) continue;           // one reminder per item per expiry date
    const lapsed = r.days_left < 0;
    const lead = lapsed ? `${r.item} expired on ${r.expiry}` : `${r.item} expires on ${r.expiry}`;
    const subject = lapsed ? `Expired: ${r.item}` : `Renewal due: ${r.item}`;
    const html = `<p>Hi ${esc(r.holder)},</p><p>${esc(lead)}. Please send us a current copy once it is renewed.</p>`
      + `<p>Thanks,<br>${esc(ctx.settings.business_name ?? "")}</p>`;
    const d = await mailDraft(ctx, r.email, subject, html);
    const approval = await ctx.queue({ ...d.act, key: `remind:${rkey}` }, `Send reminder to ${r.holder} (${r.email}): ${lead}`);
    await ctx.store.put(REMINDERS, rkey, { key: rkey, item_key: r.key, holder: r.holder, expiry: r.expiry, draft_message: d.messageId,
      approval, drafted: ctx.now.toISOString() } satisfies Reminder);
    drafted++;
  }
  ctx.log(`remind: ${drafted} drafted and queued, ${no_email} without a valid email`);
  return { drafted, no_email };
}

/** Weekly: one owner digest draft of lapsed and soon-due items. Drafted in the business mailbox, never queued or sent. */
export async function digest(ctx: Ctx<Settings>) {
  const rows = await refresh(ctx);
  const today = day(ctx.now), dkey = keyOf(`digest:${today}`);
  if (await ctx.store.get(DIGESTS, dkey)) return { drafted: 0, items: 0 };
  const owner = ctx.settings.owner_email;
  if (!owner) throw new Error("owner_email is not set");
  const within = ctx.settings.digest_within_days ?? 90;
  const list = rows.filter((r) => r.status === "expired" || (r.days_left !== undefined && r.days_left <= within));
  const li = list.map((r) => `<li>${esc(r.holder)}: ${esc(r.item)}, ${r.days_left! < 0 ? "expired" : "expires"} ${esc(r.expiry ?? "")}`
    + `${r.email ? "" : " (no valid email on file)"}</li>`).join("");
  const html = `<p>Expiry digest for ${esc(today)}: ${list.length} item(s) expired or due within ${within} days.</p>`
    + (list.length ? `<ul>${li}</ul>` : "<p>Nothing to chase this week.</p>");
  const d = await mailDraft(ctx, owner, `Expiry digest ${today}`, html);
  await ctx.store.put(DIGESTS, dkey, { draft_message: d.messageId, items: list.length, drafted: ctx.now.toISOString() });
  ctx.log(`digest: drafted for ${owner}, ${list.length} items`);
  return { drafted: 1, items: list.length };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { scan, remind, digest };
