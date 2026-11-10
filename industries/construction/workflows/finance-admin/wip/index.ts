// The WIP and retention workflow's three crons. Each reads, drafts or queues; none sends.
// A progress claim is a DRAFT invoice in Xero until a person approves its authorisation and email. A reminder waits for approval too.
import { type Ctx, type Approval, approvalId } from "../../../../../core/workflows/runtime.ts";
import { clientInvoices, openInvoices, draftClaim, authoriseAct, emailAct } from "./adapters/xero.ts";
import { type Job, type Settings, type Snapshot, type Claim, type Chase, DAY, GUID, round2, money, day, checkJob } from "./types.ts";

/** The jobs in settings that check out. A bad job is skipped with the reason logged, never guessed at. */
function usableJobs(ctx: Ctx<Settings>): Job[] {
  const out: Job[] = [];
  for (const raw of ctx.settings.jobs ?? []) {
    try { out.push(checkJob(raw)); } catch (e: any) { ctx.log(`skip job: ${e.message}`); }
  }
  return out;
}

/** Weekly: each job's billed-to-date (authorised and paid invoices) against its earned value, kept as the WIP position. */
export async function wipSnapshot(ctx: Ctx<Settings>) {
  const rows: Snapshot[] = [];
  for (const job of usableJobs(ctx)) {
    const inv = await clientInvoices(ctx, job);
    const billed = round2(inv.reduce((a, i) => a + Number(i.SubTotal ?? 0), 0));
    const earned = round2(job.contract_value * job.percent_complete / 100);
    const row: Snapshot = { job: job.id, name: job.name, contract_value: job.contract_value, percent_complete: job.percent_complete,
      earned, billed, over_under: round2(billed - earned), invoices: inv.length };
    rows.push(row);
    await ctx.store.put("wip", `${day(ctx.now)}:${job.id}`, row);
  }
  ctx.log(`wip-snapshot: ${rows.length} jobs`);
  return { jobs: rows.length, rows };
}

/** What the last claim counts as billed. A claim its approver rejected is not billed, so the next claim raises that amount again. */
async function billedBefore(ctx: Ctx<Settings>, last?: Claim): Promise<number> {
  if (!last) return 0;
  const ap = await ctx.store.get<Approval>("approvals", approvalId(ctx.workflow.id, `claim:${last.job}:${last.claim_no}`));
  return ap?.status === "rejected" ? round2(last.billed_to_date - last.this_claim) : last.billed_to_date;
}

/** Daily: a job whose claim interval has passed gets a DRAFT Xero invoice for the new progress, and one approval to authorise and email it. */
export async function progressClaim(ctx: Ctx<Settings>) {
  let drafted = 0;
  for (const job of usableJobs(ctx)) {
    const last = await ctx.store.get<Claim>("claims", job.id);
    if (last && ctx.now.getTime() - Date.parse(last.claimed_at) < (job.claim_every_days ?? 30) * DAY) continue;
    const target = round2(job.contract_value * job.percent_complete / 100);
    const thisClaim = round2(target - await billedBefore(ctx, last));
    if (thisClaim <= 0) continue;
    const n = (last?.claim_no ?? 0) + 1;
    const label = `progress claim ${n} for ${job.name}`;
    const invoiceId = await draftClaim(ctx, job, n, thisClaim);
    const retention = round2(thisClaim * (job.retention_percent ?? 0) / 100);
    const key = `claim:${job.id}:${n}`;
    await ctx.queue([{ ...authoriseAct(invoiceId, label), key }, emailAct(invoiceId, label, `claim:${n}`)],
      `Authorise and email ${label}: ${money(thisClaim)} ex GST, the invoice carries the full amount${retention ? `, ${money(retention)} retention recorded, not taken off this invoice` : ""}`);
    await ctx.store.put("claims", job.id, { job: job.id, claim_no: n, billed_to_date: target, this_claim: thisClaim,
      retention_held: retention, claimed_at: ctx.now.toISOString(), invoice_id: invoiceId } satisfies Claim);
    drafted++;
  }
  ctx.log(`progress-claim: ${drafted} drafted and queued`);
  return { drafted };
}

/** Daily: an authorised invoice past due gets its next reminder queued for approval, once per stage. */
export async function chase(ctx: Ctx<Settings>) {
  const after = ctx.settings.chase?.after_days ?? [7, 21];
  let queued = 0;
  for (const inv of await openInvoices(ctx)) {
    const id = String(inv.InvoiceID ?? "");
    if (!GUID.test(id) || !(Number(inv.AmountDue) > 0) || !inv.DueDate) continue;
    const due = Date.parse(`${String(inv.DueDate).slice(0, 10)}T00:00:00Z`);
    if (!Number.isFinite(due)) continue;
    const late = Math.floor((ctx.now.getTime() - due) / DAY);
    const sent = (await ctx.store.get<Chase>("chases", id))?.reminders ?? 0;
    if (sent >= after.length || late < after[sent]) continue;
    const n = sent + 1;
    const label = `reminder ${n} for invoice ${String(inv.InvoiceNumber ?? id).slice(0, 40)}`;
    await ctx.queue({ ...emailAct(id, label, `reminder:${n}`), key: `chase:${id}:${n}` },
      `Email ${label}: ${money(Number(inv.AmountDue))} due, ${late} days past due`);
    await ctx.store.put("chases", id, { invoice_id: id, reminders: n, last_queued: ctx.now.toISOString() } satisfies Chase);
    queued++;
  }
  ctx.log(`chase: ${queued} reminders queued`);
  return { queued };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { "wip-snapshot": wipSnapshot, "progress-claim": progressClaim, chase };
