// Microsoft 365 (Graph): the expiry register is an Excel table read through the workbook API, and every email is an
// Outlook draft. Sending is never done here: the send operation is returned to the caller to queue for approval.
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type RegisterRow, type Settings, EMAIL, keyOf, parseExpiry, daysLeft } from "../types.ts";

const P = "microsoft-365";
const ID = /^[A-Za-z0-9=_\-!.]{1,400}$/;

const cfg = (s: Settings) => {
  const m = s.microsoft_365;
  if (!m?.mailbox || !EMAIL.test(m.mailbox)) throw new Error("microsoft_365.mailbox is not set");
  return m;
};
const table = (t: { drive: string; item: string; table: string }) => {
  for (const v of [t.drive, t.item, t.table]) if (!ID.test(v)) throw new Error("microsoft-365: bad workbook id");
  return { "drive-id": t.drive, "driveItem-id": t.item, "workbookTable-id": t.table };
};

const PAGE = 500, MAX_PAGES = 10;

/** Every row of the register: Holder, Email, Item, Expiry. Rows with no holder or item are skipped.
 *  Pages through the whole table; a register past MAX_PAGES pages is refused, never read partly. */
export async function readRegister(ctx: Ctx<Settings>): Promise<RegisterRow[]> {
  const s = ctx.settings;
  const values: any[] = [];
  for (let page = 0; ; page++) {
    const r = await ctx.draft<any>({ platform: P, op: "drives.items.workbook.tables.ListRows", summary: "read expiry register",
      input: { params: { ...table(cfg(s).register), $top: PAGE, $skip: page * PAGE } } });
    const rows: any[] = Array.isArray(r.data?.value) ? r.data.value : [];
    values.push(...rows);
    if (rows.length < PAGE) break;
    if (page + 1 >= MAX_PAGES) throw new Error(`expiry register has more than ${PAGE * MAX_PAGES} rows: split it before reading`);
  }
  const out: RegisterRow[] = [];
  for (const row of values) {
    const v: any[] = Array.isArray(row?.values) ? row.values[0] : [];
    if (!Array.isArray(v)) continue;
    const holder = String(v[0] ?? "").trim().slice(0, 120);
    const item = String(v[2] ?? "").trim().slice(0, 160);
    if (!/[a-z0-9]/i.test(holder) || !/[a-z0-9]/i.test(item)) continue;
    const email = String(v[1] ?? "").trim();
    const expiry = parseExpiry(v[3]);
    const days = expiry ? daysLeft(ctx.now, expiry) : undefined;
    const status = days === undefined ? "unknown" : days < 0 ? "expired" : days <= (s.digest_within_days ?? 90) ? "due" : "ok";
    out.push({ key: keyOf(`${holder}|${item}`), holder, email: EMAIL.test(email) ? email : undefined, item, expiry, days_left: days, status });
  }
  return out;
}

/** An Outlook draft to one recipient (a draft operation). Returns the send act for the caller to queue for approval. */
export async function mailDraft(ctx: Ctx<Settings>, to: string, subject: string, html: string): Promise<{ messageId: string; act: Act }> {
  if (!EMAIL.test(to)) throw new Error("microsoft-365: bad recipient");
  const box = cfg(ctx.settings).mailbox;
  const r = await ctx.draft<any>({ platform: P, op: "users.CreateMessages", summary: `draft email to ${to}`,
    input: { params: { "user-id": box }, body: {
      subject: subject.slice(0, 250), body: { contentType: "HTML", content: html }, toRecipients: [{ emailAddress: { address: to } }] } } });
  const id = String(r.data?.id ?? "");
  if (!ID.test(id)) throw new Error("microsoft-365: draft not created");
  return { messageId: id, act: { platform: P, op: "users.user.messages.message.send", summary: `send email to ${to}`,
    input: { params: { "user-id": box, "message-id": id } } } };
}
