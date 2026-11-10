import { viewingFeedback } from "./adapters/rex.ts";
// The inspections workflow's three crons. Each is deterministic: it reads, drafts an internal note, or queues one email.
// Judgment (who attends, the condition of the property, whether the photos are right) stays with a person.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { Inspection, Settings } from "./types.ts";
import { openInspections, findingsFor, draftNote, reportHtml } from "./adapters/servicem8.ts";

function onRex(ctx: Ctx<Settings>) {
  const p = ctx.settings.platform ?? "servicem8";
  if (p !== "rex" && p !== "servicem8") throw new Error("inspections: platform must be rex or servicem8");
  return p === "rex";
}
const MAX_PHOTOS = (s: Settings) => Math.min(Math.max(Number(s.report_max_photos ?? 10), 0), 20);

/** Every 15 minutes: inspection jobs booked in ServiceM8. A job already known keeps its draft state. */
export async function intake(ctx: Ctx<Settings>) {
  if (onRex(ctx)) return viewingFeedback(ctx);
  let added = 0;
  for (const j of await openInspections(ctx)) {
    const old = await ctx.store.get<Inspection>("inspections", j.id);
    if (old) {
      await ctx.store.put("inspections", j.id, { ...old, address: j.address, contact: j.contact, assigned: j.assigned, visited: j.visited });
      continue;
    }
    await ctx.store.put("inspections", j.id, { ...j, status: "open" } satisfies Inspection);
    added++;
  }
  ctx.log(`intake: ${added} new`);
  return { added };
}

/** Every 30 minutes: for each finished visit, write the staff notes and photo count into one internal note on the job. */
export async function draft(ctx: Ctx<Settings>) {
  if (onRex(ctx)) { ctx.log("Rex viewing feedback only; no property condition report"); return { drafted: 0 }; }
  const todo = Object.values(await ctx.store.list<Inspection>("inspections")).filter((i) => i.status === "open" && i.visited);
  let drafted = 0;
  for (const i of todo) {
    const { notes, photos } = await findingsFor(ctx, i.job_uuid);
    const text = `Inspection report draft, for review. Not sent.\n\nStaff notes:\n${notes.length ? notes.map((n) => `- ${n}`).join("\n") : "- none recorded"}\n\nPhotos on the job: ${photos.length}`;
    const note = await draftNote(ctx, i.job_uuid, text);
    // Stored at once: a later run never writes a second draft for the same visit.
    const fresh = (await ctx.store.get<Inspection>("inspections", i.id)) ?? i;
    await ctx.store.put("inspections", i.id, { ...fresh, status: "drafted", findings: notes.join("\n"), photos, draft_note: note });
    drafted++;
  }
  ctx.log(`draft: ${drafted} drafted`);
  return { drafted };
}

/** Hourly: queue the owner's report email for approval. Waits when there is no owner email or no findings yet. */
export async function report(ctx: Ctx<Settings>) {
  if (onRex(ctx)) return { queued: 0, waiting: 0 };
  let queued = 0, waiting = 0;
  for (const i of Object.values(await ctx.store.list<Inspection>("inspections"))) {
    if (i.status !== "drafted") continue;
    if (!i.contact.email || !i.findings) { waiting++; ctx.log(`report waits on ${i.job_uuid}: ${i.contact.email ? "no findings yet" : "no owner email on the job"}`); continue; }
    const photos = (i.photos ?? []).slice(0, MAX_PHOTOS(ctx.settings));
    const id = await ctx.queue({
      platform: "servicem8", op: "messaging-api.send_email", key: `report:${i.job_uuid}`,
      summary: `Email inspection report for ${i.address || i.job_uuid} to ${i.contact.email}: ${photos.length} photos. Findings: ${i.findings.slice(0, 300)}`,
      input: { body: { to: i.contact.email, subject: `Inspection report: ${i.address || "your property"}`.slice(0, 200), htmlBody: reportHtml(ctx.settings, i),
                       regardingJobUUID: i.job_uuid, ...(photos.length ? { attachments: photos } : {}) } },
    });
    await ctx.store.put("inspections", i.id, { ...i, status: "queued", approval: id });
    queued++;
  }
  ctx.log(`report: ${queued} queued, ${waiting} waiting`);
  return { queued, waiting };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { intake, draft, report };
