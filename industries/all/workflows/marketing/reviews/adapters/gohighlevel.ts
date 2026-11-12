// GoHighLevel: the review request is a workflow in the sub-account. Asking a customer means adding the finished job's
// contact to that workflow, then tagging the contact so it is never asked twice. Both writes are queued as one approval,
// and the approval runs them in order. Field names come from GoHighLevel's official spec.
// The kit has no GoHighLevel read for Google reviews, so reviews() returns none, and replies are not wired (see SKILL.md).
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type CompletedJob, type ReviewAdapter, type Settings, ID, clean } from "../types.ts";

const P = "gohighlevel";

export const gohighlevel: ReviewAdapter = {
  id: P,

  async reviews(ctx: Ctx<Settings>) {
    ctx.log("reviews: gohighlevel has no review read in the kit, so there is nothing to draft");
    return [];
  },

  async ask(ctx: Ctx<Settings>, job: CompletedJob): Promise<string | undefined> {
    const g = ctx.settings.gohighlevel!;
    if (!job.contact_id || !ID.test(job.contact_id)) return undefined;   // no GoHighLevel contact on this job
    const tag = clean(g.asked_tag ?? "review-asked", 60) || "review-asked";
    const name = clean(job.name, 60) || "customer";
    return ctx.queue(
      [
        { platform: P, op: "contacts.add-contact-to-workflow", input: { params: { contactId: job.contact_id, workflowId: g.review_workflow_id } },
          key: `ask:${job.id}`, summary: `Add ${name} to the review request workflow` },
        { platform: P, op: "contacts.add-tags", input: { params: { contactId: job.contact_id }, body: { tags: [tag] } },
          summary: `Tag ${name} as asked for a review (${tag})` },
      ],
      `Review request to ${name} (GoHighLevel workflow, then tag ${tag})`,
    );
  },
};
