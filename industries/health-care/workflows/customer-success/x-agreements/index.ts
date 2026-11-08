// The service agreements workflow's three crons. Each reads and drafts, or queues for approval. None sends.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { activeCases, draftAgreement, getForm, getSignature, queueExpiry } from "./adapters/cliniko.ts";
import { DAY, ID, id, type Agreement, type Settings } from "./types.ts";

/** Every 30 minutes: an active patient case with no agreement yet gets one, drafted unsent in the patient's record. */
export async function intake(ctx: Ctx<Settings>) {
  const templateId = id(ctx.settings.cliniko.agreement_template_id, "agreement template");
  let drafted = 0, skipped = 0;
  for (const c of await activeCases(ctx)) {
    const key = `${c.patient_id}:${templateId}`;
    if (await ctx.store.get("agreements", key)) { skipped++; continue; }
    const formId = await draftAgreement(ctx, c.patient_id, templateId);
    await ctx.store.put("agreements", key, { key, patient_id: c.patient_id, template_id: templateId, form_id: formId, created: ctx.now.toISOString() } satisfies Agreement);
    drafted++;
  }
  ctx.log(`intake: ${drafted} drafted, ${skipped} already had one`);
  return { drafted, skipped };
}

/** Daily: an agreement still unsigned after the set days gets an expiry queued for approval. The reminder itself is sent by a person. */
export async function chase(ctx: Ctx<Settings>) {
  const days = ctx.settings.expire_after_days ?? 21;
  let queued = 0;
  for (const a of Object.values(await ctx.store.list<Agreement>("agreements"))) {
    if (a.expiry_queued || a.filed) continue;
    if (ctx.now.getTime() - Date.parse(a.created) < days * DAY) continue;
    const f = await getForm(ctx, a.form_id);
    if (f?.completed === true) continue;                      // file-record logs it
    if (f?.expired !== true) { await queueExpiry(ctx, a.form_id); queued++; }
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
    const f = await getForm(ctx, a.form_id);
    if (f?.completed !== true) continue;
    const sig = Array.isArray(f.signatures) ? f.signatures[0] : undefined;
    const signatureId = ID.test(String(sig?.id ?? "")) ? String(sig.id) : undefined;
    const signature = signatureId ? await getSignature(ctx, a.form_id, signatureId) : undefined;
    await ctx.store.put("register", a.form_id, { form_id: a.form_id, patient_id: a.patient_id, template_id: a.template_id,
      signature_id: signatureId ?? null, signature_read: signature !== undefined, completed_seen: ctx.now.toISOString() });
    a.filed = ctx.now.toISOString();
    await ctx.store.put("agreements", a.key, a);
    filed++;
  }
  ctx.log(`file-record: ${filed} filed`);
  return { filed };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { intake, chase, "file-record": fileRecord };
