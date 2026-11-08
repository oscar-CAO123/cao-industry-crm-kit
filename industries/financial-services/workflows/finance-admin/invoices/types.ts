// Shared shapes for the invoice-checking workflow. Xero is the one platform with mapped invoice operations here.

export interface Settings {
  business_name?: string;
  bank_account_code?: string;   // the Xero account bills are paid from; payments park until it is set
  pay_days_before_due?: number; // queue a bill payment this many days before it falls due (default 2)
  amount_tolerance?: number;    // dollars the lines may differ from the subtotal before a check needs review (default 1)
  chase_after_days?: number[];  // days overdue at which each reminder is queued (default 7, 14, 30)
}

export type Verdict = "passed" | "needs-review";

/** One check per invoice, kept in the "checks" namespace. The fingerprint changes when the invoice changes, so it is checked again. */
export interface Check {
  invoice: string; kind: "bill" | "sales"; supplier?: string; number?: string;
  verdict: Verdict; reasons: string[]; fingerprint: string; checked: string;
}

/** Reminders already queued for one overdue invoice. A rejected reminder still counts as sent. */
export interface ChaseRecord { sent: { step: number; on: string }[] }

export interface Line { Description?: string; AccountCode?: string; LineAmount?: number }
export interface Invoice {
  InvoiceID: string; Type: string; Status: string; InvoiceNumber?: string;
  Contact?: { ContactID?: string; Name?: string; EmailAddress?: string };
  Date?: string; DueDate?: string; SubTotal?: number; Total?: number; AmountDue?: number; LineItems?: Line[];
}

export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DAY = 864e5;
export const day = (d: Date) => d.toISOString().slice(0, 10);
export const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Xero dates arrive as ISO text or as /Date(ms)/. Both become milliseconds, or undefined when unreadable. */
export function msDate(v?: string): number | undefined {
  if (!v) return undefined;
  const m = /\/Date\((-?\d+)/.exec(v);
  const t = m ? Number(m[1]) : Date.parse(v);
  return Number.isFinite(t) ? t : undefined;
}
