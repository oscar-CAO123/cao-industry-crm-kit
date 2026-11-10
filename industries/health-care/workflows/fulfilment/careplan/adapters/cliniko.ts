// Cliniko: the practice system. Reads new patients and their referral source, drafts a care plan note (draft: true,
// so a clinician finalises it in Cliniko), and queues the intake form for approval. Nothing reaches a patient from a cron.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { ApiError } from "../../../../../../core/lib/http.ts";
import { type Settings, numericId } from "../types.ts";

const P = "cliniko";
const DAY = 864e5;

/** Patients created inside the lookback window (first page of 100; a warning is logged when there are more). */
export async function newPatients(ctx: Ctx<Settings>): Promise<{ patient_id: string; created: string }[]> {
  const since = new Date(ctx.now.getTime() - (ctx.settings.lookback_days ?? 14) * DAY).toISOString().replace(/\.\d{3}Z$/, "Z");
  const r = await ctx.draft<{ patients?: any[]; total_entries?: number }>({ platform: P, op: "patient.listpatients", summary: "new patients",
    input: { params: { per_page: 100, "q[]": [`created_at:>=${since}`] } } });
  const rows = r.data?.patients ?? [];
  if ((r.data?.total_entries ?? 0) > rows.length) ctx.log(`cliniko: ${r.data?.total_entries} new patients, first ${rows.length} read`);
  const out: { patient_id: string; created: string }[] = [];
  for (const p of rows) {
    const id = String(p?.id ?? "");
    if (!/^\d{1,20}$/.test(id)) { ctx.log("cliniko: skipped a patient with an unexpected id"); continue; }
    out.push({ patient_id: id, created: String(p.created_at ?? ctx.now.toISOString()) });
  }
  return out;
}

/** The referral source type's name for a patient, or null when Cliniko holds no referral source for them (404). */
export async function referralOf(ctx: Ctx<Settings>, patientId: string): Promise<string | null> {
  try {
    const r = await ctx.draft<any>({ platform: P, op: "referral-source.getreferralsource", summary: "referral source",
      input: { params: { patient_id: numericId(patientId) } } });
    return String(r.data?.referral_source_type?.name ?? "") || null;
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

/** A care plan note from the clinic's template, saved as a draft. Returns the note id. */
export async function draftCareNote(ctx: Ctx<Settings>, patientId: string, templateId: string): Promise<string> {
  const r = await ctx.draft<any>({ platform: P, op: "treatment-note.createtreatmentnote", summary: `draft care plan note for patient ${patientId}`,
    input: { params: { patient_id: numericId(patientId), treatment_note_template_id: numericId(templateId), title: "Care plan (draft)", draft: true } } });
  return numericId(r.data?.id);
}

/** Queues the intake form for a person to approve. The key is the patient, so a re-run never queues it twice. */
export async function queueIntakeForm(ctx: Ctx<Settings>, patientId: string, templateId: string): Promise<string> {
  return ctx.queue({ platform: P, op: "patient-form.createpatientform", key: `form:${patientId}`,
    input: { params: { patient_id: numericId(patientId), patient_form_template_id: numericId(templateId), name: "Intake assessment", email_to_patient_on_completion: false } } },
    `Create the intake assessment form for patient ${patientId} in Cliniko (a person sends it)`);
}

/** Whether a created intake form has been completed. */
export async function formCompleted(ctx: Ctx<Settings>, formId: string): Promise<boolean> {
  const r = await ctx.draft<any>({ platform: P, op: "patient-form.getpatientform", summary: "intake form status",
    input: { params: { id: numericId(formId) } } });
  return r.data?.completed === true;
}
