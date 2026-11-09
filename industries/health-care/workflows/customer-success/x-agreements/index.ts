// The service agreements workflow's three crons. Each reads and drafts, or queues for approval. None sends.
import type { Approval, Ctx } from "../../../../../core/workflows/runtime.ts";
import { activeCases, getForm, getSignature, queueAgreement, queueExpiry } from "./adapters/cliniko.ts";
import { DAY, ID, id, type Agreement, type Settings } from "./types.ts";

/** The form id, once a person has approved its creation. Until then there is no form to read or expire. */
async function formOf(ctx: Ctx<Settings>, a: Agreement): Promise<string | undefined> {
  if (a.form_id) return a.form_id;
  const ap = await ctx.store.get<Approval>("approvals", a.approval);
  const created = ap?.status === "done" ? ap.results?.[0]?.ref?.id : undefined;
  if (!created) return undefined;
  a.form_id = id(created, "new patient form");
  a.created = ap?.decided ?? a.created;                       // the clock runs from when the form exists, not from the queue
  await ctx.store.put("agreements", a.key, a);
  return a.form_id;
}

/** Every 30 minutes: an active patient case with no agreement yet gets one queued for approval, then created unsent in the patient's record. */
export async function intake(ctx: Ctx<Settings>) {
  const templateId = id(ctx.settings.cliniko.agreement_template_id, "agreement template");
  let queued = 0, skipped = 0;
  for (const c of await activeCases(ctx)) {
    const key = `${c.patient_id}:${templateId}`;
    if (await ctx.store.get("agreements", key)) { skipped++; continue; }
    const approval = await queueAgreement(ctx, c.patient_id, templateId);
    await ctx.store.put("agreements", key, { key, patient_id: c.patient_id, template_id: templateId, approval, created: ctx.now.toISOString() } satisfies Agreement);
    queued++;
  }
  ctx.log(`intake: ${queued} queued for approval, ${skipped} already had one`);
  return { queued, skipped };
}

/** Daily: an agreement still unsigned after the set days gets an expiry queued for approval. The reminder itself is sent by a person. */
export async function chase(ctx: Ctx<Settings>) {
  const days = ctx.settings.expire_after_days ?? 21;
  let queued = 0;
  for (const a of Object.values(await ctx.store.list<Agreement>("agreements"))) {
    if (a.expiry_queued || a.filed) continue;
    const formId = await formOf(ctx, a);
    if (!formId) continue;                                    // not approved yet, so no form exists
    if (ctx.now.getTime() - Date.parse(a.created) < days * DAY) continue;
    const f = await getForm(ctx, formId);
    if (f?.completed === true) continue;                      // file-record logs it
    if (f?.expired !== true) { await queueExpiry(ctx, formId); queued++; }
    a.expiry_queued = ctx.now.toISOString();                  // queued, or already expired: stop watching it
    await ctx.store.put("agreements", a.key, a);
  }
  ctx.log(`chase: ${queued} expiries queued`);
  return { queued };
}

/** Hourly: a completed agreement is logged once to the internal register, with its signature reference. Nothing is sent. */
export async function fileRecord(ctx: Ctx<Settings>) {
  let filed = 0;
  for (const a of Object.values(await ctx.store.list<Agreement>("agreements"))) {
    if (a.filed || a.expiry_queued) continue;
    const formId = await formOf(ctx, a);
    if (!formId) continue;
    const f = await getForm(ctx, formId);
    if (f?.completed !== true) continue;
    const sig = Array.isArray(f.signatures) ? f.signatures[0] : undefined;
    const signatureId = ID.test(String(sig?.id ?? "")) ? String(sig.id) : undefined;
    const signature = signatureId ? await getSignature(ctx, formId, signatureId) : undefined;
    await ctx.store.put("register", formId, { form_id: formId, patient_id: a.patient_id, template_id: a.template_id,
      signature_id: signatureId ?? null, signature_read: signature !== undefined, completed_seen: ctx.now.toISOString() });
    a.filed = ctx.now.toISOString();
    await ctx.store.put("agreements", a.key, a);
    filed++;
  }
  ctx.log(`file-record: ${filed} filed`);
  return { filed };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { intake, chase, "file-record": fileRecord };
