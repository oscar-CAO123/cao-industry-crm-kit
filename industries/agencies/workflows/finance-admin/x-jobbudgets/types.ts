// Shapes for the job budgets workflow. The workflow only reads budgets and drafts internal records, so the one
// adapter here is read-only.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";

export type Platform = "xero";

export interface Settings {
  family: "job-budgets";
  business_name?: string;
  /** Flag a job once its spend reaches this share of its estimate. */
  overrun_pct?: number;
}

/** One job (a Xero project) with its estimate and what has been spent against it so far. */
export interface JobRow {
  id: string;
  name: string;
  status: string;
  estimate: number | null;
  spent: number;
  minutes_logged: number;
}

export interface Adapter {
  id: Platform;
  projects(ctx: Ctx<Settings>): Promise<JobRow[]>;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
export const toJob = (p: any): JobRow => ({
  id: String(p.projectId ?? "").slice(0, 60),
  name: String(p.name ?? "").slice(0, 200),
  status: String(p.status ?? "").slice(0, 40),
  estimate: typeof p.estimateAmount === "number" && Number.isFinite(p.estimateAmount) ? p.estimateAmount : null,
  spent: Math.round((num(p.totalTaskAmount) + num(p.totalExpenseAmount)) * 100) / 100,
  minutes_logged: num(p.minutesLogged),
});
