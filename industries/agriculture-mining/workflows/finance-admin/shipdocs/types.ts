// Shared shapes for the export document check workflow. The Xero adapter and the crons both use these.

export type Platform = "xero";

export interface Settings {
  business_name?: string;
  invoice_due_days?: number;   // default 30
}

export interface Line { description: string; qty: number; unitPrice: number }

export interface Shipment {
  id: string;                  // the CRM shell's id for the shipment record
  title: string;               // e.g. "Stone fruit, 2 pallets to Singapore"
  buyer: { name?: string; email?: string };
  lines: Line[];
  status: "new" | "needs-details" | "drafted" | "checked" | "mismatch" | "approved" | "queued";
  reason?: string;
  invoice_id?: string;         // Xero InvoiceID, set when the draft is created
  checked_at?: string;
  approved_by?: string;
}

export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const guid = (v: unknown) => { const s = String(v ?? ""); if (!GUID.test(s)) throw new Error("xero: bad id"); return s; };
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const round2 = (n: number) => Math.round(n * 100) / 100;
export const lineTotal = (l: Line) => round2(l.qty * l.unitPrice);
export const shipTotal = (lines: Line[]) => round2(lines.reduce((a, l) => a + lineTotal(l), 0));

/** Checks the lines typed into a shipment record. Returns the reason when they cannot go to Xero. */
export function checkLines(lines: unknown): { lines: Line[] } | { reason: string } {
  if (!Array.isArray(lines) || !lines.length || lines.length > 100) return { reason: "no lines yet: add the shipment's lines" };
  const out: Line[] = [];
  for (const l of lines as any[]) {
    const description = String(l?.description ?? "").trim().slice(0, 4000);
    const qty = Number(l?.qty), unitPrice = Number(l?.unitPrice);
    if (!description) return { reason: "a line has no description" };
    if (!(qty > 0 && qty <= 1e6) || !(unitPrice >= 0 && unitPrice <= 1e9)) return { reason: `bad quantity or price on "${description.slice(0, 60)}"` };
    out.push({ description, qty, unitPrice });
  }
  return { lines: out };
}
