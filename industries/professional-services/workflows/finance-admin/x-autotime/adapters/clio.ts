// Clio: the time entries (activities), the running timer and the matters a fee earner bills against.
// Reads are draft operations. Creating a time entry is a live operation: a cron queues it and a person approves it.
// Field names come from docs.developers.clio.com (endpoint-map/raw/clio/spec, Activity and Timer schemas).
// Open item for a live account: the quantity unit. The vendor spec says seconds on the latest API version and hours on
// version 4.0.3 and earlier. This adapter sends seconds with no version header, so a sandbox must confirm it first.
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../../core/workflows/runtime.ts";
import type { CapturedEntry, Matter, Request, RunningTimer, Settings } from "../types.ts";

const P = "clio";
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Clio ids are positive integers. Anything else is refused before it reaches a filter or a body. */
export const clioId = (v: unknown, what: string): number => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`x-autotime: bad ${what}`);
  return n;
};
/** A calendar day, YYYY-MM-DD, that really exists. */
export const day = (v: unknown): string => {
  const s = String(v ?? "");
  if (!DAY.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) throw new Error("x-autotime: bad date");
  return s;
};
/** Hours above zero, up to a full day, to two decimal places. */
export const hours = (v: unknown): number => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 24 || Number(n.toFixed(2)) !== n) throw new Error("x-autotime: bad hours");
  return n;
};
/** The spec types list responses as a data array. Accept a bare array too. */
const rows = (d: any): any[] => (Array.isArray(d?.data) ? d.data : Array.isArray(d) ? d : []);

const FIELDS = "id,type,date,quantity_in_hours,note,non_billable,matter{id}";

/** The fee earner's time entries for one day. Reads only. */
export async function dayEntries(ctx: Ctx<Settings>, date: string): Promise<CapturedEntry[]> {
  const r = await ctx.draft<any>({ platform: P, op: "openapi.Activity#index", summary: "time entries for the day",
    input: { params: { user_id: clioId(ctx.settings.clio_user_id, "user"), type: "TimeEntry", start_date: day(date), end_date: day(date), limit: 200, fields: FIELDS } } });
  if (r.data?.meta?.paging?.next) ctx.log(`x-autotime: more time entries than one page on ${date}`);
  return rows(r.data).map((a) => ({ id: Number(a.id), date: String(a.date), hours: Number(a.quantity_in_hours ?? 0), note: a.note ?? null,
    matter_id: a.matter?.id ?? null, non_billable: a.non_billable === true }));
}

/** The running timer, or null when none is running (Clio answers 404 in that case). */
export async function runningTimer(ctx: Ctx<Settings>): Promise<RunningTimer | null> {
  try {
    const r = await ctx.draft<any>({ platform: P, op: "openapi.Timer#show", summary: "running timer" });
    const t = r.data?.data;
    if (!t?.id) return null;
    return { id: Number(t.id), start_time: t.start_time ?? null, elapsed_seconds: Number(t.elapsed_time ?? 0) };
  } catch (e: any) {
    if (e?.status === 404) return null;
    throw e;
  }
}

/** The matters a person can classify an entry to. Reads only. */
export async function openMatters(ctx: Ctx<Settings>): Promise<Matter[]> {
  const r = await ctx.draft<any>({ platform: P, op: "openapi.BillableMatter#index", summary: "matters for classification",
    input: { params: { status: ctx.settings.matter_status ?? "Open", limit: 200, fields: "id,display_number,description" } } });
  return rows(r.data).map((m) => ({ id: Number(m.id), display_number: m.display_number ?? null, description: m.description ?? null }));
}

/** The live act for a time entry: queued by the entries cron, run only after a person approves it. Hours go out as seconds. */
export function entryAct(ctx: Ctx<Settings>, r: Request): Act {
  const seconds = Math.round(hours(r.hours) * 3600);
  const data: Record<string, unknown> = {
    type: "TimeEntry",
    date: day(r.date),
    quantity: seconds,
    matter: { id: clioId(r.matter_id, "matter") },
    user: { id: clioId(ctx.settings.clio_user_id, "user") },
    non_billable: r.billable === undefined ? ctx.settings.default_non_billable === true : r.billable === false,
    ...(r.note ? { note: String(r.note).slice(0, 500) } : {}),
    ...(ctx.settings.default_activity_description_id ? { activity_description: { id: clioId(ctx.settings.default_activity_description_id, "activity description") } } : {}),
  };
  return { platform: P, op: "openapi.Activity#create", key: safeKey(`time:${r.id}`),
    summary: `log ${hours(r.hours)} h (Clio quantity ${seconds} seconds) on matter ${r.matter_id} for ${r.date}${r.note ? `: ${String(r.note).slice(0, 80)}` : ""}`,
    input: { body: { data } } };
}
