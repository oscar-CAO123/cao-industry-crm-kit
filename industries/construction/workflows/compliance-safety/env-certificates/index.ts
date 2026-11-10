// The paperwork workflow's three crons. Each reads and writes only the store, except chase, which queues an email for approval.
// The judgment steps (which certificate applies, whether the network application is lodged) belong to the agent skill in SKILL.md.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { Settings, Tracked } from "./types.ts";
import * as s8 from "./adapters/servicem8.ts";

const DAY = 864e5;

/** Every 30 minutes: track active jobs whose text names solar, battery or certificate paperwork. */
export async function register(ctx: Ctx<Settings>) {
  const words = (ctx.settings.keywords ?? []).map((k) => k.toLowerCase());
  let added = 0;
  for (const j of await s8.activeJobs(ctx)) {
    const text = `${j.job_description ?? ""} ${j.work_done_description ?? ""} ${j.job_address ?? ""}`.toLowerCase();
    if (!words.some((w) => text.includes(w))) continue;
    if (await ctx.store.get("jobs", j.uuid)) continue;
    await ctx.store.put("jobs", j.uuid, { uuid: j.uuid, title: String(j.job_description ?? "Paperwork job").slice(0, 120),
      address: String(j.job_address ?? "").slice(0, 200), company_uuid: j.company_uuid, missing: [] } satisfies Tracked);
    added++;
  }
  ctx.log(`register: ${added} new`);
  return { added };
}

/** Daily: check each tracked job's attachments against the evidence list and record what is still missing. */
export async function evidence(ctx: Ctx<Settings>) {
  const jobs = Object.values(await ctx.store.list<Tracked>("jobs"));
  let open = 0;
  for (const t of jobs) {
    const files = (await s8.attachments(ctx, t.uuid)).map((a) => `${a.attachment_name ?? ""} ${a.file_type ?? ""}`.toLowerCase());
    t.missing = Object.entries(ctx.settings.evidence ?? {})
      .filter(([, terms]) => !files.some((f) => terms.some((x) => f.includes(String(x).toLowerCase()))))
      .map(([label]) => label);
    t.checked = ctx.now.toISOString();
    await ctx.store.put("jobs", t.uuid, t);
    if (t.missing.length) open++;
  }
  ctx.log(`evidence: ${open} of ${jobs.length} still missing something`);
  return { checked: jobs.length, missing: open };
}

/** Daily: for jobs still missing evidence, queue one chase email per job for approval. Never sends. */
export async function chase(ctx: Ctx<Settings>) {
  const every = (ctx.settings.chase_every_days ?? 3) * DAY;
  let queued = 0;
  for (const t of Object.values(await ctx.store.list<Tracked>("jobs"))) {
    if (!t.missing.length) continue;
    if (t.chased_at && ctx.now.getTime() - Date.parse(t.chased_at) < every) continue;
    const c = await s8.contact(ctx, t.company_uuid);
    if (!c.email) { ctx.log(`chase: no valid email on ${t.uuid}`); continue; }
    const text = `Hi ${c.name ?? "there"}, to finish the paperwork for ${t.title} we still need: ${t.missing.join(", ")}. Reply to this email with them.`;
    const n = (t.chases ?? 0) + 1;                       // each interval gets its own approval
    await s8.queueChase(ctx, t, n, c.email, text);
    await ctx.store.put("jobs", t.uuid, { ...t, chases: n, chased_at: ctx.now.toISOString() });
    queued++;
  }
  ctx.log(`chase: ${queued} queued for approval`);
  return { queued };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { register, evidence, chase };
