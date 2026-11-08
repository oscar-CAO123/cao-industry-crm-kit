// The diagnostic write-up workflow's three crons. Each is deterministic: it reads, drafts an internal note, and queues.
// It never sends. The shop finishes the write-up (edits the note, then removes the DRAFT marker); only then is the
// customer email queued for approval.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { Diagnosis, Settings } from "./types.ts";
import { DRAFT_MARK, esc, keyOf } from "./types.ts";
import { openJobs, contactFor, techNotes, photosOn, fileNote, readNote, queueEmail } from "./adapters/servicem8.ts";

/** Every 10 minutes: jobs waiting for a write-up. */
export async function intake(ctx: Ctx<Settings>) {
  let added = 0;
  for (const j of await openJobs(ctx)) {
    const id = `servicem8:${j.uuid}`;
    if (await ctx.store.get("diagnoses", id)) continue;
    const d: Diagnosis = { id, job_uuid: j.uuid, title: String(j.job_description ?? "Diagnostic job").slice(0, 120),
      address: String(j.job_address ?? "").slice(0, 200), contact: await contactFor(ctx, j.company_uuid),
      received: String(j.date ?? ctx.now.toISOString()), status: "new" };
    await ctx.store.put("diagnoses", id, d);
    added++;
  }
  ctx.log(`intake: ${added} new`);
  return { added };
}

/** Every 15 minutes: write the technician's notes up as an internal job note marked DRAFT. Parks jobs with too little to go on. */
export async function draft(ctx: Ctx<Settings>) {
  const min = ctx.settings.min_note_chars ?? 40;
  const todo = Object.values(await ctx.store.list<Diagnosis>("diagnoses")).filter((d) => d.status === "new" || d.status === "needs-notes");
  let drafted = 0, parked = 0;
  for (const d of todo) {
    const notes = await techNotes(ctx, d.job_uuid);
    const body = notes.map((n) => n.text).join("\n").trim();
    if (body.length < min) {
      parked++;
      await ctx.store.put("diagnoses", d.id, { ...d, status: "needs-notes", reason: `technician notes under ${min} characters` });
      continue;
    }
    const photos = await photosOn(ctx, d.job_uuid);
    const text = [
      `${DRAFT_MARK}: check this, rewrite it in plain words for the customer, then delete this first line.`,
      `Vehicle: ${d.title}`,
      "Technician notes:",
      body,
      `Photos on the job: ${photos.length}${photos.length ? ` (${photos.slice(0, 10).join(", ")})` : ""}`,
      "Recommended work: to be confirmed by the workshop before this goes to the customer.",
    ].join("\n");
    const note_uuid = await fileNote(ctx, d.job_uuid, text);
    // Remember the note at once: a re-run must not file a second one if a later step fails.
    await ctx.store.put("diagnoses", d.id, { ...d, status: "drafted", note_uuid, photos: photos.length, reason: undefined });
    drafted++;
  }
  ctx.log(`draft: ${drafted} drafted, ${parked} need notes`);
  return { drafted, needs_notes: parked };
}

/** Hourly: queue the write-up email for any drafted note the shop has finished. Reads the note as it now stands. */
export async function queue(ctx: Ctx<Settings>) {
  let queued = 0, waiting = 0;
  for (const d of Object.values(await ctx.store.list<Diagnosis>("diagnoses"))) {
    if (d.status !== "drafted" || !d.note_uuid) continue;
    const text = await readNote(ctx, d.note_uuid);
    if (!text || text.startsWith(DRAFT_MARK)) { waiting++; continue; }
    if (!d.contact.email) {
      await ctx.store.put("diagnoses", d.id, { ...d, status: "no-email", reason: "no customer email on the job: send it from the shop system" });
      continue;
    }
    const html = text.split(/\n+/).map((l) => `<p>${esc(l)}</p>`).join("");
    await queueEmail(ctx, d.job_uuid, d.contact.email, ctx.settings.email_subject ?? "Your vehicle diagnostic write-up",
      `<p>Hi ${esc(d.contact.name ?? "there")},</p>${html}<p>${esc(ctx.settings.business_name ?? "")}</p>`, keyOf(d.id));
    await ctx.store.put("diagnoses", d.id, { ...d, status: "queued", queued_at: ctx.now.toISOString() });
    queued++;
  }
  ctx.log(`queue: ${queued} queued, ${waiting} still DRAFT`);
  return { queued, waiting };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { intake, draft, queue };
