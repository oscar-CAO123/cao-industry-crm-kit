// The commission workflow's three crons. figures and draft-pay read and draft. queue-post only queues the post of the
// pay run for a person to approve; nothing here pays anyone.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { Commission, Settings } from "./types.ts";
import { checkSettings, closedPeriod, rateFor, money2 } from "./types.ts";
import { paidSales, payRunFor, enterOnPayslip } from "./adapters/xero.ts";

/** Once the pay post for a period is queued for approval, that period's figures and payslips are fixed: the approver sees
 *  exactly the total that was queued. Only queue-post sets this. */
const postQueued = async (ctx: Ctx<Settings>, period: string) => Boolean(await ctx.store.get("commission-posts", period));

/** Hourly: last month's commission for each rep, from paid sales invoices dated in that month. */
export async function figures(ctx: Ctx<Settings>) {
  checkSettings(ctx.settings);
  const p = closedPeriod(ctx.now);
  if (await postQueued(ctx, p.period)) { ctx.log(`figures ${p.period}: the pay post is queued for approval, figures are fixed`); return { locked: true }; }
  const sales = await paidSales(ctx, p);
  const reps = ctx.settings.reps;
  const totals = new Map(reps.map((r) => [r.employee_id.toLowerCase(), { ex: 0, ids: [] as string[] }]));
  let unmatched = 0;
  for (const s of sales) {
    const matches = reps.filter((r) => s.reference.toLowerCase().includes(r.match.toLowerCase()));
    if (matches.length !== 1) { unmatched++; continue; }   // no rep, or two reps: a person sorts it out, never a guess
    const rep = matches[0];
    const t = totals.get(rep.employee_id.toLowerCase())!;
    t.ex = money2(t.ex + s.ex_gst);
    t.ids.push(s.id);
  }
  let rows = 0;
  for (const rep of reps) {
    const id = rep.employee_id.toLowerCase(), t = totals.get(id)!, key = `${p.period}:${id}`;
    const old = await ctx.store.get<Commission>("commission", key);
    if (old?.status === "entered") {                     // already on a pay run: never recalculated under it
      if (old.amount !== money2(t.ex * rateFor(ctx.settings.tiers, t.ex))) ctx.log(`figures: ${rep.name} sales changed after entry, not recalculated`);
      continue;
    }
    const rate = rateFor(ctx.settings.tiers, t.ex), amount = money2(t.ex * rate);
    const status = amount > 0 ? "calculated" : "none";
    await ctx.store.put("commission", key, { key, period: p.period, employee_id: id, rep: rep.name, sales_ex_gst: t.ex, rate, amount, invoices: t.ids, status } satisfies Commission);
    if (amount > 0) rows++;
  }
  ctx.log(`figures ${p.period}: ${sales.length} paid sales, ${unmatched} with no single rep match, ${rows} commission rows`);
  return { sales: sales.length, unmatched, rows };
}

/** Every 45 minutes: put each calculated commission on its payslip in last month's DRAFT pay run. */
export async function draftPay(ctx: Ctx<Settings>) {
  checkSettings(ctx.settings);
  const p = closedPeriod(ctx.now);
  if (await postQueued(ctx, p.period)) { ctx.log(`draft-pay ${p.period}: the pay post is queued for approval, nothing entered`); return { entered: 0, locked: true }; }
  const todo = Object.values(await ctx.store.list<Commission>("commission")).filter((r) => r.period === p.period && r.status === "calculated");
  if (!todo.length) return { entered: 0 };
  const run = await payRunFor(ctx, p, true);
  if (!run) { ctx.log(`draft-pay ${p.period}: the pay run is already posted, nothing entered`); return { entered: 0, posted: true }; }
  let entered = 0;
  for (const row of todo) {
    const slip = run.slips.find((s) => s.EmployeeID === row.employee_id);
    if (!slip) { ctx.log(`draft-pay ${p.period}: ${row.rep} has no payslip in the pay run`); continue; }
    await enterOnPayslip(ctx, slip.PayslipID, row.amount);
    await ctx.store.put("commission", row.key, { ...row, status: "entered", pay_run: run.id, payslip: slip.PayslipID, entered: ctx.now.toISOString() } satisfies Commission);
    entered++;
  }
  ctx.log(`draft-pay ${p.period}: ${entered} entered on the DRAFT pay run`);
  return { entered };
}

/** Daily: once every commission row for last month is on the DRAFT pay run, queue the post for a person. Never posts. */
export async function queuePost(ctx: Ctx<Settings>) {
  checkSettings(ctx.settings);
  const p = closedPeriod(ctx.now);
  const rows = Object.values(await ctx.store.list<Commission>("commission")).filter((r) => r.period === p.period);
  const open = rows.filter((r) => r.status === "calculated");
  const entered = rows.filter((r) => r.status === "entered");
  if (open.length || !entered.length) { ctx.log(`queue-post ${p.period}: ${open.length} rows still to enter`); return { queued: 0 }; }
  const runId = entered[0].pay_run!;
  if (entered.some((r) => r.pay_run !== runId)) { ctx.log(`queue-post ${p.period}: rows sit on two pay runs, checked by a person`); return { queued: 0 }; }
  const run = await payRunFor(ctx, p, false);
  if (!run || run.id.toLowerCase() !== runId.toLowerCase()) { ctx.log(`queue-post ${p.period}: the pay run is no longer a DRAFT`); return { queued: 0 }; }
  const total = money2(entered.reduce((a, r) => a + r.amount, 0));
  const approval = await ctx.queue({ platform: "xero", op: "payroll-au.updatePayRun", key: `post:${runId}`, summary: `post pay run ${p.period}`,
    input: { params: { PayRunID: runId }, body: [{ PayRunStatus: "POSTED" }] } },
    `Post the ${p.period} pay run in Xero with ${entered.length} commission lines totalling $${total.toFixed(2)}`);
  await ctx.store.put("commission-posts", p.period, { approval, pay_run: runId, lines: entered.length, total, queued: ctx.now.toISOString() });
  return { queued: 1, approval };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { figures, "draft-pay": draftPay, "queue-post": queuePost };
