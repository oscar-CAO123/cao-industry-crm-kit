// Google Workspace: the records tab, the Drive copy of a template, the text filled into that copy, and the document log.
// Reads and internal drafts only. Sharing a finished document reaches the client, so it is only ever queued here.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, ID, oneLine, cell } from "../types.ts";

const P = "google-workspace";

/** Text from every paragraph and table cell of a Doc body, in reading order. */
function bodyText(els: any[]): string {
  let out = "";
  for (const el of els ?? []) {
    for (const e of el.paragraph?.elements ?? []) out += e.textRun?.content ?? "";
    for (const row of el.table?.tableRows ?? []) for (const c of row.tableCells ?? []) out += bodyText(c.content ?? []);
    if (el.tableOfContents) out += bodyText(el.tableOfContents.content ?? []);
  }
  return out;
}

export const googleWorkspace = {
  id: P,

  /** Every row of the records tab as an object keyed by the header row. Read only. */
  async records(ctx: Ctx<Settings>): Promise<Record<string, string>[]> {
    const g = ctx.settings.google;
    if (!ID.test(g.spreadsheet_id)) throw new Error("documents: google.spreadsheet_id is not a valid id");
    const res = await ctx.draft<any>({ platform: P, op: "sheets.spreadsheets.values.get", summary: "read the records tab",
      input: { params: { spreadsheetId: g.spreadsheet_id, range: g.records.range } } });
    const [head = [], ...rows] = (res.data?.values ?? []) as string[][];
    const headers = head.map((h) => oneLine(h, 60));
    return rows.map((row) => Object.fromEntries(headers.map((h, i) => [h, String(row[i] ?? "")])));
  },

  /** Copy a template into the output folder as a new Doc in draft. Returns the new Doc's id. */
  async copyTemplate(ctx: Ctx<Settings>, templateId: string, name: string): Promise<string> {
    if (!ID.test(templateId)) throw new Error("documents: a template id is not valid");
    const res = await ctx.draft<any>({ platform: P, op: "drive.files.copy", summary: `copy the template to "${name}"`,
      input: { params: { fileId: templateId }, body: { name, parents: [ctx.settings.google.output_folder_id] } } });
    const id = String(res.data?.id ?? "");
    if (!ID.test(id)) throw new Error("google-workspace: the template copy was not created");
    return id;
  },

  /** Replace each {{Header}} placeholder in the draft with the record's value, as plain text. */
  async fill(ctx: Ctx<Settings>, docId: string, fields: Record<string, string>): Promise<void> {
    const requests = Object.entries(fields).map(([k, v]) => ({ replaceAllText: { containsText: { text: `{{${k}}}`, matchCase: true }, replaceText: v } }));
    if (!requests.length) return;
    await ctx.draft({ platform: P, op: "docs.documents.batchUpdate", summary: `fill ${requests.length} fields`,
      input: { params: { documentId: docId }, body: { requests } } });
  },

  /** Any {{placeholder}} still in the draft after filling. An empty list means every field was filled. */
  async leftover(ctx: Ctx<Settings>, docId: string): Promise<string[]> {
    const res = await ctx.draft<any>({ platform: P, op: "docs.documents.get", summary: "check the draft for unfilled placeholders",
      input: { params: { documentId: docId } } });
    const text = bodyText(res.data?.body?.content ?? []);
    return [...new Set(text.match(/\{\{[^{}\n]{1,60}\}\}/g) ?? [])];
  },

  /** Comments left on the draft that are still open. */
  async openComments(ctx: Ctx<Settings>, docId: string): Promise<number> {
    const res = await ctx.draft<any>({ platform: P, op: "drive.comments.list", summary: "read open comments on the draft",
      input: { params: { fileId: docId, pageSize: 100 } } });
    return (res.data?.comments ?? []).filter((c: any) => !c.resolved && !c.deleted).length;
  },

  /** One row in the document log tab. Every value is a cell, so nothing can become a formula. */
  async log(ctx: Ctx<Settings>, row: string[]): Promise<void> {
    const g = ctx.settings.google;
    await ctx.draft({ platform: P, op: "sheets.spreadsheets.values.append", summary: "log a document row",
      input: { params: { spreadsheetId: g.spreadsheet_id, range: g.log_range, valueInputOption: "RAW", insertDataOption: "INSERT_ROWS" },
               body: { values: [row.map(cell)] } } });
  },

  /** Queue the share to the client. Approving it runs the share and Google emails the link. Nothing runs here. */
  async queueShare(ctx: Ctx<Settings>, docId: string, email: string, role: string, label: string): Promise<string> {
    const summary = `Share "${oneLine(label, 80)}" with ${email} as ${role}; Google emails them a link`;
    return ctx.queue({ platform: P, op: "drive.permissions.create", key: `share:${docId}:${email}`, summary,
      input: { params: { fileId: docId, sendNotificationEmail: true }, body: { type: "user", role, emailAddress: email } } }, summary);
  },
};
