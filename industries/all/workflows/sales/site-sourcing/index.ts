// The site-sourcing workflow's three crons. Each reads, drafts or queues; none sends.
// scan and desk-check only read Domain. enquire only queues an enquiry for a person to approve.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { Approval } from "../../../../../core/workflows/runtime.ts";
import type { Candidate, Settings } from "./types.ts";
import { deskFacts, enquiryBody, matches, parseListing, searchLocation, validSettings } from "./adapters/domain.ts";

/** Nightly: search each configured location, keep the listings that match, and store the new ones. */
export async function scan(ctx: Ctx<Settings>) {
  validSettings(ctx.settings);
  let found = 0, added = 0;
  for (const loc of ctx.settings.search.locations) {
    for (const item of await searchLocation(ctx, loc)) {
      const c = parseListing(item, ctx.now);
      if (!c) continue;
      found++;
      if (!matches(ctx.settings, c)) continue;
      if (await ctx.store.get<Candidate>("candidates", c.key)) continue;
      await ctx.store.put("candidates", c.key, c);
      added++;
    }
  }
  ctx.log(`scan: ${found} listings read, ${added} new candidates`);
  return { found, added };
}

/** After the scan: read suburb statistics and nearby schools for each new candidate, and store them on the candidate. */
export async function deskCheck(ctx: Ctx<Settings>) {
  const todo = Object.values(await ctx.store.list<Candidate>("candidates")).filter((c) => c.status === "new");
  let checked = 0, failed = 0;
  for (const c of todo) {
    try {
      c.desk = await deskFacts(ctx, c);
      c.status = "checked";
      c.checked = ctx.now.toISOString();
      checked++;
    } catch (e: any) {
      c.reason = `desk check failed: ${String(e?.message ?? e).slice(0, 160)}`;
      failed++; // stays new, so the next run tries again
    }
    await ctx.store.put("candidates", c.key, c);
  }
  ctx.log(`desk-check: ${checked} checked, ${failed} failed`);
  return { checked, failed };
}

/** Nightly: record approved enquiries, and queue one enquiry per site the owner has shortlisted. Nothing is sent here. */
export async function enquire(ctx: Ctx<Settings>) {
  const all = Object.values(await ctx.store.list<Candidate>("candidates"));
  let queued = 0, recorded = 0;
  for (const c of all) {
    if (c.status !== "enquiry-queued" || !c.enquiry_approval) continue;
    const ap = await ctx.store.get<Approval>("approvals", c.enquiry_approval);
    if (!ap) continue;
    if (ap.status === "done" && (ap.results?.[0]?.status ?? 999) < 300) { c.status = "enquired"; recorded++; }
    else if (ap.status === "rejected") { c.status = "skipped"; c.reason = "enquiry rejected"; recorded++; }
    else continue;
    await ctx.store.put("candidates", c.key, c);
  }
  for (const c of all) {
    if (c.status !== "shortlisted") continue;
    const body = enquiryBody(ctx.settings, c);
    if (!body.message) throw new Error("site-sourcing: the enquiry message is empty in settings");
    // A site shortlisted again after its enquiry was rejected needs a new approval: queue() would hand back the rejected one.
    const prev = c.enquiry_approval ? await ctx.store.get<Approval>("approvals", c.enquiry_approval) : undefined;
    if (prev?.status === "rejected") c.enquiry_round = (c.enquiry_round ?? 0) + 1;
    const key = c.enquiry_round ? `enquire:${c.key}:${c.enquiry_round}` : `enquire:${c.key}`;
    const id = await ctx.queue({ platform: "domain", op: "docs.post_v1_enquiries", input: { body }, key },
      `Send an enquiry to the agent for ${c.address || `listing ${c.listing_id}`} (${c.suburb} ${c.state})`);
    c.status = "enquiry-queued";
    c.enquiry_approval = id;
    await ctx.store.put("candidates", c.key, c);
    queued++;
  }
  ctx.log(`enquire: ${queued} queued for approval, ${recorded} outcomes recorded`);
  return { queued, recorded };
}

export const CRONS = { scan, "desk-check": deskCheck, enquire };
