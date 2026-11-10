// Shared shapes for the class timetable workflow. Bookeo is the only platform wired here.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";

export type Platform = "bookeo";

export interface Settings {
  family: "class-timetable";
  business_name?: string;
  booking: Platform;
  lookahead_days?: number;        // 1 to 60, default 14
  fill_target_percent?: number;   // flag classes below this, default 50
  product_ids?: string[];         // limit to these products; empty means all
}

export interface Slot { productId: string; eventId?: string; startTime: string; endTime: string; numSeatsAvailable?: number }
export interface Booking { bookingNumber: string; productId?: string; productName?: string; eventId?: string; startTime?: string; canceled?: boolean; noShow?: boolean }
export interface Product { productId: string; name: string; type?: string }
export interface RoomBlock { id: string; startTime: string; endTime: string; reason?: string; resources?: { id: string; name?: string }[] }

export interface Snapshot {
  taken: string; from: string; to: string;
  products: Product[]; slots: Slot[]; bookings: Booking[]; blocks: RoomBlock[];
}

/** Written by the owner or the agent into the store under "proposals". The cron checks it, then queues it. */
export interface Proposal {
  id: string;
  action: "cancel-class" | "block-room";
  productId?: string; startTime?: string;      // cancel-class: which class
  reason: string;
  resourceIds?: string[]; blockStart?: string; blockEnd?: string;   // block-room
  status?: "pending" | "queued" | "rejected" | "no-bookings";
  approvals?: string[]; error?: string;
}

/** Ids and times from outside the workflow are checked before they reach a path, a filter or a body. */
export const ID = /^[A-Za-z0-9_-]{1,64}$/;
export const WHEN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?$/;
export const DAY = 864e5;
export const clean = (s: unknown, max = 200) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
export const lookahead = (s: Settings) => Math.min(60, Math.max(1, Math.trunc(s.lookahead_days ?? 14)));
export const target = (s: Settings) => Math.min(100, Math.max(0, s.fill_target_percent ?? 50));
