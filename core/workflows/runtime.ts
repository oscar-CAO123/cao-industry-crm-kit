// The workflow runtime: how every workflow's crons reach the client's apps.
//
// A workflow (industries/<industry>/workflows/<department>/<name>/workflow.json) declares two allowlists:
//   draft_ops  operations a cron may run on its own: reads, and writes that reach nobody outside the business
//              (a quote in draft, job lines on a quote, an email draft, a row in an internal log)
//   live_ops   operations that reach a customer, move money or change a live record (send, mark sent, invoice):
//              a cron can only QUEUE these; they run when a person approves them in the CRM shell
// Every call still goes through the SDK gate (core/sdk/call.ts): writes need KIT_ALLOW_WRITES=1 on the deploy.
// The runtime adds the rule above on top, so a cron can never send anything, whatever the deploy allows.

import { callOperation, describe, plan, type CallInput } from "../sdk/call.ts";
import { ApiError, WriteBlocked, type Reply } from "../lib/http.ts";
import type { Store } from "./store.ts";
import crypto from "node:crypto";

export interface Act { platform: string; op: string; input?: CallInput; summary: string; /** de-duplicates queued approvals */ key?: string;
  /** Read the live record just before this act runs (a draft op of this workflow) and send only if each value is still as
   *  expected: an approval given after someone changed the record in the app is closed instead of overwriting it. */
  check?: Check }
export interface Check { platform: string; op: string; input?: CallInput; expect: { path: string; equals: string | number | boolean | null }[] }
const CHECK_PATH = /^[A-Za-z0-9_-]{1,64}(\.[A-Za-z0-9_-]{1,64}){0,7}$/;
/** The value at a dot path ("Invoices.0.Status"), or undefined. */
function at(data: unknown, path: string): unknown {
  return path.split(".").reduce<any>((o, k) => (o === null || o === undefined ? undefined : o[k]), data);
}
/** One approval runs one act, or a short ordered bundle (send the email, then mark the quote sent); it stops at the first failure. */
export interface Approval { id: string; workflow: string; summary: string; acts: Act[]; status: "pending" | "running" | "done" | "failed" | "rejected" | "needs-check"; created: string; decided?: string; started?: string; results?: { op: string; status: number | "started"; ref?: Record<string, string> }[]; error?: string; decided_by?: string }
export interface WorkflowRecord {
  id: string; name: string; draft_ops: Record<string, string[]>; live_ops: Record<string, string[]>;
  crons: { name: string; schedule: string; entry: string; summary: string }[];
}
export interface Ctx<S = any> {
  workflow: WorkflowRecord; settings: S; store: Store; now: Date; log: (m: string) => void;
  /** Run an allowed draft operation now and return its reply. */
  draft<T = any>(a: Act): Promise<Reply<T>>;
  /** Queue a live operation (or an ordered bundle) for approval; returns the approval id. */
  queue(a: Act | Act[], summary?: string): Promise<string>;
}

/** The approval id for a key: the CRM shell and the crons both find an approval by it. */
/** A safe, stable id of at most 120 characters: long values keep a readable start and a hash of the whole. */
export function safeKey(s: string, max = 120): string {
  const clean = s.replace(/[^a-z0-9:._-]/gi, "-").replace(/^[^a-z0-9]+/i, "");
  return clean.length <= max ? clean : `${clean.slice(0, max - 17)}-${crypto.createHash("sha256").update(s).digest("hex").slice(0, 16)}`;
}
export const approvalId = (workflowId: string, key: string) => safeKey(`${workflowId.replace(/[^a-z0-9]+/gi, "-")}.${key}`);

function allowed(list: Record<string, string[]>, a: Act) { return (list[a.platform] ?? []).includes(a.op); }

export function context<S>(workflow: WorkflowRecord, settings: S, store: Store, now = new Date(), log: (m: string) => void = (m) => console.log(m)): Ctx<S> {
  return {
    workflow, settings, store, now, log,
    async draft(a) {
      if (!allowed(workflow.draft_ops, a)) throw new Error(`${workflow.id}: ${a.platform} ${a.op} is not a draft operation for this workflow`);
      describe(a.platform, a.op); // throws if the operation is not mapped
      log(`draft ${a.platform} ${a.op}`); // summaries can name customers: they stay out of logs
      return callOperation(a.platform, a.op, a.input ?? {});
    },
    async queue(a, summary) {
      const acts = Array.isArray(a) ? a : [a];
      if (!acts.length || acts.length > 5) throw new Error(`${workflow.id}: an approval holds 1 to 5 acts`);
      for (const x of acts) {
        if (!allowed(workflow.live_ops, x)) throw new Error(`${workflow.id}: ${x.platform} ${x.op} is not a live operation for this workflow`);
        describe(x.platform, x.op);
        if (x.check) {
          if (!allowed(workflow.draft_ops, x.check)) throw new Error(`${workflow.id}: a check must use a draft (read) operation: ${x.check.platform} ${x.check.op}`);
          describe(x.check.platform, x.check.op);
          if (!x.check.expect?.length || x.check.expect.length > 10 || x.check.expect.some((e) => !CHECK_PATH.test(e.path))) throw new Error(`${workflow.id}: a check needs 1 to 10 expected values with plain dot paths`);
        }
      }
      const key = acts[0].key ?? Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const id = approvalId(workflow.id, key);
      if (await store.get<Approval>("approvals", id)) return id; // already queued: a cron that runs again never queues the same thing twice
      const text = summary ?? acts.map((x) => x.summary).join("; ");
      await store.put("approvals", id, { id, workflow: workflow.id, summary: text, acts, status: "pending", created: now.toISOString() } satisfies Approval);
      log(`queued for approval ${id} (${acts.map((x) => `${x.platform} ${x.op}`).join(", ")})`); // the summary is stored for the approver, never logged
      return id;
    },
  };
}

/** Run one approved item. Called from the CRM shell (or the CLI) after a person approves it.
 *  - Each act is marked "started" in the store before it is called, and its created ids (id, uuid, QuoteID, an
 *    x-record-uuid header...) are kept in results, so later steps and crons can use them.
 *  - A failed bundle can be approved again: it resumes at the first act that did not finish, so nothing already done repeats.
 *    An act only counts as failed when nothing can have happened: its input was refused before sending, the deploy blocks
 *    writes, or the app answered with a 4xx (other than a timeout). A 5xx, a timeout or a dropped connection may have
 *    been processed by the app, so that act stays "started" and the approval becomes needs-check (below).
 *  - If an act was started but its outcome never came back (a crash or lost response), or an approval has been running
 *    for over 15 minutes, it becomes needs-check: a person confirms in the platform, then runs it with confirmUnknown
 *    ("done" skips that act, "retry" runs it again). Nothing is ever repeated automatically. */
const STUCK_MS = 15 * 60_000;
const ID_KEYS = /^(id|uuid|[A-Z][A-Za-z]*ID|[a-z_]*_id)$/;
function refsOf(data: unknown, headers?: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  const h = headers?.get?.("x-record-uuid"); if (h) out["x-record-uuid"] = h;
  const walk = (o: any, depth: number) => {
    if (!o || typeof o !== "object" || depth > 2 || Object.keys(out).length >= 8) return;
    if (Array.isArray(o)) { if (o.length) walk(o[0], depth + 1); return; }
    for (const [k, v] of Object.entries(o)) {
      if (ID_KEYS.test(k) && (typeof v === "string" || typeof v === "number") && String(v).length <= 120) out[k] = String(v);
      else if (v && typeof v === "object") walk(v, depth + 1);
    }
  };
  walk(data, 0);
  return out;
}
export async function approve(workflow: WorkflowRecord, store: Store, id: string, decidedBy: string, now = new Date(),
                              confirmUnknown?: "done" | "retry"): Promise<Approval> {
  const claim = async () => {
    const ap = await store.get<Approval>("approvals", id);
    if (!ap) throw new Error(`no approval ${id}`);
    if (ap.workflow !== workflow.id || !ap.acts.every((a) => allowed(workflow.live_ops, a))) throw new Error(`approval ${id} is not a live operation of ${workflow.id}`);
    const stuck = ap.status === "running" && now.getTime() - Date.parse(ap.started ?? ap.created) > STUCK_MS;
    const results = [...(ap.results ?? [])];
    const unknown = stuck || results.some((x) => x.status === "started");
    if (unknown || ap.status === "needs-check") {
      if (!confirmUnknown) {
        const flagged = { ...ap, status: "needs-check" as const, error: "an act started but its outcome is unknown: check the platform, then approve with done or retry" };
        await store.put("approvals", id, flagged);
        throw new Error(`approval ${id} needs a check before it can run again`);
      }
      const i = results.findIndex((x) => x.status === "started");
      if (i >= 0) { if (confirmUnknown === "done") results[i] = { op: results[i].op, status: 299 }; else results.length = i; }
    } else if (ap.status !== "pending" && ap.status !== "failed") throw new Error(`approval ${id} is already ${ap.status}`);
    const running = { ...ap, results: results.filter((x) => typeof x.status === "number" && x.status < 300), status: "running" as const, started: now.toISOString(), decided_by: decidedBy };
    await store.put("approvals", id, running);
    return running;
  };
  // One claim at a time: a double click or two approvers cannot both start the same approval.
  const ap = await store.locked("approve-claims", claim);
  const results = [...(ap.results ?? [])];
  try {
    for (const a of ap.acts.slice(results.length)) {
      // Plan it first (no keys, no network): a bad input fails here, before the act is marked started or anything is sent.
      await plan(a.platform, a.op, a.input ?? {});
      if (a.check) {
        const live = await callOperation(a.check.platform, a.check.op, a.check.input ?? {});
        const off = a.check.expect.find((e) => at(live.data, e.path) !== e.equals);
        if (off) {
          const now_ = String(at(live.data, off.path) ?? "nothing").slice(0, 60);
          Object.assign(ap, { status: "rejected", decided: now.toISOString(), decided_by: "check", results,
            error: `the record changed after this was queued (${off.path} is now ${now_}, was ${String(off.equals).slice(0, 60)}): nothing was sent` });
          await store.put("approvals", id, ap);
          return ap;
        }
      }
      results.push({ op: a.op, status: "started" });
      await store.put("approvals", id, { ...ap, results });
      const r = await callOperation(a.platform, a.op, a.input ?? {});
      // Some apps answer 200 with an errors list (GraphQL and a few REST APIs): the request was refused, nothing was done.
      const errs = (r.data as any)?.errors;
      if (Array.isArray(errs) && errs.length && !(r.data as any)?.data) throw new ApiError(a.platform, 422, `${a.op} returned errors`);
      results[results.length - 1] = { op: a.op, status: r.status, ref: refsOf(r.data, r.headers) };
      await store.put("approvals", id, { ...ap, results });
    }
    Object.assign(ap, { status: "done", decided: now.toISOString(), results, error: undefined });
  } catch (e: any) {
    // Only a refusal that proves nothing happened is a clean failure that may simply be approved again. Anything else
    // (a 5xx, a timeout, a dropped connection, a failed token exchange) may have been processed by the app: the act
    // stays "started" and a person checks the platform first, so a send, payment or post can never go out twice.
    const nothingHappened = e instanceof WriteBlocked || (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 408);
    if (results.at(-1)?.status === "started" && nothingHappened) results.pop();
    const unknown = results.at(-1)?.status === "started";
    const msg = String(e?.message ?? e).slice(0, 240);
    Object.assign(ap, { status: unknown ? "needs-check" : "failed", decided: now.toISOString(), results,
      error: unknown ? `outcome unknown (${msg}): check the platform, then approve with done or retry` : msg });
  }
  await store.put("approvals", id, ap);
  return ap;
}

export async function reject(workflow: WorkflowRecord, store: Store, id: string, decidedBy: string, now = new Date()): Promise<void> {
  const ap = await store.get<Approval>("approvals", id);
  if (!ap || !["pending", "failed", "needs-check"].includes(ap.status) || ap.workflow !== workflow.id) throw new Error(`no open approval ${id} in ${workflow.id}`);
  await store.put("approvals", id, { ...ap, status: "rejected", decided: now.toISOString(), decided_by: decidedBy });
}
