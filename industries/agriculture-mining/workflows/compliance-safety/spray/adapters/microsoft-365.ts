// Microsoft 365: the owner's own register workbook (read to avoid repeats, and appended to) and an Outlook draft to the
// quality-check mailbox. The send itself is only ever queued here; a person approves it.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type SprayRecord, EMAIL, ID, MSG_ID, rowFor } from "../types.ts";

const P = "microsoft-365";

const cfg = (s: Settings) => {
  const m = s.microsoft_365;
  if (!m?.mailbox || !EMAIL.test(m.mailbox)) throw new Error("microsoft_365.mailbox is not set");
  const r = m.register;
  for (const v of [r?.drive, r?.item, r?.table]) if (!v || !ID.test(v)) throw new Error("microsoft-365: register ids are missing or malformed");
  return m;
};
const table = (m: Settings["microsoft_365"]) => ({ "drive-id": m.register.drive, "driveItem-id": m.register.item, "workbookTable-id": m.register.table });

export const microsoft365 = {
  /** Record ids already on the register (the first column), so a re-run never writes a row twice. */
  async registeredIds(ctx: Ctx<Settings>): Promise<Set<string>> {
    const m = cfg(ctx.settings);
    const r = await ctx.draft<any>({ platform: P, op: "drives.items.workbook.tables.ListRows", summary: "read register rows",
      input: { params: { ...table(m), $top: 1000 } } });
    const ids = (Array.isArray(r.data?.value) ? r.data.value : []).map((row: any) => String(row?.values?.[0]?.[0] ?? ""));
    return new Set(ids.filter((x: string) => ID.test(x)));
  },
  /** Append one record as a register row (an internal workbook row: a draft operation). */
  async appendRow(ctx: Ctx<Settings>, rec: SprayRecord): Promise<void> {
    const m = cfg(ctx.settings);
    await ctx.draft({ platform: P, op: "drives.items.workbook.tables.CreateRows", summary: `register ${rec.id}`,
      input: { params: table(m), body: { values: [rowFor(rec)] } } });
  },
  /** Create the QC email as an Outlook draft in the business mailbox and return its id. Nothing is sent here. */
  async qcDraft(ctx: Ctx<Settings>, to: string, subject: string, html: string): Promise<string> {
    const m = cfg(ctx.settings);
    if (!EMAIL.test(to)) throw new Error("microsoft-365: bad QC recipient");
    const r = await ctx.draft<any>({ platform: P, op: "users.CreateMessages", summary: `draft QC email to ${to}`,
      input: { params: { "user-id": m.mailbox }, body: { subject: subject.slice(0, 250), body: { contentType: "HTML", content: html },
        toRecipients: [{ emailAddress: { address: to } }] } } });
    const id = String(r.data?.id ?? "");
    if (!MSG_ID.test(id)) throw new Error("microsoft-365: draft not created");
    return id;
  },
  /** The live act that sends a drafted message. Only ever passed to ctx.queue. */
  sendAct(ctx: Ctx<Settings>, messageId: string, to: string, key: string) {
    const m = cfg(ctx.settings);
    if (!MSG_ID.test(messageId)) throw new Error("microsoft-365: bad message id");
    return { platform: P, op: "users.user.messages.message.send", summary: `send QC email to ${to}`, key,
      input: { params: { "user-id": m.mailbox, "message-id": messageId } } };
  },
};
