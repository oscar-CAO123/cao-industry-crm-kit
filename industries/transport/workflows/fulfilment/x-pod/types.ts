// Shared shapes for the proof-of-delivery workflow. The register holds one Pod per completed Onfleet task.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";

export interface Settings {
  business_name?: string;
  lookback_days?: number;      // how far back the first pods run reads completed tasks
  max_pages?: number;          // pages of 64 completed tasks read per run
  proof_grace_hours?: number;  // wait this long after completion before flagging missing proof
  reattempt?: boolean;         // false turns off queuing re-attempts for failed stops
}

export type PodStatus = "complete" | "needs-proof" | "failed" | "reattempt-queued" | "reattempt-rejected" | "reattempt-created" | "needs-check";

export interface Pod {
  key: string;                 // store key (safe form of the task id)
  task_id: string;
  short_id?: string;
  address?: string;            // destination address as one line
  destination_id?: string;     // needed to re-attempt the stop
  recipient_ids: string[];     // needed to re-attempt the stop; no names or phone numbers are stored
  worker_id?: string;
  completed: string;           // ISO time from completionDetails.time
  failed: boolean;
  failure_reason?: string;
  photo_count: number;
  photo_ids: string[];
  signature: boolean;
  notes?: string;              // driver's notes, truncated
  checked?: string;            // last time the task was read for proof
  status: PodStatus;
  approval?: string;           // approval id of a queued re-attempt
  reattempt_task?: string;     // task id created by the approved re-attempt
}

export const cut = (s: unknown, n: number) => (typeof s === "string" ? s.slice(0, n) : undefined);
