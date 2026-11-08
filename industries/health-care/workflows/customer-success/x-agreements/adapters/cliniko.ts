// Cliniko: an agreement is a patient form made from the business's agreement template. The cron drafts it in the patient's
// record and never sends it: Cliniko's API maps no send, so a person sends it from the patient record.
// Field names come from Cliniko's official OpenAPI pages for patient-case, patient-form and signature (mapped in ops.json).
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { ID, id, type Settings } from "../types.ts";

const P = "cliniko";
// A list reply is the resource under its plural key, or a bare array. Nothing else is assumed.
const rows = (d: any, key: string): any[] => (Array.isArray(d) ? d : Array.isArray(d?.[key]) ? d[key] : []);

/** Active patient cases: a patient with an ongoing service may need an agreement. Closed or malformed cases are skipped. */
export async function activeCases(ctx: Ctx<Settings>): Promise<{ patient_id: string }[]> {
  const per_page = Math.min(Math.max(Number(ctx.settings.cases_per_run) || 100, 1), 100);
  const r = await ctx.draft<any>({ platform: P, op: "patient-case.listactivepatientcases", summary: "read active patient cases", input: { params: { per_page } } });
  const out: { patient_id: string }[] = [];
  for (const c of rows(r.data, "patient_cases")) {
    if (c?.closed === true || !ID.test(String(c?.patient_id ?? ""))) continue;
    out.push({ patient_id: String(c.patient_id) });
  }
  return out;
}

/** Drafts the agreement as an unsent form in the patient's record. Returns the new form's id. */
export async function draftAgreement(ctx: Ctx<Settings>, patientId: string, templateId: string): Promise<string> {
  const r = await ctx.draft<any>({ platform: P, op: "patient-form.createpatientform", summary: `draft agreement form for patient ${patientId}`,
    input: { params: { patient_id: id(patientId, "patient"), patient_form_template_id: id(templateId, "agreement template"), email_to_patient_on_completion: false } } });
  return id(r.data?.id, "new patient form");
}

/** One patient form, read fresh. */
export async function getForm(ctx: Ctx<Settings>, formId: string): Promise<any> {
  const r = await ctx.draft<any>({ platform: P, op: "patient-form.getpatientform", summary: `read patient form ${formId}`, input: { params: { id: id(formId, "patient form") } } });
  return r.data;
}

/** Queued for a person's approval only: expiring a form changes what the patient sees. */
export function queueExpiry(ctx: Ctx<Settings>, formId: string): Promise<string> {
  const fid = id(formId, "patient form");
  return ctx.queue({ platform: P, op: "patient-form.updatepatientform", key: `expire:${fid}`, summary: `expire unsigned agreement form ${fid}`,
    input: { params: { id: fid, expired: true } } });
}

/** The signature on a completed form, read for the register. */
export async function getSignature(ctx: Ctx<Settings>, formId: string, signatureId: string): Promise<any> {
  const r = await ctx.draft<any>({ platform: P, op: "signature.getsignature", summary: `read signature ${signatureId}`,
    input: { params: { patient_form_id: id(formId, "patient form"), id: id(signatureId, "signature") } } });
  return r.data;
}
