// The loans workflow's two crons. Each reads or drafts. Nothing here sends: the document request waits for a person.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { Enquiry, Settings } from "./types.ts";
import * as m365 from "./adapters/microsoft-365.ts";

/** Every 10 minutes: new loan enquiries from the enquiries folder. */
export async function intake(ctx: Ctx<Settings>) {
  let added = 0;
  for (const e of await m365.enquiries(ctx)) {
    if (await ctx.store.get("enquiries", e.id)) continue;
    await ctx.store.put("enquiries", e.id, { ...e, status: "new" } satisfies Enquiry);
    added++;
  }
  ctx.log(`intake: ${added} new`);
  return { added };
}

/** Every 15 minutes: log each new enquiry in the loan register, draft the document request, queue its send for approval.
 *  Each step is saved in the enquiry's ref before the next one, so a run that fails part way reuses the draft and the
 *  register row it already made instead of making a second of either. */
export async function draft(ctx: Ctx<Settings>) {
  const todo = Object.values(await ctx.store.list<Enquiry>("enquiries")).filter((e) => e.status === "new");
  let drafted = 0, skipped = 0;
  for (const e of todo) {
    if (!e.contact.email) {
      await ctx.store.put("enquiries", e.id, { ...e, status: "skipped", reason: "no email address on the enquiry" });
      skipped++;
      continue;
    }
    const ref: Record<string, string> = { ...(e.ref ?? {}) };
    if (!ref.draft_message) {
      const d = await m365.documentRequest(ctx, e);
      ref.draft_message = d.messageId;
      await ctx.store.put("enquiries", e.id, { ...e, ref });
    }
    if (!ref.register_row) {
      await m365.registerRow(ctx, e, "Documents requested");
      ref.register_row = "added";
      await ctx.store.put("enquiries", e.id, { ...e, ref });
    }
    await ctx.queue({ ...m365.sendAct(ctx, ref.draft_message, e.contact.email), key: `send:${e.id}` }, `Email document request to ${e.contact.email}`);
    await ctx.store.put("enquiries", e.id, { ...e, status: "drafted", ref });
    drafted++;
  }
  ctx.log(`draft: ${drafted} drafted, ${skipped} skipped`);
  return { drafted, skipped };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { intake, draft };
