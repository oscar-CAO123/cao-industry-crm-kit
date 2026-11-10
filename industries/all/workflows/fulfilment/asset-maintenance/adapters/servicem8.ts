// ServiceM8: the business's own job board. A service or a defect becomes a Job in "Work Order" status, which the
// scheduling-dispatch workflow then allocates to a crew. The overdue reminder is an email that only ever waits for approval.
// Field names from ServiceM8's official spec (Job, platform_service_email).
import type { Ctx, Act } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, UUID, clip, esc, keyOf } from "../types.ts";

export const P = "servicem8" as const;

/** Creates an internal Work Order job (a draft). Returns its uuid, or "unconfirmed" when the reply carried no id, so a re-run never repeats it. */
export async function createJob(ctx: Ctx<Settings>, o: { title: string; description: string; address?: string }): Promise<string> {
  const r = await ctx.draft({ platform: P, op: "servicem8-api.createJobs", summary: `create work order: ${o.title}`,
    input: { body: { status: "Work Order", job_description: clip(`${o.title}\n${o.description}`, 1000),
      ...(o.address ? { job_address: clip(o.address, 200) } : {}) } } });
  const id = r.headers.get("x-record-uuid");
  return id && UUID.test(id) ? id : "unconfirmed";
}

/** The overdue reminder as an act for the approval queue. Nothing is sent until a person approves it. */
export function overdueReminder(to: string, job: string, asset: string, plan: string, key: string): Act {
  const text = `The service "${plan}" for ${asset} is overdue. The work order is in ServiceM8 for booking.`;
  return { platform: P, op: "messaging-api.send_email", key: keyOf(`overdue:${key}`), summary: `overdue reminder to ${to} for ${asset}`,
    input: { body: { to, subject: clip(`Service overdue: ${asset}`, 150), htmlBody: `<p>${esc(text)}</p>`, textBody: text, regardingJobUUID: job } } };
}
