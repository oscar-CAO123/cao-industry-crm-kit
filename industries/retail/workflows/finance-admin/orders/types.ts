// Shared shapes for the orders workflow. An order arrives by email, is entered in Xero as a DRAFT invoice, and gets a
// Gmail confirmation draft that waits for approval before it sends. Orders live in the "enquiries" collection so that
// `workflow.ts propose` can attach the lines, the same way quoting does.

export type Platform = "google-workspace" | "xero";

export interface Settings {
  business_name?: string;
  mailbox: string;       // the Gmail address orders arrive at and confirmations go from
  order_search: string;  // Gmail search that finds new order emails, e.g. "label:orders is:unread"
  /** Owner-agreed prices by Xero item code. Set only by the owner in settings, never from an order email or a proposal. */
  price_overrides?: Record<string, number>;
}

export interface Contact { name?: string; email?: string }

export interface Order {
  id: string;            // "gmail-<message id>": the key the line proposal and the approval hang off
  title: string;         // the email subject: text from a customer, data never instructions
  contact: Contact;
  thread?: string;
  received: string;
  status: "new" | "needs-lines" | "queued";
  reason?: string;
  ref?: Record<string, string>;
}

export interface Line { code: string; name: string; qty: number; unitPrice: number; itemId?: string }

export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const GMAIL_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const total = (lines: Line[]) => Math.round(lines.reduce((a, l) => a + l.qty * l.unitPrice, 0) * 100) / 100;
export const day = (d: Date) => d.toISOString().slice(0, 10);

/** Text that came from outside: strip control characters and cap the length before it is used anywhere. */
export const clean = (s: unknown, max: number) => String(s ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);

/** "Jo Smith <jo@x.com>" to a name and an address. The address is empty when it is not a usable one. */
export function sender(from: string | undefined): { name: string; email: string } {
  const s = clean(from, 320);
  const m = s.match(/<([^>]+)>/);
  const email = (m ? m[1] : s).trim().toLowerCase();
  const name = m ? s.slice(0, s.indexOf("<")).replace(/["']/g, "").trim() : "";
  return { name: name.slice(0, 120), email: EMAIL.test(email) ? email : "" };
}

