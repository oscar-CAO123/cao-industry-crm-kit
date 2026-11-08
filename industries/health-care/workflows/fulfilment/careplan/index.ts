// The care plan workflow's three crons. Each is deterministic: it reads, drafts and queues; it never sends.
// The clinician writes the plan in the note and signs it off in Cliniko, and a person approves each intake form.
import type { Ctx, Approval } from "../../../../../core/workflows/runtime.ts";
import type { Enquiry, Settings } from "./types.ts";
import { numericId } from "./types.ts";
import { newPatients, referralOf, draftCareNote, queueIntakeForm, formCompleted } from "./adapters/cliniko.ts";

const P = "cliniko";

/** Every 30 minutes: new patients from the lookback window, each with its referral source. */
export async function intake(ctx: Ctx<Settings>) {
  let added = 0;
  for (const p of await newPatients(ctx)) {
    const key = `${P}:${p.patient_id}`;
    if (await ctx.store.get("enquiries", key)) continue;
    const referral = await referralOf(ctx, p.patient_id);
    await ctx.store.put("enquiries", key, { id: key, patient_id: p.patient_id, created: p.created, referral, status: "new" } satisfies Enquiry);
    added++;
  }
  ctx.log(`intake: ${added} new`);
  return { added };
}

/** Every 30 minutes: a care plan note draft for each new patient, and the intake form queued for approval. */
export async function draft(ctx: Ctx<Settings>) {
  const todo = Object.values(await ctx.store.list<Enquiry>("enquiries")).filter((e) => e.status === "new");
  let drafted = 0;
  for (const e of todo) {
    let noteId = e.note_id;
    if (!noteId) {
      noteId = await draftCareNote(ctx, e.patient_id, numericId(ctx.settings.care_plan_template_id));
      await ctx.store.put("enquiries", e.id, { ...e, note_id: noteId });   // saved at once, so a re-run never makes a second note
    }
    await queueIntakeForm(ctx, e.patient_id, numericId(ctx.settings.intake_form_template_id));   // queued once per patient
    await ctx.store.put("enquiries", e.id, { ...e, note_id: noteId, status: "drafted" } satisfies Enquiry);
    drafted++;
  }
  ctx.log(`draft: ${drafted} drafted`);
  return { drafted };
}

/** Daily: record which approved intake forms the patient has completed. */
export async function forms(ctx: Ctx<Settings>) {
  const approved = Object.values(await ctx.store.list<Approval>("approvals")).filter((a) =>
    a.workflow === ctx.workflow.id && a.status === "done" && a.acts[0]?.op === "patient-form.createpatientform");
  let completed = 0;
  for (const ap of approved) {
    const formId = ap.results?.[0]?.ref?.id;
    if (!formId || !/^\d{1,20}$/.test(formId)) continue;
    const key = `form:${formId}`;
    if (await ctx.store.get("forms", key)) continue;
    if (!(await formCompleted(ctx, formId))) continue;
    await ctx.store.put("forms", key, { form_id: formId, completed_at: ctx.now.toISOString() });
    completed++;
  }
  ctx.log(`forms: ${completed} completed`);
  return { completed };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { intake, draft, forms };
