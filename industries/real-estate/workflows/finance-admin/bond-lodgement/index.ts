// The bond lodgement workflow's two crons. Each reads, drafts or queues; none sends on its own.
// Lodging, claiming and releasing a bond with the state authority is a person's job: the crons only keep the register and flag what is due.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { type Settings, DAY, day, esc, money } from "./types.ts";
import { vaultre } from "./adapters/vaultre.ts";
import { mailDraft, registerRow } from "./adapters/microsoft-365.ts";

/** Hourly: one register row per live tenancy, flagged when no bond is receipted. Reads and drafts only. */
export async function register(ctx: Ctx<Settings>) {
  let added = 0, flagged = 0;
  for (const t of await vaultre.tenancies(ctx)) {
    if (t.archived) continue;
    if (await ctx.store.get("bond_register", t.id)) continue;
    const receipted = (t.bond_receipted ?? 0) > 0;
    if (!receipted) flagged++;
    await registerRow(ctx, [t.id, t.property, t.start ?? "", t.end ?? "", receipted ? money(t.bond_receipted!) : "NOT RECEIPTED", day(ctx.now)]);
    await ctx.store.put("bond_register", t.id, { ...t, seen: day(ctx.now) });
    added++;
  }
  ctx.log(`register: ${added} added, ${flagged} with no bond receipted`);
  return { added, flagged };
}

/** Daily: for each receipted bond whose tenancy has ended, draft a reminder and queue its send for the team to approve. */
export async function releaseCheck(ctx: Ctx<Settings>) {
  const today = day(ctx.now);
  let queued = 0;
  for (const t of await vaultre.tenancies(ctx)) {
    if (t.archived || !t.end || t.end >= today || !((t.bond_receipted ?? 0) > 0)) continue;
    if (await ctx.store.get("bond_release", t.id)) continue;
    const d = await mailDraft(ctx, {
      to: ctx.settings.notify,
      subject: `Bond claim or release due: ${t.property}`,
      html: `<p>The tenancy at ${esc(t.property)} ended on ${esc(t.end)}. The bond of ${esc(money(t.bond_receipted!))} is receipted. Lodge the claim or release the bond with the state bond authority, then record the outcome.</p>`,
    });
    const approval = await ctx.queue({ ...d.act, key: `release:${t.id}` }, `bond reminder for ${t.property}: claim or release ${money(t.bond_receipted!)}`);
    await ctx.store.put("bond_release", t.id, { tenancy: t.id, draft: d.messageId, approval, queued: today });
    queued++;
  }
  ctx.log(`release-check: ${queued} queued`);
  return { queued };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { register, "release-check": releaseCheck };
