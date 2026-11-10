// Google Workspace: the requests tab, the Drive copy of a template, the text filled into that copy, an email draft and the
// document log. Reads and internal drafts only. Sending the email reaches the client, so it is only ever queued here.
import crypto from "node:crypto";
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, ID, EMAIL, oneLine, cell } from "../types.ts";

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

  /** Every row of the requests tab as an object keyed by the header row. Read only. */
  async records(ctx: Ctx<Settings>): Promise<Record<string, string>[]> {
    const g = ctx.settings.google;
    if (!ID.test(g.spreadsheet_id)) throw new Error("paperwork: google.spreadsheet_id is not a valid id");
    const res = await ctx.draft<any>({ platform: P, op: "sheets.spreadsheets.values.get", summary: "read the requests tab",
      input: { params: { spreadsheetId: g.spreadsheet_id, range: g.records.range } } });
    const [head = [], ...rows] = (res.data?.values ?? []) as string[][];
    const headers = head.map((h) => oneLine(h, 60));
    return rows.map((row) => Object.fromEntries(headers.map((h, i) => [h, String(row[i] ?? "")])));
  },

  /** Copy a template into the output folder as a new Doc in draft. Returns the new Doc's id. */
  async copyTemplate(ctx: Ctx<Settings>, templateId: string, name: string): Promise<string> {
    if (!ID.test(templateId)) throw new Error("paperwork: a template id is not valid");
    const res = await ctx.draft<any>({ platform: P, op: "drive.files.copy", summary: `copy the template to "${name}"`,
      input: { params: { fileId: templateId }, body: { name, parents: [ctx.settings.google.output_folder_id] } } });
    const id = String(res.data?.id ?? "");
    if (!ID.test(id)) throw new Error("google-workspace: the template copy was not created");
    return id;
  },

  /** Replace each {{Header}} placeholder in the draft with the record's value, as plain text. Running it twice changes nothing.
   *  One batch, two phases: every placeholder first becomes a random token, then each token becomes its value. A value is
   *  never scanned for placeholders, so a customer value that contains "{{Other}}" stays as written. */
  async fill(ctx: Ctx<Settings>, docId: string, fields: Record<string, string>): Promise<void> {
    const entries = Object.entries(fields);
    if (!entries.length) return;
    const nonce = crypto.randomBytes(8).toString("hex");
    const token = (i: number) => `[[fill:${nonce}:${i}]]`;
    const requests = [
      ...entries.map(([k], i) => ({ replaceAllText: { containsText: { text: `{{${k}}}`, matchCase: true }, replaceText: token(i) } })),
      ...entries.map(([, v], i) => ({ replaceAllText: { containsText: { text: token(i), matchCase: true }, replaceText: v } })),
    ];
    await ctx.draft({ platform: P, op: "docs.documents.batchUpdate", summary: `fill ${requests.length} fields`,
      input: { params: { documentId: docId }, body: { requests } } });
  },

  /** The draft's plain text, and any {{placeholder}} still in it. An empty leftover list means every field was filled. */
  async read(ctx: Ctx<Settings>, docId: string): Promise<{ text: string; leftover: string[] }> {
    const res = await ctx.draft<any>({ platform: P, op: "docs.documents.get", summary: "read the draft",
      input: { params: { documentId: docId } } });
    const text = bodyText(res.data?.body?.content ?? []);
    return { text, leftover: [...new Set(text.match(/\{\{[^{}\n]{1,60}\}\}/g) ?? [])] };
  },

  /** Comments left on the draft that are still open. */
  async openComments(ctx: Ctx<Settings>, docId: string): Promise<number> {
    const res = await ctx.draft<any>({ platform: P, op: "drive.comments.list", summary: "read open comments on the draft",
      input: { params: { fileId: docId, pageSize: 100 } } });
    return (res.data?.comments ?? []).filter((c: any) => !c.resolved && !c.deleted).length;
  },

  /** An email draft in Gmail with the plain text as its body. Creating a draft reaches nobody. Returns the draft id. */
  async emailDraft(ctx: Ctx<Settings>, to: string, subject: string, body: string): Promise<string> {
    if (!EMAIL.test(to)) throw new Error("paperwork: bad client email");
    const mime = [
      `To: ${to}`,
      `Subject: ${oneLine(subject, 150)}`,
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: 8bit",
      "",
      body.replace(/\r?\n/g, "\r\n").slice(0, 50000),
    ].join("\r\n");
    const raw = Buffer.from(mime, "utf8").toString("base64url");
    const res = await ctx.draft<any>({ platform: P, op: "gmail.users.drafts.create", summary: `draft email to ${to}`,
      input: { params: { userId: "me" }, body: { message: { raw } } } });
    const id = String(res.data?.id ?? "");
    if (!ID.test(id)) throw new Error("google-workspace: the email draft was not created");
    return id;
  },

  /** One row in the document log tab. Every value is a cell, so nothing can become a formula. */
  async log(ctx: Ctx<Settings>, row: string[]): Promise<void> {
    const g = ctx.settings.google;
    await ctx.draft({ platform: P, op: "sheets.spreadsheets.values.append", summary: "log a document row",
      input: { params: { spreadsheetId: g.spreadsheet_id, range: g.log_range, valueInputOption: "RAW", insertDataOption: "INSERT_ROWS" },
               body: { values: [row.map(cell)] } } });
  },

  /** Queue the send of an email draft. Approving it sends the email to the client. Nothing runs here. */
  async queueSend(ctx: Ctx<Settings>, draftId: string, recordId: string, summary: string): Promise<string> {
    return ctx.queue({ platform: P, op: "gmail.users.drafts.send", key: `send:${recordId}`, summary,
      input: { params: { userId: "me" }, body: { id: draftId } } }, summary);
  },
};
