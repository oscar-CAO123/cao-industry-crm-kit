// Employment Hero: the employee record, pay and employment changes, and review periods. Reads are draft operations.
// Every write creates or changes a person's record, so each one is queued for approval and never run by a cron.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { ID, check, changeProblem, hireProblem, idList, planProblem, type Settings, type Hire, type Change, type ReviewPlan } from "../types.ts";

const P = "employment-hero";
const org = (ctx: Ctx<Settings>) => {
  const id = ctx.settings.employment_hero?.organisation_id ?? "";
  check(ID.test(id), "employment_hero.organisation_id is not set");
  return id;
};
const entity = (ctx: Ctx<Settings>) => {
  const id = ctx.settings.employment_hero?.employing_entity_id ?? "";
  check(ID.test(id), "employment_hero.employing_entity_id is not set");
  return id;
};

export const employmentHero = {
  id: P,

  /** Read one employee record before a change to it is queued. Draft read: it changes nothing. */
  async readEmployee(ctx: Ctx<Settings>, employeeId: string) {
    check(ID.test(employeeId), "employee id is not valid");
    const r = await ctx.draft<any>({ platform: P, op: "Get Employee Config", summary: "read employee record",
      input: { params: { organisation_id: org(ctx), id: employeeId } } });
    check(r.status < 300, `employee record was not read (status ${r.status})`);
    return r.data;
  },

  /** Read the review periods already in the account. Draft read. */
  async readReviewPeriods(ctx: Ctx<Settings>) {
    const r = await ctx.draft<any>({ platform: P, op: "Get Performance Reviews Config", summary: "read review periods",
      input: { params: { organisation_id: org(ctx) } } });
    check(r.status < 300, `review periods were not read (status ${r.status})`);
    return r.data;
  },

  /** Queue the quick add that creates the employee record. Live: it changes a person's record. */
  queueQuickAdd(ctx: Ctx<Settings>, h: Hire) {
    const bad = hireProblem(h);
    check(!bad, bad ?? "");
    const w = ctx.settings.employment_hero.work_location;
    return ctx.queue({
      platform: P, op: "Quick Add Employee Config", key: `hire:${h.id}`, summary: `add ${h.first_name} ${h.last_name} to Employment Hero`,
      input: { params: { organisation_id: org(ctx) }, body: {
        employing_entity_id: entity(ctx), first_name: h.first_name, last_name: h.last_name, email: h.email,
        ...(h.date_of_birth ? { date_of_birth: h.date_of_birth } : {}),
        ...(w ? { work_location: { id: w.id, name: w.name, country: w.country } } : {}),
      } },
    }, `add ${h.first_name} ${h.last_name} (${h.email}) as an employee in Employment Hero`);
  },

  /** Queue a new salary version for a pay rise. Live: it changes pay. */
  queueSalary(ctx: Ctx<Settings>, c: Change) {
    const bad = changeProblem(c);
    check(!bad && c.kind === "salary", bad ?? "not a salary change");
    return ctx.queue({
      platform: P, op: "Create Salary Version Config", key: `change:${c.id}`, summary: `new salary version for ${c.employee_id}`,
      input: { params: { organisation_id: org(ctx), employee_id: c.employee_id }, body: {
        effective_date: c.effective_date, award_id: c.award_id, classification_id: c.classification_id, change_reason: c.change_reason,
      } },
    }, `set a new salary version from ${c.effective_date} for employee ${c.employee_id}`);
  },

  /** Queue an employment detail change (manager, team, cost centre). Live: it changes a person's record. */
  queueEmploymentDetails(ctx: Ctx<Settings>, c: Change) {
    const bad = changeProblem(c);
    check(!bad && c.kind === "employment", bad ?? "not an employment change");
    const body: Record<string, unknown> = {};
    if (c.cost_centre_id) body.cost_centre_id = c.cost_centre_id;
    if (c.primary_manager_id) body.primary_manager_id = c.primary_manager_id;
    if (c.secondary_manager_id) body.secondary_manager_id = c.secondary_manager_id;
    if (c.team_ids !== undefined) body.team_ids = c.team_ids; // may be empty: clears the teams (checked by changeProblem)
    return ctx.queue({
      platform: P, op: "Update Employment Details Config", key: `change:${c.id}`, summary: `employment details for ${c.employee_id}`,
      input: { params: { organisation_id: org(ctx), employee_id: c.employee_id }, body },
    }, `update employment details for employee ${c.employee_id}`);
  },

  /** Queue a review period for the owner's review cycle. Live: it opens the review to the employee and reviewers. */
  queueReviewPeriod(ctx: Ctx<Settings>, p: ReviewPlan) {
    const bad = planProblem(p);
    check(!bad, bad ?? "");
    return ctx.queue({
      platform: P, op: "Create Performance Review Config", key: `review:${p.id}`, summary: `review period ${p.name}`,
      input: { params: { organisation_id: org(ctx) }, body: {
        name: p.name, review_template_ids: idList(p.template_ids, "review_template_ids"), fixed_date: true,
        employee_start_date: p.employee_start_date, employee_end_date: p.employee_end_date, employee_lock_out_date: p.employee_lock_out_date,
        reviewer_start_date: p.reviewer_start_date, reviewer_end_date: p.reviewer_end_date, reviewer_lock_out_date: p.reviewer_lock_out_date,
        reviewer_types: ["primary_manager"],
      } },
    }, `open review period "${p.name}" in Employment Hero`);
  },
};
