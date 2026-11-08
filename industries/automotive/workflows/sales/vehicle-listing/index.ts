// The vehicle-listing workflow's four crons. Each reads, drafts and queues; it never sends and never edits the stock register.
// Judgment (writing the listing copy, marking a vehicle sold) belongs to the agent skill in SKILL.md, which writes a proposal
// into the store; the draft cron only acts on a proposal that has a description.
import type { Approval } from "../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../core/workflows/runtime.ts";
import { type Cx, type Proposal, type Vehicle, ID, STOCK, esc, money, cap, paragraphs } from "./types.ts";
import { stockRows, photoCount, mailDraft, registerRow } from "./adapters/microsoft-365.ts";

const keyOf = (stock: string) => safeKey(`stock:${stock}`, 90);
const OPEN = ["new", "needs-photos", "ready"];

/** Every 10 minutes: vehicles marked "To list" in the stock register become records. Price and title follow the register
 *  until a listing is drafted; the sheet status is refreshed every run so a sale shows up here. */
export async function intake(ctx: Cx) {
  let added = 0, skipped = 0;
  for (const c of await stockRows(ctx)) {
    const [stock = "", year = "", make = "", model = "", priceText = "", sheet = "", folder = ""] = c;
    if (!STOCK.test(stock) || !ID.test(folder)) { skipped++; continue; }
    const price = Number(priceText);
    const priced = Number.isFinite(price) && price > 0;
    const id = keyOf(stock);
    const old = await ctx.store.get<Vehicle>("vehicles", id);
    const title = cap(`${year} ${make} ${model}`.trim() || stock, 120);
    if (old) {
      await ctx.store.put("vehicles", id, { ...old, sheet_status: sheet, ...(OPEN.includes(old.status) && priced ? { price, title } : {}) });
      continue;
    }
    if (sheet.toLowerCase() !== "to list" || !priced) { skipped++; continue; }
    await ctx.store.put("vehicles", id, { id, stock, title, price, photo_folder: folder, sheet_status: sheet, status: "new",
      seen: ctx.now.toISOString() } satisfies Vehicle);
    added++;
  }
  ctx.log(`intake: ${added} new, ${skipped} skipped`);
  return { added, skipped };
}

/** Every 15 minutes (hourly at :15 in the schedule): count photos in each open vehicle's folder. A vehicle is ready at the minimum. */
export async function photos(ctx: Cx) {
  const min = ctx.settings.min_photos ?? 6;
  let ready = 0, short = 0;
  for (const v of Object.values(await ctx.store.list<Vehicle>("vehicles"))) {
    if (v.status !== "new" && v.status !== "needs-photos") continue;
    const n = await photoCount(ctx, v.photo_folder);
    const isReady = n >= min;
    if (isReady) ready++; else short++;
    await ctx.store.put("vehicles", v.id, { ...v, photos: n, status: isReady ? "ready" : "needs-photos",
      reason: isReady ? undefined : `${n} of ${min} photos: add the rest to the photo folder` });
  }
  ctx.log(`photos: ${ready} ready, ${short} need photos`);
  return { ready, short };
}

/** Every 15 minutes: for each ready vehicle whose listing copy the agent has written, draft the copy, log it in the register,
 *  and queue the send to the listing desk for approval. */
export async function draft(ctx: Cx) {
  const todo = Object.values(await ctx.store.list<Vehicle>("vehicles")).filter((v) => v.status === "ready");
  let drafted = 0, parked = 0;
  for (const v of todo) {
    const prop = await ctx.store.get<Proposal>("proposals", v.id);
    if (!prop?.description?.trim()) {
      parked++;
      await ctx.store.put("vehicles", v.id, { ...v, reason: "no listing copy yet: the agent writes it into the proposal" });
      continue;
    }
    const fresh = (await ctx.store.get<Vehicle>("vehicles", v.id)) ?? v;
    if (fresh.status !== "ready") continue;      // already drafted by an earlier run: never drafts or queues twice
    const m = await mailDraft(ctx, { to: ctx.settings.listing_to, subject: `Listing copy: ${fresh.title}`,
      html: `<p>${esc(fresh.title)}, ${esc(money(fresh.price))}, stock ${esc(fresh.stock)}.</p>${paragraphs(prop.description)}` });
    const approval = await ctx.queue({ ...m.act, key: `list:${fresh.id}` },
      `Send listing copy for ${fresh.title} (stock ${fresh.stock}) to the listing desk`);
    await registerRow(ctx, [fresh.stock, fresh.title, fresh.price, "Listing drafted"]);
    await ctx.store.put("vehicles", fresh.id, { ...fresh, status: "drafted", message_id: m.messageId, approval, reason: undefined });
    drafted++;
  }
  ctx.log(`draft: ${drafted} drafted, ${parked} need copy`);
  return { drafted, parked };
}

/** Daily: a listing counts as live once its send is approved and done; a sold vehicle gets an ownership transfer checklist
 *  queued for approval (no buyer details in it). */
export async function followUp(ctx: Cx) {
  let listed = 0, transfers = 0;
  for (const v of Object.values(await ctx.store.list<Vehicle>("vehicles"))) {
    const cur: Vehicle = { ...v };
    if (cur.status === "drafted" && cur.approval) {
      const ap = await ctx.store.get<Approval>("approvals", cur.approval);
      if (ap?.status === "done") { cur.status = "listed"; cur.listed_at = ap.decided ?? ctx.now.toISOString(); listed++; }
    }
    const prop = await ctx.store.get<Proposal>("proposals", v.id);
    const sold = !!prop?.sold || cur.sheet_status.toLowerCase() === "sold";
    if (cur.status === "listed" && sold && ctx.settings.transfer_to) {
      const m = await mailDraft(ctx, { to: ctx.settings.transfer_to, subject: `Ownership transfer: ${cur.title}`,
        html: `<p>Ownership transfer checklist for ${esc(cur.title)}, stock ${esc(cur.stock)}.</p><p>Prepare the transfer in the dealer system and record the buyer details there. No buyer details are in this email.</p>` });
      cur.transfer = await ctx.queue({ ...m.act, key: `transfer:${cur.id}` }, `Send ownership transfer checklist for ${cur.title} (stock ${cur.stock}) to the transfer desk`);
      cur.status = "transfer-drafted";
      await registerRow(ctx, [cur.stock, cur.title, cur.price, "Transfer drafted"]);
      transfers++;
    }
    if (cur.status === "transfer-drafted" && cur.transfer) {
      const ap = await ctx.store.get<Approval>("approvals", cur.transfer);
      if (ap?.status === "done") cur.status = "transferred";
    }
    await ctx.store.put("vehicles", cur.id, cur);
  }
  ctx.log(`follow-up: ${listed} listed, ${transfers} transfer checklists queued`);
  return { listed, transfers };
}

export const CRONS: Record<string, (ctx: Cx) => Promise<unknown>> = { intake, photos, draft, "follow-up": followUp };
