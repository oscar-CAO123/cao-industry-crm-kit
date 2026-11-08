// The listing syndication workflow's two crons. Each reads or drafts inside VaultRE; neither publishes a listing or
// replies to an enquirer on its own. A listing goes live only when a person sets it live in VaultRE's portal settings.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { type Settings, type Listing, type Enquiry, type Reply, EMAIL, day, clip } from "./types.ts";
import { vaultre } from "./adapters/vaultre.ts";

export const ADAPTERS = { vaultre };

/** Every two hours: for each vacant rental not yet noted, add one internal note with its facts, photo counts and connected portals. */
export async function prepare(ctx: Ctx<Settings>) {
  const today = day(ctx.now);
  const portals = (await vaultre.portals(ctx)).map((p) => p.description || p.code).filter(Boolean).join(", ") || "none listed";
  let drafted = 0, skipped = 0;
  for (const p of await vaultre.vacancies(ctx)) {
    const key = String(p.id);
    if (await ctx.store.get<Listing>("listings", key)) { skipped++; continue; }
    const photos = await vaultre.photos(ctx, p.id);
    const count = (t: string) => photos.filter((x) => x.type === t).length;
    const published = photos.filter((x) => x.published).length;
    const text = [
      "LISTING DRAFT, for a person to check. Not live.",
      `Address: ${clip(p.displayAddress, 200) || "not set"}`,
      `Rent: ${clip(p.displayPrice, 100) || "not set"}`,
      `Bedrooms ${p.bed ?? "?"}, bathrooms ${p.bath ?? "?"}, garages ${p.garages ?? "?"}`,
      `Heading (as entered): ${clip(p.heading, 200) || "none"}`,
      `Description (as entered): ${clip(p.description, 1500) || "none"}`,
      `Photos: ${count("Photograph")} photographs, ${count("Floorplan")} floor plans, ${published} published`,
      `Portals connected to this account: ${portals}`,
      "Next: check the copy and photos, then set the listing live in VaultRE.",
    ].join("\n");
    await vaultre.noteOnProperty(ctx, p.id, text);
    await ctx.store.put("listings", key, { id: p.id, drafted: today } satisfies Listing);
    drafted++;
  }
  ctx.log(`prepare: ${drafted} listing notes added, ${skipped} already noted`);
  return { drafted, skipped };
}

/** Every 15 minutes: note each new portal enquiry on its contact, then queue the stored reply (if any) for approval. */
export async function enquiries(ctx: Ctx<Settings>) {
  const today = day(ctx.now);
  let noted = 0, queued = 0, flagged = 0;
  for (const e of await vaultre.enquiries(ctx)) {
    const key = String(e.id);
    let rec = await ctx.store.get<Enquiry>("enquiries", key);
    if (!rec) {
      const email = (e.personEmails ?? []).find((a) => EMAIL.test(a));
      rec = { id: e.id, contactId: e.contactId, email, name: clip(e.personName, 120) || undefined,
        subject: clip(e.subject, 200), body: clip(e.body, 2000), status: "new", seen: today };
      await ctx.store.put("enquiries", key, rec);
    }
    if (rec.status === "new") {
      if (!rec.contactId) { rec = { ...rec, status: "no-contact" }; flagged++; }
      else {
        await vaultre.noteOnContact(ctx, rec.contactId, `Portal enquiry: ${rec.subject}\n${rec.body}`.slice(0, 2000));
        rec = { ...rec, status: "noted" }; noted++;
      }
      await ctx.store.put("enquiries", key, rec);
    }
    if (rec.status !== "noted" && rec.status !== "reply-queued") continue;
    const reply = await ctx.store.get<Reply>("replies", key);
    if (!reply) continue; // no reply written yet: the enquiry waits for one
    if (!rec.email) { if (rec.status !== "no-email") { flagged++; await ctx.store.put("enquiries", key, { ...rec, status: "no-email" }); } continue; }
    const id = await ctx.queue(vaultre.replyAct(rec.contactId!, rec.email, clip(reply.subject, 200), clip(reply.text, 5000), `reply:${key}`),
      `reply to ${rec.email} about ${rec.subject}`);
    if (rec.status !== "reply-queued") { queued++; await ctx.store.put("enquiries", key, { ...rec, status: "reply-queued", approval: id }); }
  }
  ctx.log(`enquiries: ${noted} noted, ${queued} replies queued, ${flagged} flagged`);
  return { noted, queued, flagged };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { prepare, enquiries };
