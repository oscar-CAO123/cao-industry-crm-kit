// Microsoft 365 for the yield-and-waste workflow: the yield register is an Excel table in the shed's workbook, exception
// rows go to a second table, and the weekly report is an Outlook draft that a person approves before it is sent.
// Operation ids come from the kit's microsoft-365 ops; the workbook row body is Graph's workbookTableRow (values: one array of cells per row).
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type Lot, type Exception, type Table, ID, LOT, EMAIL, cell, num } from "../types.ts";

const P = "microsoft-365";
const cfg = (ctx: Ctx<Settings>) => {
  const m = ctx.settings.microsoft_365;
  if (!m?.mailbox || !EMAIL.test(m.mailbox)) throw new Error("microsoft_365.mailbox is not set");
  return m;
};
const tableParams = (t: Table) => {
  for (const v of [t.drive, t.item, t.table]) if (!ID.test(v)) throw new Error("microsoft-365: bad workbook id");
  return { "drive-id": t.drive, "driveItem-id": t.item, "workbookTable-id": t.table };
};

/** Each register row is [Date, Lot, Area, Gross kg, Packed kg, Waste kg]. A row that does not add up is refused, never guessed at. */
export async function readRegister(ctx: Ctx<Settings>): Promise<{ lots: Omit<Lot, "seen">[]; rejected: number }> {
  const r = await ctx.draft<any>({ platform: P, op: "drives.items.workbook.tables.ListRows", summary: "read yield register",
    input: { params: { ...tableParams(cfg(ctx).register), $top: 500 } } });
  const lots: Omit<Lot, "seen">[] = [];
  let rejected = 0;
  for (const row of r.data?.value ?? []) {
    const v: unknown[] = row.values?.[0] ?? [];
    const lot = String(v[1] ?? "").trim();
    const gross = num(v[3]), packed = num(v[4]), waste = num(v[5]);
    if (!LOT.test(lot) || !(gross > 0) || !(packed >= 0) || !(waste >= 0) || packed + waste > gross * 1.01) { rejected++; continue; }
    const day = String(v[0] ?? "").slice(0, 10);
    lots.push({ lot, date: /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : "", area: String(v[2] ?? "").slice(0, 60),
                gross_kg: gross, packed_kg: packed, waste_kg: waste });
  }
  return { lots, rejected };
}

/** One exception row in the shed's exceptions table. Returns false when no exceptions table is set (the row then stays in the store only). */
export async function writeException(ctx: Ctx<Settings>, x: Exception): Promise<boolean> {
  const ex = cfg(ctx).exceptions;
  if (!ex) return false;
  await ctx.draft({ platform: P, op: "drives.items.workbook.tables.CreateRows", summary: `exception row for lot ${x.lot}`,
    input: { params: tableParams(ex), body: { values: [[cell(x.date), cell(x.lot), x.yield_pct, x.waste_pct, cell(x.reasons.join("; ")), "Open"]] } } });
  return true;
}

/** An Outlook draft in the shed's mailbox. Returns the message id; sending it is a separate, approved act. */
export async function mailDraft(ctx: Ctx<Settings>, to: string, subject: string, html: string): Promise<string> {
  if (!EMAIL.test(to)) throw new Error("microsoft-365: bad recipient");
  const r = await ctx.draft<any>({ platform: P, op: "users.CreateMessages", summary: `draft report email to ${to}`,
    input: { params: { "user-id": cfg(ctx).mailbox }, body: {
      subject: subject.slice(0, 250), body: { contentType: "HTML", content: html }, toRecipients: [{ emailAddress: { address: to } }] } } });
  const id = String(r.data?.id ?? "");
  if (!ID.test(id)) throw new Error("microsoft-365: draft not created");
  return id;
}

/** The live act that sends a drafted message. Only ever queued; a person approves it. */
export function sendAct(ctx: Ctx<Settings>, messageId: string, key: string): Act {
  return { platform: P, op: "users.user.messages.message.send", key, summary: "send the weekly yield report",
    input: { params: { "user-id": cfg(ctx).mailbox, "message-id": messageId } } };
}
