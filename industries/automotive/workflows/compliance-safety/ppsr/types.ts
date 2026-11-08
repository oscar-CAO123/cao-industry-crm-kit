// Shared shapes for the PPSR workflow. The one mapped platform is Microsoft 365: the dealer's own Excel workbook
// (a stock list and a PPSR check register) and the dealer's own mailbox for the daily digest. Nothing here runs a PPSR
// search or lodges a registration: the PPSR register has no mapped API in the kit (see SKILL.md and workflow.json gaps).

export interface Table { drive: string; item: string; table: string }

export interface Settings {
  business_name?: string;
  microsoft_365: { mailbox: string; stock: Table; checks: Table };
  compliance_contact: string;      // who receives the daily digest (the dealer's own address)
}

/** Stock list table, columns in this order: VIN | Rego | Stock no | Received */
export interface Stock { vin: string; rego: string; stock: string }
/** PPSR check register, columns in this order: Date added | VIN | Rego | Stock no | Status | Searched on | Ref | Notes */
export interface Check { added: string; vin: string; rego: string; stock: string; status: string; searched: string; ref: string; notes: string }

export const CHECK_COLS = ["Date added", "VIN", "Rego", "Stock no", "Status", "Searched on", "Ref", "Notes"] as const;
export const TO_SEARCH = "To search";          // set when a vehicle is added: a person runs the PPSR search
export const DISCHARGE_DUE = "Discharge due";  // set by a person when a security interest has ended

/** ISO 3779: 17 characters, never I, O or Q. */
export const VIN = /^[A-HJ-NPR-Z0-9]{17}$/;
export const PLATE = /^[A-Z0-9 ]{2,10}$/;
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
/** Graph ids and workbook table names: letters, digits and a few symbols only. */
export const ID = /^[A-Za-z0-9=_\-!.]{1,400}$/;

/** A spreadsheet cell that can never become a formula. */
export const cell = (v: unknown) => { const s = String(v ?? ""); return /^[=+\-@\t\r]/.test(s) ? "'" + s : s; };
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
export const day = (d: Date) => d.toISOString().slice(0, 10);

/** Stock row to a stock vehicle; null when the VIN is not a valid VIN. The rego may be blank on a new arrival. */
export function toStock(r: any[]): Stock | null {
  const vin = String(r[0] ?? "").trim().toUpperCase();
  if (!VIN.test(vin)) return null;
  const rego = String(r[1] ?? "").trim().toUpperCase();
  return { vin, rego: PLATE.test(rego) ? rego : "", stock: String(r[2] ?? "").trim().slice(0, 40) };
}

/** Check-register row to a check; null when the VIN is not valid. */
export function toCheck(r: any[]): Check | null {
  const vin = String(r[1] ?? "").trim().toUpperCase();
  if (!VIN.test(vin)) return null;
  const s = (i: number, n: number) => String(r[i] ?? "").slice(0, n);
  return { added: s(0, 20), vin, rego: s(2, 10), stock: s(3, 40), status: s(4, 40), searched: s(5, 20), ref: s(6, 80), notes: s(7, 200) };
}

/** The digest body: every line escaped, nothing in it is a link or a button. */
export function digestHtml(business: string | undefined, toSearch: Check[], due: Check[]): string {
  const li = (c: Check) => `<li>${esc(c.vin)}, ${esc(c.rego || "no rego yet")}, stock ${esc(c.stock || "none")}</li>`;
  const list = (items: Check[]) => (items.length ? `<ul>${items.map(li).join("")}</ul>` : "<p>None today.</p>");
  return `<p>Morning. Here are today's PPSR checks for ${esc(business ?? "the dealership")}.</p>`
    + `<h3>To search (${toSearch.length})</h3>${list(toSearch)}`
    + `<h3>Discharge due (${due.length})</h3>${list(due)}`
    + `<p>Searches are run on the PPSR site and recorded in the check register.</p>`;
}
