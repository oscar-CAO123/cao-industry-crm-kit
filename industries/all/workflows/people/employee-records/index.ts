// The employee-records workflow's three crons. Each reads the records it needs, drafts nothing that leaves the business,
// and queues every write for approval in the CRM shell. None of them sends a contract, changes pay or opens a review.
import type { Ctx, Approval } from "../../../../../core/workflows/runtime.ts";
import { approvalId } from "../../../../../core/workflows/runtime.ts";
import { ID, changeProblem, hireProblem, planProblem, type Settings, type Hire, type Change, type ReviewPlan } from "./types.ts";
import { employmentHero } from "./adapters/employment-hero.ts";
import { docusign } from "./adapters/docusign.ts";

const approvalOf = (ctx: Ctx<Settings>, key: string) => ctx.store.get<Approval>("approvals", approvalId(ctx.workflow.id, key));
const refused = (ap?: Approval) => ap?.status === "failed" || ap?.status === "rejected";

/** Every 30 minutes: queue the employee record for each confirmed hire, then the contract once the record exists. */
export async function hires(ctx: Ctx<Settings>) {
  let queued = 0, contracts = 0, templateChecked = false;
  for (const h0 of Object.values(await ctx.store.list<Hire>("hires"))) {
    let h: Hire = h0;
    const set = (patch: Partial<Hire>) => { h = { ...h, ...patch }; return ctx.store.put("hires", h.id, h); };

    if (h.status === "confirmed") {
      const bad = hireProblem(h);
      if (bad) { await set({ status: "stopped", reason: bad }); continue; }
      await employmentHero.queueQuickAdd(ctx, h);
      await set({ status: "employee-queued" }); queued++;
    }
    // A hire stopped because its quick add failed is not lost: if a person re-approves that quick add and it goes through,
    // the employee id comes from the done approval and the hire carries on to its contract.
    if (h.status === "stopped" && !h.employee_id) {
      const ap = await approvalOf(ctx, `hire:${h.id}`);
      const id = ap?.status === "done" ? ap.results?.[0]?.ref?.id : undefined;
      if (id && ID.test(id)) await set({ status: "employee-created", employee_id: id, reason: undefined });
    }
    if (h.status === "employee-queued") {
      const ap = await approvalOf(ctx, `hire:${h.id}`);
      if (refused(ap)) await set({ status: "stopped", reason: ap?.error ?? `employee record ${ap?.status}` });
      else if (ap?.status === "done") {
        const id = ap.results?.[0]?.ref?.id;
        if (id && ID.test(id)) await set({ status: "employee-created", employee_id: id });
        else await set({ status: "stopped", reason: "the employee was made but no id came back: check Employment Hero, then set employee_id" });
      }
    }
    if (h.status === "employee-created") {
      if (!templateChecked) { await docusign.readTemplate(ctx); templateChecked = true; }
      await docusign.queueContract(ctx, h);
      await set({ status: "contract-queued" }); contracts++;
    }
    if (h.status === "contract-queued") {
      const ap = await approvalOf(ctx, `contract:${h.id}`);
      if (refused(ap)) await set({ status: "stopped", reason: ap?.error ?? `contract ${ap?.status}` });
      else if (ap?.status === "done") await set({ status: "contract-sent" });
    }
  }
  ctx.log(`hires: ${queued} employee records queued, ${contracts} contracts queued`);
  return { queued, contracts };
}

/** Every hour: queue each open pay rise or employment change, after reading that the employee record exists. */
export async function changes(ctx: Ctx<Settings>) {
  let queued = 0;
  for (const c of Object.values(await ctx.store.list<Change>("changes"))) {
    if (c.status === "queued") {
      // A queued change whose approval was refused shows why, instead of waiting forever.
      const ap = await approvalOf(ctx, `change:${c.id}`);
      if (ap && refused(ap)) await ctx.store.put("changes", c.id, { ...c, status: ap.status as "failed" | "rejected", reason: ap.error ?? `approval ${ap.status}` });
      continue;
    }
    if (c.status !== "open") continue;
    const bad = changeProblem(c);
    if (bad) { await ctx.store.put("changes", c.id, { ...c, status: "stopped", reason: bad }); continue; }
    await employmentHero.readEmployee(ctx, c.employee_id);
    if (c.kind === "salary") await employmentHero.queueSalary(ctx, c);
    else await employmentHero.queueEmploymentDetails(ctx, c);
    await ctx.store.put("changes", c.id, { ...c, status: "queued" }); queued++;
  }
  ctx.log(`changes: ${queued} queued for approval`);
  return { queued };
}

/** Every day: read the review periods already in Employment Hero, then queue each open review cycle the owner has set. */
export async function reviews(ctx: Ctx<Settings>) {
  const existing = await employmentHero.readReviewPeriods(ctx);
  let queued = 0;
  for (const p of Object.values(await ctx.store.list<ReviewPlan>("review-plans"))) {
    if (p.status === "queued") {
      // A queued review period whose approval was refused shows why, instead of waiting forever.
      const ap = await approvalOf(ctx, `review:${p.id}`);
      if (ap && refused(ap)) await ctx.store.put("review-plans", p.id, { ...p, status: ap.status as "failed" | "rejected", reason: ap.error ?? `approval ${ap.status}` });
      continue;
    }
    if (p.status !== "open") continue;
    const bad = planProblem(p);
    if (bad) { await ctx.store.put("review-plans", p.id, { ...p, status: "stopped", reason: bad }); continue; }
    await employmentHero.queueReviewPeriod(ctx, p);
    await ctx.store.put("review-plans", p.id, { ...p, status: "queued" }); queued++;
  }
  const count = Array.isArray(existing) ? existing.length : null;
  ctx.log(`reviews: ${queued} review periods queued; ${count ?? "an unknown number"} already in Employment Hero`);
  return { queued, existing: count };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { hires, changes, reviews };
