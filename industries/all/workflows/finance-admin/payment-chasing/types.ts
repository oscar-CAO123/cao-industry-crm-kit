// Shared shapes for the payment-chasing workflow. Both adapters speak these, so the crons stay the same on any platform.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "xero" | "microsoft-365";
export type Tone = "friendly" | "firm" | "final";

export interface Settings {
  business_name?: string;
  mailbox: string;                                  // the business's own mailbox: reminders are drafted here
  owner_email?: string;                             // who gets the weekday digest draft (defaults to the mailbox)
  ladder: { days_overdue: number; tone: Tone }[];   // reminder stages in order, e.g. 7, 14 and 30 days overdue
  min_amount?: number;                              // leave invoices owing less than this alone
  pause_contacts?: string[];                        // Xero ContactIDs never to chase (disputes, payment plans, a reply a person must handle)
  pause_invoices?: string[];                        // Xero InvoiceIDs or invoice numbers never to chase
}

/** An unpaid sales invoice as the platform last showed it. Keyed by Xero InvoiceID. */
export interface InvoiceRow {
  id: string; number: string; contact_id: string; contact_name: string; amount_due: number;
  due: string;                                      // YYYY-MM-DD, "" when the platform gave no due date
  days_overdue: number; seen: string; closed?: string;
}

/** What has been drafted and queued for one invoice. Keyed by InvoiceID; stages keyed by stage number. */
export interface StageRec { drafted: string; to?: string; message_id?: string; approval?: string }
export interface Chase { invoice_id: string; stages: Record<string, StageRec> }

export interface Contact { first: string; name: string; email?: string }

export const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
/** Text from a customer or the platform: control characters out, length capped. It is data, never instructions. */
export const plain = (s: unknown, max: number) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DAY = 864e5;
export const keyOf = (s: string) => safeKey(s, 120);
export const day = (d: Date) => d.toISOString().slice(0, 10);

/** Xero sends dates as "/Date(1730000000000+0000)/" or as "2026-10-20T00:00:00". Either becomes YYYY-MM-DD, else "". */
export function parseXeroDate(v: unknown): string {
  const s = String(v ?? "");
  const ms = /^\/Date\((-?\d+)/.exec(s);
  if (ms) return new Date(Number(ms[1])).toISOString().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return "";
}

/** Whole days between a due date and now, from the start of the due day (UTC). Never negative. */
export function daysOverdue(due: string, now: Date): number {
  if (!due) return 0;
  const t = Date.parse(`${due}T00:00:00Z`);
  return Number.isFinite(t) ? Math.max(0, Math.floor((now.getTime() - t) / DAY)) : 0;
}

/** The stage an invoice has reached: 0 for none, otherwise the 1-based index of the furthest step it is past. */
export function stageFor(ladder: Settings["ladder"], days: number): number {
  let n = 0;
  ladder.forEach((step, i) => { if (days >= step.days_overdue) n = i + 1; });
  return n;
}

export function paused(s: Settings, r: InvoiceRow): boolean {
  return (s.pause_contacts ?? []).includes(r.contact_id) || (s.pause_invoices ?? []).some((x) => x === r.id || x === r.number);
}

/** The reminder itself. Plain, short, written to be read by a person who owes money. Escaped before it goes into HTML. */
export function reminderText(tone: Tone, r: InvoiceRow, first: string, days: number, biz: string): { subject: string; html: string } {
  const who = plain(first, 60) || "there";
  const amt = money(r.amount_due), due = r.due || "its due date";
  const lines: Record<Tone, { subject: string; body: string[] }> = {
    friendly: {
      subject: `Invoice ${r.number} is now due`,
      body: [`Hi ${who},`, `A quick note to check on invoice ${r.number} for ${amt}, which fell due on ${due}.`,
             `If it has already been paid, thank you, and please ignore this. If anything is holding it up, reply to this email and we will work it out together.`],
    },
    firm: {
      subject: `Invoice ${r.number} is ${days} days overdue`,
      body: [`Hi ${who},`, `Invoice ${r.number} for ${amt} was due on ${due} and is now ${days} days overdue.`,
             `Could you let me know when we can expect payment? If you have already paid it, reply with the date and we will check our side.`],
    },
    final: {
      subject: `Final reminder: invoice ${r.number}`,
      body: [`Hi ${who},`, `Invoice ${r.number} for ${amt} is now ${days} days overdue, and we need to agree a payment date.`,
             `Please reply within five business days with a payment date, or give us a call so we can talk through it.`],
    },
  };
  const t = lines[tone];
  const html = t.body.map((p) => `<p>${esc(p)}</p>`).join("") + `<p>Thanks,<br>${esc(plain(biz, 120) || "Accounts")}</p>`;
  return { subject: plain(t.subject, 250), html };
}

/** The weekday digest: what is overdue, what has been drafted, and what needs a person. Escaped for HTML. */
export function digestHtml(rows: { r: InvoiceRow; last: string; needsPerson: boolean; paused: boolean }[], total: number): string {
  const body = rows.map((x) => `<tr><td>${esc(x.r.number)}</td><td>${esc(plain(x.r.contact_name, 120))}</td><td align="right">${esc(money(x.r.amount_due))}</td>`
    + `<td align="right">${esc(x.r.days_overdue)}</td><td>${esc(x.last)}</td><td>${esc(x.paused ? "paused" : x.needsPerson ? "past the last reminder: a person decides" : "")}</td></tr>`).join("");
  return `<p>Overdue invoices at the last check: ${esc(rows.length)}, owing ${esc(money(total))} in total.</p>`
    + `<table cellpadding="4"><tr><th align="left">Invoice</th><th align="left">Client</th><th align="right">Owing</th><th align="right">Days</th><th align="left">Last reminder</th><th align="left">Note</th></tr>${body}</table>`
    + `<p>Reminders are drafted, never sent by the crons. Each one waits for approval in the CRM shell.</p>`;
}
