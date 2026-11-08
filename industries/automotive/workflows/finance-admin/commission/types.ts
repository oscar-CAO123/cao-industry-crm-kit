// Shared shapes for the commission workflow. Xero is the only adapter. Every id that comes from outside is checked
// before it goes into a path or a filter.

export interface Tier { from: number; rate: number }
export interface Rep { name: string; employee_id: string; match: string }
export interface Settings {
  business_name?: string;
  payroll_calendar_id: string;          // Xero payroll calendar that runs monthly
  commission_earnings_rate_id: string;  // Xero earnings rate that commission is paid under
  tiers: Tier[];                        // rate on a rep's paid sales ex GST for the month; the highest tier reached applies to all of it
  reps: Rep[];
}
export interface Period { period: string; start: string; end: string }   // "2026-10", "2026-10-01", "2026-10-31"
export interface Commission {
  key: string; period: string; employee_id: string; rep: string;
  sales_ex_gst: number; rate: number; amount: number; invoices: string[];
  status: "calculated" | "entered" | "none";   // none: no commission this month
  pay_run?: string; payslip?: string; entered?: string;
}

export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const guid = (v: unknown) => { const s = String(v ?? ""); if (!GUID.test(s)) throw new Error("xero: bad id"); return s; };
export const money2 = (n: number) => Math.round(n * 100) / 100;

/** The last full calendar month before `now`: the month being commissioned. */
export function closedPeriod(now: Date): Period {
  const first = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const last = new Date(first - 864e5);
  const y = last.getUTCFullYear(), m = String(last.getUTCMonth() + 1).padStart(2, "0"), d = String(last.getUTCDate()).padStart(2, "0");
  return { period: `${y}-${m}`, start: `${y}-${m}-01`, end: `${y}-${m}-${d}` };
}

/** The rate of the highest tier the sales reach. */
export function rateFor(tiers: Tier[], sales: number): number {
  let rate = 0;
  for (const t of [...tiers].sort((a, b) => a.from - b.from)) if (sales >= t.from) rate = t.rate;
  return rate;
}

/** Settings are configuration typed by a person: check them before any call uses them. */
export function checkSettings(s: Settings): void {
  const xid = (v: unknown, what: string) => { if (!GUID.test(String(v ?? ""))) throw new Error(`commission: ${what} is not a Xero id`); };
  xid(s.payroll_calendar_id, "payroll_calendar_id");
  xid(s.commission_earnings_rate_id, "commission_earnings_rate_id");
  if (!Array.isArray(s.tiers) || !s.tiers.length) throw new Error("commission: set tiers");
  for (const t of s.tiers) if (!(t.from >= 0) || !(t.rate >= 0 && t.rate <= 1)) throw new Error("commission: a tier has a bad from or rate");
  if (!Array.isArray(s.reps) || !s.reps.length) throw new Error("commission: set reps");
  for (const r of s.reps) {
    xid(r.employee_id, `employee_id for ${r.name}`);
    if (!r.match || r.match.length > 100) throw new Error(`commission: ${r.name} needs a match text of 1 to 100 characters`);
  }
}
