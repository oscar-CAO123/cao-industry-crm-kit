// ServiceM8: the business's own asset list and workshop jobs. Reads, plus one live operation: the owner's cost summary email,
// which the cron only queues. Field names from ServiceM8's official spec (Asset, Job, JobMaterial, EmailMessage).
// ServiceM8 has no mapped operation that creates an asset, and no confirmed field that links a job to one asset, so
// this adapter reports parts per job, not per machine (see workflow.json gaps).
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, UUID, esc, money, round } from "../types.ts";

const P = "servicem8";

export interface S8Asset { uuid: string; name: string; asset_code: string }
export interface S8Job { uuid: string; description: string }

const list = async <T>(ctx: Ctx<Settings>, op: string, summary: string, filter?: string) =>
  ((await ctx.draft<T[]>({ platform: P, op, summary, input: filter ? { params: { $filter: filter } } : {} })).data ?? []) as T[];

/** Live assets in the business's ServiceM8 account. */
export async function readAssets(ctx: Ctx<Settings>): Promise<S8Asset[]> {
  return (await list<any>(ctx, "servicem8-api.listAssets", "read ServiceM8 assets"))
    .filter((a) => UUID.test(String(a?.uuid ?? "")) && a.active !== 0)
    .map((a) => ({ uuid: String(a.uuid), name: String(a.name ?? "").slice(0, 200), asset_code: String(a.asset_code ?? "").slice(0, 120) }));
}

/** Active jobs in the workshop category. Blank category in settings means no read at all. */
export async function readWorkshopJobs(ctx: Ctx<Settings>): Promise<S8Job[]> {
  const cat = ctx.settings.workshop_category_uuid;
  if (!cat || !UUID.test(cat)) return [];
  return (await list<any>(ctx, "servicem8-api.listJobs", "read workshop jobs", `category_uuid eq '${cat}'`))
    .filter((j) => UUID.test(String(j?.uuid ?? "")) && j.active !== 0)
    .map((j) => ({ uuid: String(j.uuid), description: String(j.job_description ?? "").slice(0, 120) }));
}

/** Parts on one job: the sum of quantity times price across its materials lines (ex GST, as entered). */
export async function readJobParts(ctx: Ctx<Settings>, jobUuid: string): Promise<{ parts: number; lines: number }> {
  if (!UUID.test(jobUuid)) throw new Error("x-plant: bad job uuid");
  const rows = await list<any>(ctx, "servicem8-api.listJobMaterials", `read parts on ${jobUuid}`, `job_uuid eq '${jobUuid}'`);
  let parts = 0, lines = 0;
  for (const r of rows) {
    if (r?.active === 0) continue;
    const price = Number(r.price), qty = Number(r.quantity);
    if (!Number.isFinite(price) || !Number.isFinite(qty)) continue;
    parts += price * qty; lines++;
  }
  return { parts: round(parts), lines };
}

/** Queue the owner's cost summary for approval. Nothing is sent from here. */
export async function queueCostSummary(ctx: Ctx<Settings>, key: string, rows: { description: string; parts_ex_gst: number; lines: number }[], total: number) {
  const body = `<p>Parts on workshop jobs, top ${rows.length} by cost (ex GST, as entered on each job):</p>`
    + `<table cellpadding="4"><tr><th align="left">Job</th><th align="right">Parts</th><th align="right">Lines</th></tr>`
    + rows.map((r) => `<tr><td>${esc(r.description)}</td><td align="right">${esc(money(r.parts_ex_gst))}</td><td align="right">${esc(r.lines)}</td></tr>`).join("")
    + `</table><p>Total on these jobs: ${esc(money(total))}. Check each job in ServiceM8 before acting on it.</p>`;
  return ctx.queue({ platform: P, op: "messaging-api.send_email", key, summary: `Email the workshop cost summary to ${ctx.settings.owner_email} (${rows.length} jobs, ${money(total)} parts)`,
    input: { body: { to: ctx.settings.owner_email, subject: `Workshop parts cost summary (${key.split(":").pop()})`, htmlBody: body } } });
}
