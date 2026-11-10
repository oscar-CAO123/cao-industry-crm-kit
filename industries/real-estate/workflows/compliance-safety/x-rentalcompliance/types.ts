// Shared shapes for the rental compliance workflow. VaultRE is the one kit platform with maintenance, task and tenant
// operations for residential leases, so it is the only adapter.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";

export type Platform = "vaultre";

export interface Settings {
  business_name?: string;
  user_id: number;           // the VaultRE user who receives follow-up tasks
  stale_days?: number;       // an open maintenance job this many days old gets a follow-up task
  task_start_days?: number;  // the follow-up task starts this many days after the run
}

/** A contractor booking request, written by whoever records it. The booking cron queues it for approval. */
export interface Booking {
  key: string;               // stable id: letters, digits, dash, underscore
  property_id: number;
  lease_life_id: number;
  tenancy_id: number;
  requested_by_id: number;
  summary: string;
  description?: string;
  status: "new" | "queued";
}

export interface MaintenanceJob { id: number; summary?: string; description?: string; status?: string; inserted?: string }

export const DAY = 864e5;
export const KEY = /^[A-Za-z0-9_-]{1,80}$/;

/** A positive whole number, or an error before anything reaches the network. */
export const posInt = (v: unknown, what: string): number => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`rental compliance: ${what} must be a positive whole number`);
  return n;
};

/** Free text from tenants and staff: control characters out, length capped. It is data, written into a record only. */
export const clamp = (v: unknown, max: number) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max);

export type { Ctx };
