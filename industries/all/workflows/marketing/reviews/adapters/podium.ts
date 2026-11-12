// Podium: the reviews the business holds, and the review invite that asks a customer for one.
// Field names come from Podium's official reference (review, review invite and review objects).
// Reading reviews is a draft. An invite reaches a customer, so it is only ever queued for a person to approve.
// Replying to a review is not wired here: its path needs {uid}, and the kit maps no parameters for that Podium operation.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type CompletedJob, type ReviewAdapter, type ReviewRecord, type Settings, EMAIL, PHONE, UUID, clean } from "../types.ts";

const P = "podium";

export const podium: ReviewAdapter = {
  id: P,

  async reviews(ctx: Ctx<Settings>): Promise<ReviewRecord[]> {
    const r = await ctx.draft<{ data?: any[] }>({ platform: P, op: "docs.get_reviews", summary: "read reviews", input: { params: { limit: 50 } } });
    const out: ReviewRecord[] = [];
    for (const x of r.data?.data ?? []) {
      if (!UUID.test(String(x?.uid ?? ""))) continue;
      const rating = Number(x.review?.rating);
      out.push({
        uid: x.uid,
        rating: Number.isFinite(rating) ? rating : undefined,
        body: clean(x.review?.body, 1000) || undefined,
        author: clean(x.author?.name, 80) || undefined,
        createdAt: typeof x.createdAt === "string" ? x.createdAt : undefined,
        needsResponse: x.needsResponse === true,
      });
    }
    return out;
  },

  async ask(ctx: Ctx<Settings>, job: CompletedJob): Promise<string | undefined> {
    const loc = ctx.settings.podium!.location_uid;
    const phone = job.phone && PHONE.test(job.phone) ? job.phone : undefined;
    const email = !phone && job.email && EMAIL.test(job.email) ? job.email : undefined;
    if (!phone && !email) return undefined;                          // nobody to send the invite to
    const to = phone ?? email!;
    const name = clean(job.name, 60) || "customer";
    const body = phone ? { locationUid: loc, phoneNumber: phone } : { locationUid: loc, email };
    return ctx.queue(
      { platform: P, op: "docs.post_reviews_invites", input: { body }, key: `ask:${job.id}`, summary: `Send a review invite to ${name} at ${to}` },
      `Review invite to ${name} at ${to}`,
    );
  },
};
