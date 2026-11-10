// Shared shapes for the failed-payments workflow. Every adapter reads and drafts through the SDK; nothing here sends.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "stripe" | "xero";

export interface Settings {
  business_name?: string;
  sources: Platform[];           // where failed or overdue payments show up
  chase_after_days?: number[];   // days after first seen before each chase step, e.g. [1, 5, 10]
  retry_stripe?: boolean;        // true: the first chase retries the Stripe charge; false: it sends the invoice instead
}

export interface Contact { name?: string; email?: string }

export interface Failure {
  key: string;                   // platform:id, a safe store key
  platform: Platform;
  invoice: string;               // Stripe invoice id (in_...) or Xero InvoiceID (GUID)
  number?: string;
  contact: Contact;
  amount_due: number;            // major units (dollars)
  currency: string;
  due?: string;                  // YYYY-MM-DD
  attempts?: number;
  first_seen: string;            // ISO time
  chases: string[];              // ISO times a chase step was queued
  last_approval?: string;        // approval id of the newest counted chase step, so a step its check closed can be taken back
  status: "open" | "resolved";
  resolved?: string;
}

export interface Adapter {
  id: Platform;
  /** Invoices that show a failed or overdue payment. Reads only. */
  overdue(ctx: Ctx<Settings>): Promise<Omit<Failure, "first_seen" | "chases" | "status">[]>;
  /** Whether the invoice has since been paid. Reads only. */
  isPaid(ctx: Ctx<Settings>, f: Failure): Promise<boolean>;
  /** An internal note on the invoice (draft operation). Optional: not every platform has one. */
  note?(ctx: Ctx<Settings>, f: Failure, tag: string, text: string): Promise<void>;
  /** Queue chase step n (1-based) for approval. Returns the approval id, or "" when the step cannot run. */
  chase(ctx: Ctx<Settings>, f: Failure, n: number): Promise<string>;
}

export const DAY = 864e5;
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const STRIPE_INVOICE = /^in_[A-Za-z0-9]{6,80}$/;
export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const money = (n: number, currency = "AUD") =>
  `${currency} ${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const keyOf = (platform: Platform, id: string) => safeKey(`${platform}:${id}`, 140);
export const emailOf = (v: unknown) => (typeof v === "string" && EMAIL.test(v) ? v : undefined);
export const textOf = (v: unknown, max = 120) => (typeof v === "string" ? v.slice(0, max) : undefined);

/** Xero sends dates as YYYY-MM-DD or as /Date(ms)/; Stripe sends unix seconds. Returns YYYY-MM-DD or undefined. */
export function dueDay(v: unknown): string | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v * 1000).toISOString().slice(0, 10);
  const s = String(v ?? "");
  const ms = /\/Date\((-?\d+)/.exec(s);
  if (ms) return new Date(Number(ms[1])).toISOString().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : undefined;
}
