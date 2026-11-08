// Shared shapes for the numbers pack. Every platform read lands here as a snapshot; the pack is built from snapshots only.
export type Ledger = "xero";

export interface Settings {
  business_name?: string;
  ledger: Ledger;                       // the accounting system the owner's numbers come from
  cadence: "weekly" | "monthly";
}

export interface Period { key: string; start: string; end: string }
/** One line of a report: a label, the report's values for it (kept as the platform sent them), and its row type. */
export interface Row { label: string; values: string[]; type: string }
export interface Snapshot {
  key: string; kind: "profit-and-loss" | "bank-summary"; source: Ledger; period: Period;
  columns: string[]; rows: Row[]; pulled: string;
}
export interface Pack { key: string; period: Period; html: string; built: string; status: "draft" }

const DAY = 864e5;
export const day = (d: Date) => d.toISOString().slice(0, 10);
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
/** A string from outside the kit, cut to a sane length; anything else becomes empty. */
export const str = (v: unknown, max = 200) => (typeof v === "string" ? v.slice(0, max) : "");

/** Weekly: due on Sunday (UTC) for the seven days ending today. Monthly: due on the last day of the month (UTC) for the month so far. */
export function periodFor(now: Date, cadence: Settings["cadence"]): { due: boolean; period: Period } {
  const end = day(now);
  if (cadence === "weekly") {
    const start = day(new Date(now.getTime() - 6 * DAY));
    return { due: now.getUTCDay() === 0, period: { key: `${start}_${end}`, start, end } };
  }
  const start = `${end.slice(0, 8)}01`;
  return { due: new Date(now.getTime() + DAY).getUTCDate() === 1, period: { key: `${start}_${end}`, start, end } };
}

/** The pack as a plain, escaped HTML page for the owner to read. Nothing is sent from here. */
export function packHtml(s: Settings, p: Period, pl: Snapshot, bank?: Snapshot): string {
  const table = (snap: Snapshot) => `<table border="0" cellpadding="4"><tr><th align="left">Line</th>${snap.columns.slice(1).map((c) => `<th align="right">${esc(c)}</th>`).join("")}</tr>`
    + snap.rows.map((r) => `<tr${r.type === "SummaryRow" ? ' style="font-weight:bold"' : ""}><td>${esc(r.label)}</td>${r.values.map((v) => `<td align="right">${esc(v)}</td>`).join("")}</tr>`).join("")
    + "</table>";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(s.business_name ?? "Numbers pack")} ${esc(p.start)} to ${esc(p.end)}</title></head><body>`
    + `<h1>${esc(s.business_name ?? "Numbers pack")}</h1><p>${esc(p.start)} to ${esc(p.end)}</p>`
    + `<h2>Profit and loss</h2>${table(pl)}`
    + `<h2>Bank position</h2>${bank ? table(bank) : "<p>No bank summary was read for this period.</p>"}`
    + `<h2>Commentary</h2><p>Not written yet. The owner or the agent skill writes it before the pack goes out.</p>`
    + `</body></html>`;
}
