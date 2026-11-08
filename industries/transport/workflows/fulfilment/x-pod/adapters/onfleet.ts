// Onfleet: the delivery platform that holds completed stops and their proof. Reads are drafts; a re-attempt task
// reaches the customer and the live dispatch, so it is only ever queued (ctx.queue) and runs after approval.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../../core/workflows/runtime.ts";
import { type Pod, type Settings, cut } from "../types.ts";

export const P = "onfleet";
const ID = /^[A-Za-z0-9*~_-]{1,64}$/;   // Onfleet ids carry * and ~; anything else is refused before it reaches a path or query
export const onfleetId = (v: unknown) => { const s = String(v ?? ""); if (!ID.test(s)) throw new Error("onfleet: bad id"); return s; };
export const podKey = (taskId: string) => safeKey(`pod:${taskId}`, 120);

const COMPLETED = 3;

/** Completed tasks whose completion time is at or after `from` (Unix ms). Pages carry a lastId while more remain. */
export async function listCompleted(ctx: Ctx<Settings>, from: number, lastId?: string): Promise<{ tasks: any[]; lastId?: string }> {
  // Onfleet requires `from` (Unix ms). Refuse anything that is not a past millisecond timestamp before it is sent.
  if (!Number.isSafeInteger(from) || from <= 0 || from > ctx.now.getTime()) throw new Error("onfleet: from must be a past millisecond timestamp");
  const params: Record<string, unknown> = { from, state: COMPLETED };
  if (lastId) params.lastId = onfleetId(lastId);
  const r = await ctx.draft<any>({ platform: P, op: "core.docs.get_tasks_all", summary: "completed tasks since the last run", input: { params } });
  return { tasks: Array.isArray(r.data?.tasks) ? r.data.tasks : [], lastId: typeof r.data?.lastId === "string" ? r.data.lastId : undefined };
}

/** One task with its full completion details. */
export async function getTask(ctx: Ctx<Settings>, taskId: string): Promise<any> {
  const r = await ctx.draft<any>({ platform: P, op: "core.docs.get_tasks_id", summary: "read one task for its proof", input: { params: { id: onfleetId(taskId) } } });
  return r.data ?? {};
}

const photoIdsOf = (cd: any): string[] => {
  const ids = [...(Array.isArray(cd?.photoUploadIds) ? cd.photoUploadIds : []), cd?.photoUploadId];
  return [...new Set(ids.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 120))];
};

/** Turns an Onfleet task into a register entry. Returns undefined for a task with no completion time. */
export function toPod(t: any, now: Date): Pod | undefined {
  const cd = t?.completionDetails ?? {};
  if (typeof t?.id !== "string" || typeof cd.time !== "number") return undefined;
  const a = t.destination?.address ?? {};
  const address = [a.number, a.street, a.apartment && `apt ${a.apartment}`, a.city, a.state, a.postalCode].filter((x) => typeof x === "string" && x).join(" ") || undefined;
  const reason = typeof cd.failureReason === "string" && cd.failureReason !== "NONE" && cd.failureReason ? cut(cd.failureReason, 60) : undefined;
  const photos = photoIdsOf(cd);
  const signature = typeof cd.signatureUploadId === "string" && cd.signatureUploadId.length > 0;
  const hasProof = photos.length > 0 || signature;
  return {
    key: podKey(t.id), task_id: t.id, short_id: cut(t.shortId, 20), address: cut(address, 200),
    destination_id: typeof t.destination?.id === "string" ? t.destination.id : undefined,
    recipient_ids: (Array.isArray(t.recipients) ? t.recipients : []).map((r: any) => r?.id).filter((x: unknown): x is string => typeof x === "string"),
    worker_id: typeof t.worker === "string" ? t.worker : undefined,
    completed: new Date(cd.time).toISOString(), failed: !!reason, failure_reason: reason,
    photo_count: photos.length, photo_ids: photos, signature,
    notes: cut(cd.successNotes || cd.failureNotes || t.notes, 300), checked: now.toISOString(),
    status: reason ? "failed" : hasProof ? "complete" : "needs-proof",
  };
}

/** A re-attempt of a failed stop: same destination and recipients, a note with the reason. Queued by the cron, run on approval. */
export function reattemptAct(p: Pod) {
  // Onfleet requires `destination` on a new task, so a stop without one cannot be re-attempted.
  if (!p.destination_id) throw new Error("onfleet: a re-attempt needs the stop's destination id");
  const body: Record<string, unknown> = { destination: onfleetId(p.destination_id), notes: `Re-attempt of ${p.short_id ?? p.task_id}: ${p.failure_reason ?? "failed"}`.slice(0, 500) };
  if (p.recipient_ids.length) body.recipients = p.recipient_ids.slice(0, 1).map(onfleetId);
  return { platform: P, op: "core.docs.post_tasks", summary: `re-attempt ${p.short_id ?? p.task_id} at ${p.address ?? "the stop"} (failed: ${p.failure_reason ?? "unknown"})`, input: { body }, key: `reattempt:${p.task_id}` };
}
