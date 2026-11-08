// The tenant screening workflow's three crons. Each is deterministic: it reads, sets the applicant's status, and
// queues a tenancy for approval. It never sends a message and never creates a tenancy by itself.
// The screening checks (ID, income, references, credit, guarantor) are judgment steps done outside the platform
// (see SKILL.md); their result reaches the store as status "approved" with lease dates.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { Applicant, Settings } from "./types.ts";
import { applicantContacts, readContact, tenancyBody } from "./adapters/re-leased.ts";

/** Every 30 minutes: new applicant contacts from Re-Leased (tagged as applicants) into the store. */
export async function intake(ctx: Ctx<Settings>) {
  const last = await ctx.store.get<{ at: string }>("state", "intake");
  let added = 0;
  for (const a of await applicantContacts(ctx, last?.at)) {
    if (await ctx.store.get("applicants", a.id)) continue;
    await ctx.store.put("applicants", a.id, a);
    added++;
  }
  await ctx.store.put("state", "intake", { at: ctx.now.toISOString() });
  ctx.log(`intake: ${added} new`);
  return { added };
}

/** Every 30 minutes: read each new applicant's Re-Leased record and move it on to the checks, or park it when the record has no usable email. */
export async function checkRecord(ctx: Ctx<Settings>) {
  const todo = Object.values(await ctx.store.list<Applicant>("applicants")).filter((a) => a.status === "new" || a.status === "needs-contact-details");
  let ready = 0, parked = 0;
  for (const a of todo) {
    const c = await readContact(ctx, a.id);
    if (!c) { await ctx.store.put("applicants", a.id, { ...a, status: "needs-contact-details", reason: "contact not found in Re-Leased" }); parked++; continue; }
    const email = c.email ?? a.email;
    if (!email) { await ctx.store.put("applicants", a.id, { ...a, status: "needs-contact-details", reason: "no valid email on the contact" }); parked++; continue; }
    await ctx.store.put("applicants", a.id, { ...a, name: c.name ?? a.name, email, status: "awaiting-checks", reason: undefined });
    ready++;
  }
  ctx.log(`check-record: ${ready} awaiting checks, ${parked} parked`);
  return { awaiting_checks: ready, parked };
}

/** Every 30 minutes: an applicant a person has approved gets a tenancy queued for approval. The queue de-duplicates by applicant, so a re-run never queues twice. */
export async function lease(ctx: Ctx<Settings>) {
  const approved = Object.values(await ctx.store.list<Applicant>("applicants")).filter((a) => a.status === "approved");
  let queued = 0;
  for (const a of approved) {
    const body = tenancyBody(ctx, a);
    const summary = `create tenancy "${body.Title}" from ${body.StartDate.slice(0, 10)} to ${body.EndDate.slice(0, 10)}`;
    await ctx.queue({ platform: "re-leased", op: "Tenancies_Post", key: `lease:${a.id}`, summary,
      input: { params: { "Idempotency-Key": `lease-${a.id}` }, body } }, summary);
    queued++;
  }
  ctx.log(`lease: ${queued} approved applicants checked for a queued tenancy`);
  return { checked: queued };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { intake, "check-record": checkRecord, lease };
