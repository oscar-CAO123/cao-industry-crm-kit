// The forms-typed-by-hand workflow's three crons. Each is deterministic: it reads form responses, drafts the chase
// email and queues its send for approval. It never sends. Entering a complete submission into the business's own
// system stays with the adviser (see SKILL.md).
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { FormSpec, Settings, Submission } from "./types.ts";
import { google, chaseHtml } from "./adapters/google-workspace.ts";
import { keyOf, cell } from "../../../../construction/workflows/sales/quoting/types.ts";

const DAY = 864e5;
const FORM = /^[A-Za-z0-9_-]{1,100}$/;
const QUESTION = /^[A-Za-z0-9_-]{1,64}$/;

/** The configured forms, checked once here: a bad id stops the run before any network call. */
function forms(s: Settings): FormSpec[] {
  if (!s.forms?.length) throw new Error("forms: no form is set");
  for (const f of s.forms) {
    if (!FORM.test(f.form_id)) throw new Error("forms: bad form id");
    for (const x of f.fields) if (!QUESTION.test(x.question_id)) throw new Error("forms: bad question id");
  }
  return s.forms;
}
const missingOf = (f: FormSpec, answers: Record<string, string>) =>
  f.fields.filter((x) => x.required && !answers[x.question_id]).map((x) => x.label);
const blankSubmission = (id: string, f: FormSpec, r: { response_id: string; seen: string; email?: string; answers: Record<string, string> }, now: Date): Submission =>
  ({ id, form_id: f.form_id, form: f.label, response_id: r.response_id, email: r.email, received: now.toISOString(), seen: r.seen,
     answers: r.answers, status: "new", chased: [], drafts: [] });

/** Every 15 minutes: new responses from each form. A response edited since it was read is picked up again. */
export async function intake(ctx: Ctx<Settings>) {
  let added = 0, updated = 0;
  for (const f of forms(ctx.settings)) {
    for (const r of await google.responses(ctx, f.form_id)) {
      const id = keyOf(`gforms:${f.form_id}:${r.response_id}`);
      const old = await ctx.store.get<Submission>("submissions", id);
      if (!old) { await ctx.store.put("submissions", id, blankSubmission(id, f, r, ctx.now)); added++; continue; }
      if (old.seen !== r.seen) {
        await ctx.store.put("submissions", id, { ...old, seen: r.seen, answers: r.answers, email: r.email ?? old.email, status: "new", missing: undefined, sheet: undefined });
        updated++;
      }
    }
  }
  ctx.log(`intake: ${added} new, ${updated} updated`);
  return { added, updated };
}

/** Queue one chase: draft it once (a re-run reuses the draft), then queue its send for approval. */
async function chase(ctx: Ctx<Settings>, s: Submission, spec: FormSpec, missing: string[]) {
  const n = s.chased.length + 1;
  if (!s.drafts[n - 1]) {
    s.drafts[n - 1] = await google.chaseDraft(ctx, s.email!, `Your ${spec.label}: what we still need`, chaseHtml(ctx.settings.business_name ?? "", spec.label, missing));
    await ctx.store.put("submissions", s.id, s);
  }
  await ctx.queue(google.sendAct(s.drafts[n - 1], s.email!, `chase${n}:${s.id}`), `send chase ${n} to ${s.email} for ${spec.label}: ${missing.join(", ")}`);
  s.status = "chasing";
  s.missing = missing;
  s.chased.push(ctx.now.toISOString());
  await ctx.store.put("submissions", s.id, s);
}

/** Every 30 minutes: complete submissions are marked ready with their field sheet; incomplete ones are chased once. */
export async function draft(ctx: Ctx<Settings>) {
  const specs = new Map(forms(ctx.settings).map((f) => [f.form_id, f]));
  let ready = 0, chasing = 0, needs = 0;
  for (const s of Object.values(await ctx.store.list<Submission>("submissions"))) {
    if (s.status !== "new" && s.status !== "needs-contact") continue;
    const spec = specs.get(s.form_id);
    if (!spec) continue;
    const miss = missingOf(spec, s.answers);
    if (!miss.length) {
      s.status = "ready"; s.missing = []; s.sheet = spec.fields.map((x): [string, string] => [x.label, cell(s.answers[x.question_id] ?? "")]);
      await ctx.store.put("submissions", s.id, s); ready++; continue;
    }
    if (!s.email) { s.status = "needs-contact"; s.missing = miss; await ctx.store.put("submissions", s.id, s); needs++; continue; }
    await chase(ctx, s, spec, miss); chasing++;
  }
  ctx.log(`draft: ${ready} ready, ${chasing} chase queued, ${needs} need a contact`);
  return { ready, chasing, needs_contact: needs };
}

/** Daily: chasing submissions that are now complete become ready; the rest get the next chase when it is due. */
export async function followUp(ctx: Ctx<Settings>) {
  const specs = new Map(forms(ctx.settings).map((f) => [f.form_id, f]));
  const days = ctx.settings.chase?.after_days ?? [3, 7];
  let queued = 0;
  for (const s of Object.values(await ctx.store.list<Submission>("submissions"))) {
    if (s.status !== "chasing" || !s.email) continue;
    const spec = specs.get(s.form_id);
    if (!spec) continue;
    const miss = missingOf(spec, s.answers);
    if (!miss.length) { s.status = "ready"; s.missing = []; s.sheet = spec.fields.map((x): [string, string] => [x.label, cell(s.answers[x.question_id] ?? "")]); await ctx.store.put("submissions", s.id, s); continue; }
    const next = s.chased.length + 1;                       // chase number: 1 is the first, then one per after_days entry
    if (next > days.length + 1) continue;
    if (ctx.now.getTime() - Date.parse(s.chased.at(-1)!) < days[next - 2] * DAY) continue;
    await chase(ctx, s, spec, miss); queued++;
  }
  ctx.log(`follow-up: ${queued} queued`);
  return { queued };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { intake, draft, "follow-up": followUp };
