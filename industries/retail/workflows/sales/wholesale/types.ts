// Shared shapes for the wholesale workflow. The Xero adapter speaks these. The crons read and draft; a person approves every send.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";

export type Platform = "xero";

export interface Settings {
  family: "wholesale";
  business_name?: string;
  invoice?: { payment_terms_days?: number; line_amount_types?: "Exclusive" | "Inclusive" | "NoTax" };
  chase?: { after_days_overdue?: number[] };
  gst_rate?: number;
}

/** A stockist or wholesale customer, recorded by the team. Its Xero contact is set up by the account-setup cron. */
export interface Account {
  id: string;
  name: string;
  email?: string;
  status: "new" | "contact-ready" | "held";
  xero_contact_id?: string;
  reason?: string;
}

export interface Line { description: string; qty: number; unitPrice: number }

/** A wholesale order, recorded by the team from its purchase order. ready = waiting for an invoice draft. */
export interface Order {
  id: string;
  account: string;
  po?: string;
  lines: Line[];
  status: "ready" | "invoice-draft" | "invoiced" | "held";
  invoice_id?: string;
  due?: string;
  chases?: number[];
  reason?: string;
}

export const DAY = 864e5;
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const QTY_MAX = 100000;
export const total = (lines: Line[]) => Math.round(lines.reduce((a, l) => a + l.qty * l.unitPrice, 0) * 100) / 100;
export const money = (n: number) => `$${Number(n).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const day = (d: Date) => d.toISOString().slice(0, 10);

/** Why an order cannot be invoiced from its own data, or undefined when it can. Account readiness is checked separately. */
export function lineProblem(lines: Line[] | undefined): string | undefined {
  if (!lines?.length) return "order has no lines";
  for (const l of lines) {
    if (!(Number(l.qty) > 0) || Number(l.qty) > QTY_MAX) return `bad quantity on ${String(l.description).slice(0, 60)}`;
    if (!(Number(l.unitPrice) >= 0)) return `bad price on ${String(l.description).slice(0, 60)}`;
  }
  return undefined;
}

export type { Ctx };
