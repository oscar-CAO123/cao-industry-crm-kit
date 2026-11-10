// The data-sync workflow's three crons. Each reads and drafts internal records, or queues one live act for approval.
// Nothing is paid, sent or changed for a customer by a cron.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { type Link, type Settings, clean, dayTime } from "./types.ts";
import { contactsSince, contactByName, createContact, draftBills, authoriseAct } from "./adapters/xero.ts";
import { companiesWithoutXero, upsertCompanies } from "./adapters/hubspot.ts";

/** Every 30 minutes: Xero contacts changed since the last run are mirrored into HubSpot companies (internal draft). */
export async function contacts(ctx: Ctx<Settings>) {
  const prop = ctx.settings.hubspot.idProperty;
  const mark = await ctx.store.get<{ since: string }>("state", "contacts");
  const started = dayTime(ctx.now);
  const rows = await contactsSince(ctx, mark?.since);
  await upsertCompanies(ctx, rows.map((c) => ({ id: c.id, idProperty: prop, properties: { name: c.name } })));
  for (const c of rows) await ctx.store.put("links", c.id, { xero_id: c.id, name: c.name, synced: started } satisfies Link);
  await ctx.store.put("state", "contacts", { since: started });   // only after HubSpot accepted the batch
  ctx.log(`contacts: ${rows.length} mirrored into HubSpot`);
  return { mirrored: rows.length };
}

/** Hourly: a HubSpot company with no Xero contact gets one (an exact name match is reused, an unclear match is left alone),
 *  and the Xero ContactID is written back to HubSpot. Internal draft only. */
export async function newCompanies(ctx: Ctx<Settings>) {
  const prop = ctx.settings.hubspot.idProperty;
  const todo = await companiesWithoutXero(ctx, prop);
  let linked = 0, skipped = 0;
  for (const co of todo) {
    try {
      const found = await contactByName(ctx, co.name);
      if (found.conflict) { skipped++; ctx.log(`new-companies: ${co.id} matches two Xero contacts, left for a person`); continue; }
      const xid = found.id ?? (await createContact(ctx, { name: co.name, key: `company:${co.id}` }));
      await upsertCompanies(ctx, [{ id: co.id, properties: { [prop]: xid } }]);
      await ctx.store.put("links", xid, { xero_id: xid, hubspot_id: co.id, name: co.name, synced: dayTime(ctx.now) } satisfies Link);
      linked++;
    } catch (e: any) {
      skipped++;
      ctx.log(`new-companies: ${co.id} skipped: ${clean(e?.message ?? e, 120)}`);
    }
  }
  ctx.log(`new-companies: ${linked} linked, ${skipped} skipped`);
  return { linked, skipped };
}

/** Hourly: each supplier bill still in DRAFT in Xero is queued for a person to authorise. Nothing is paid here. */
export async function bills(ctx: Ctx<Settings>) {
  if (!ctx.settings.sync_bills) return { skipped: "sync_bills is off" };
  const drafts = await draftBills(ctx);
  for (const b of drafts) {
    await ctx.queue(authoriseAct(b), `Authorise supplier bill ${clean(b.number, 60)} from ${clean(b.supplier, 120)}, $${b.total.toFixed(2)} (draft in Xero)`);
  }
  ctx.log(`bills: ${drafts.length} draft bills read, queued for approval`);
  return { queued: drafts.length };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { contacts, "new-companies": newCompanies, bills };
