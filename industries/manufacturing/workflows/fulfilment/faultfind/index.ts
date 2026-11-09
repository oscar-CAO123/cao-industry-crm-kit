// The breakdown fix finder's four crons. Each reads, drafts or queues; none sends. Judgment (the cause, the repair,
// the return to production) stays with the technician and the agent skill in SKILL.md.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Fault, type Settings, EMAIL, UUID, breakdownStatus } from "./types.ts";
import { uuid, list, priorNotes, partsOnHand, noteOn, escalationAct } from "./adapters/servicem8.ts";

const HOUR = 36e5;
const faults = (ctx: Ctx<Settings>) => ctx.store.list<Fault>("faults");

/** Every 15 minutes: open breakdown jobs in ServiceM8 become fault records. A job already seen is skipped. */
export async function intake(ctx: Ctx<Settings>) {
  const status = breakdownStatus(ctx.settings);
  let added = 0;
  for (const j of await list<any>(ctx, "servicem8-api.listJobs", `status eq '${status}'`)) {
    if (j.active === 0 || !UUID.test(String(j.uuid ?? ""))) continue;
    const id = `servicem8:${j.uuid}`;
    if (await ctx.store.get("faults", id)) continue;
    await ctx.store.put("faults", id, {
      id, job_uuid: j.uuid, company_uuid: UUID.test(String(j.company_uuid ?? "")) ? j.company_uuid : undefined,
      title: String(j.job_description ?? "Breakdown").slice(0, 120), text: String(j.job_description ?? "").slice(0, 2000),
      address: String(j.job_address ?? "").slice(0, 200), seen: ctx.now.toISOString(), status: "new",
    } satisfies Fault);
    added++;
  }
  ctx.log(`intake: ${added} new`);
  return { added };
}

/** Every 30 minutes: draft one fault-finding note per new breakdown from the customer's earlier jobs and the parts on hand. */
export async function diagnose(ctx: Ctx<Settings>) {
  let drafted = 0;
  for (const f of Object.values(await faults(ctx))) {
    if (f.status !== "new") continue;
    // Marked before the write: a crash leaves it at "triaging" for a person to check, so a note is never written twice.
    await ctx.store.put("faults", f.id, { ...f, status: "triaging" } satisfies Fault);
    const history = f.company_uuid ? await priorNotes(ctx, f.company_uuid, f.job_uuid) : [];
    const stock = await partsOnHand(ctx);
    const text = [
      `Fault-finding draft for: ${f.title}. For the technician to check; it is not a diagnosis.`,
      "Make the machine safe before any inspection, to the site's own isolation and lock-out procedure.",
      history.length ? `Earlier jobs for this customer:\n- ${history.join("\n- ")}` : "No earlier jobs found for this customer.",
      stock.length ? `Parts on hand: ${stock.join(", ")}.` : "No parts on hand are on the stock list.",
      `Reported: ${f.text}`,
    ].join("\n\n");
    await noteOn(ctx, f.job_uuid, text, `fault-finding note on ${f.title}`);
    await ctx.store.put("faults", f.id, { ...f, status: "triaged" } satisfies Fault);
    drafted++;
  }
  ctx.log(`diagnose: ${drafted} drafted`);
  return { drafted };
}

/** Hourly: a breakdown still open past the window gets an escalation email queued for approval. Nothing is sent here. */
export async function escalate(ctx: Ctx<Settings>) {
  const hours = ctx.settings.escalate_after_hours ?? 4;
  const to = ctx.settings.escalation_email;
  let queued = 0, closed = 0;
  for (const f of Object.values(await faults(ctx))) {
    if (f.status !== "triaged") continue;
    const [j] = await list<any>(ctx, "servicem8-api.listJobs", `uuid eq '${uuid(f.job_uuid)}'`);
    if (!j) { ctx.log(`escalate: ${f.id} not found in ServiceM8, skipped`); continue; }
    if (j.status === "Completed") continue;                                   // the record cron takes completed jobs
    if (j.status !== breakdownStatus(ctx.settings)) { await ctx.store.put("faults", f.id, { ...f, status: "closed" } satisfies Fault); closed++; continue; }
    if (ctx.now.getTime() - Date.parse(f.seen) < hours * HOUR) continue;
    if (!to || !EMAIL.test(to)) { ctx.log(`escalate: ${f.id} is overdue but settings.escalation_email is not a valid address`); continue; }
    const subjectTitle = f.title.replace(/[\u0000-\u001f\u007f]/g, " ");   // the title is customer text: no line breaks in a subject
    const act = escalationAct(f.job_uuid, `escalate:${f.id}`, to, `Breakdown still open: ${subjectTitle}`.slice(0, 150),
      `The breakdown "${f.title}" at ${f.address || "the site"} has been open for ${hours} hours or more. Please check it.`,
      `Escalate ${f.title} to ${to}: open ${hours}+ hours`);
    await ctx.queue(act);
    await ctx.store.put("faults", f.id, { ...f, status: "escalation-queued" } satisfies Fault);
    queued++;
  }
  ctx.log(`escalate: ${queued} queued, ${closed} closed`);
  return { queued, closed };
}

/** Hourly: a completed breakdown job gets a repair record drafted from the parts used on it. */
export async function record(ctx: Ctx<Settings>) {
  let recorded = 0;
  for (const f of Object.values(await faults(ctx))) {
    if (f.status !== "triaged" && f.status !== "escalation-queued") continue;
    const [j] = await list<any>(ctx, "servicem8-api.listJobs", `uuid eq '${uuid(f.job_uuid)}'`);
    if (j?.status !== "Completed") continue;
    const used = await list<any>(ctx, "servicem8-api.listJobMaterials", `job_uuid eq '${uuid(f.job_uuid)}'`);
    const parts = used.filter((m) => m.name).slice(0, 30).map((m) => `${String(m.name).slice(0, 80)} x${String(m.quantity ?? "1")}`);
    const text = `Repair record for: ${f.title}.\n\nParts and materials on the job: ${parts.length ? parts.join(", ") : "none recorded"}.\n\nThe technician adds the cause found and the test-return result.`;
    await noteOn(ctx, f.job_uuid, text, `repair record on ${f.title}`);
    await ctx.store.put("faults", f.id, { ...f, status: "recorded" } satisfies Fault);
    recorded++;
  }
  ctx.log(`record: ${recorded} drafted`);
  return { recorded };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { intake, diagnose, escalate, record };
