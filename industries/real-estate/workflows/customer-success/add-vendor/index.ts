// The vendor report workflow's two crons. Each is deterministic: it reads, drafts and queues; it never sends.
// The commentary is judgment: the agent skill in SKILL.md writes it into the store, and the draft cron waits for it.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { vaultre } from "./adapters/vaultre.ts";
import { microsoft365 } from "./adapters/microsoft-365.ts";
import { type Commentary, type PropertyFigures, type Report, type Settings, EMAIL, dayOf, reportHtml, reportKey } from "./types.ts";

/** Daily, before the draft run: read each listing's record and its open homes from VaultRE. Reads only. */
export async function pull(ctx: Ctx<Settings>) {
  let read = 0;
  for (const v of ctx.settings.vendors ?? []) {
    const f = await vaultre.figures(ctx, v);
    await ctx.store.put("properties", String(v.property_id), f);
    read++;
  }
  ctx.log(`pull: ${read} listings read`);
  return { read };
}

/** Daily, after the pull: draft each report in Outlook once its commentary exists, note it on the listing, and queue the send. */
export async function draft(ctx: Ctx<Settings>) {
  const date = dayOf(ctx.now);
  let drafted = 0, parked = 0;
  for (const v of ctx.settings.vendors ?? []) {
    const key = reportKey(v.property_id, date);
    const prior = await ctx.store.get<Report>("reports", key);
    if (prior?.status === "drafted") continue;   // done today: a re-run never drafts or queues it again
    const park = async (status: Report["status"], reason: string) => {
      parked++;
      await ctx.store.put("reports", key, { key, property_id: v.property_id, date, to: v.email, subject: prior?.subject ?? "",
        status, created: prior?.created ?? ctx.now.toISOString(), reason, message_id: prior?.message_id } satisfies Report);
    };
    if (!EMAIL.test(v.email)) { await park("needs-check", "vendor email in settings is not valid"); continue; }
    // Figures and commentary must be dated today: an earlier day's numbers or text never go out under today's date.
    const today = (iso?: string) => { const t = Date.parse(String(iso ?? "")); return Number.isFinite(t) && dayOf(new Date(t)) === date; };
    const f = await ctx.store.get<PropertyFigures>("properties", String(v.property_id));
    if (!f) { await park("needs-figures", "pull has not read this listing yet"); continue; }
    if (!today(f.as_of)) { await park("needs-figures", "pull has not read this listing today"); continue; }
    const c = await ctx.store.get<Commentary>("commentary", String(v.property_id));
    if (!c?.text) { await park("needs-commentary", "no commentary yet: the agent writes it"); continue; }
    if (!today(c.written)) { await park("needs-commentary", "commentary was not written today: the agent writes it again"); continue; }

    const subject = `Vendor report: ${f.address || f.heading || `listing ${f.property_id}`}`;
    let messageId = prior?.message_id;
    if (!messageId) {
      messageId = await microsoft365.mailDraft(ctx, { to: v.email, subject, html: reportHtml(ctx.settings, f, c.text, v) });
      // Saved before the queue: if the run stops here, the next run queues this draft and does not draft it again.
      await ctx.store.put("reports", key, { key, property_id: v.property_id, date, to: v.email, subject, status: "draft-made",
        created: prior?.created ?? ctx.now.toISOString(), message_id: messageId } satisfies Report);
    }
    const act = microsoft365.sendAct(ctx, messageId, v.email);
    await ctx.queue({ ...act, key: `vendor-report:${key}` },
      `Send vendor report for ${f.address || f.heading} to ${v.email}: ${f.open_homes.length} open homes in the window`);
    await vaultre.activityNote(ctx, f, `Vendor report for ${date} drafted and queued for approval.`);
    await ctx.store.put("reports", key, { key, property_id: v.property_id, date, to: v.email, subject, status: "drafted",
      created: prior?.created ?? ctx.now.toISOString(), message_id: messageId } satisfies Report);
    drafted++;
  }
  ctx.log(`draft: ${drafted} drafted, ${parked} waiting`);
  return { drafted, waiting: parked };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { pull, draft };
