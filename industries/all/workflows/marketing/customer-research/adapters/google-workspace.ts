// Google Workspace: survey answers from a Google Form, an internal research log in Sheets, and invites as Gmail drafts.
// Every operation here is a draft operation (reads, a draft, a row in a log). The one send, gmail.users.drafts.send,
// is only ever built as an act for the approval queue; a cron never runs it.
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Response, type Answer, type Settings, EMAIL, cell, keyFor, GMAIL_ID } from "../types.ts";

const P = "google-workspace";
const FORM_ID = /^[A-Za-z0-9_-]{10,120}$/;
const SHEET_ID = /^[A-Za-z0-9_-]{20,120}$/;

/** A MIME message as Gmail's drafts.create takes it: To, a UTF-8 subject, and an HTML body, base64url encoded. */
export function mimeRaw(to: string, subject: string, html: string): string {
  if (/[\r\n]/.test(to) || /[\r\n]/.test(subject)) throw new Error("google-workspace: header line break refused");
  const body = Buffer.from(html, "utf8").toString("base64").match(/.{1,76}/g)!.join("\r\n");
  const head = [
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`,
    "MIME-Version: 1.0",
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ].join("\r\n");
  return Buffer.from(`${head}\r\n\r\n${body}`, "utf8").toString("base64url");
}

export const googleWorkspace = {
  /** Every response to the form, read page by page with the question titles attached. */
  async responses(ctx: Ctx<Settings>, formId: string): Promise<Response[]> {
    if (!FORM_ID.test(formId)) throw new Error("google-workspace: bad form id");
    const form = await ctx.draft<any>({ platform: P, op: "forms.forms.get", summary: "read form questions", input: { params: { formId } } });
    const titles = new Map<string, string>();
    for (const it of form.data?.items ?? []) {
      const qid = it?.questionItem?.question?.questionId;
      if (typeof qid === "string") titles.set(qid, String(it.title ?? qid).slice(0, 200));
    }
    const out: Response[] = [];
    let page: string | undefined;
    for (let i = 0; i < 10; i++) {
      const r = await ctx.draft<any>({ platform: P, op: "forms.forms.responses.list", summary: "read form responses",
        input: { params: { formId, pageSize: 100, ...(page ? { pageToken: page } : {}) } } });
      for (const x of r.data?.responses ?? []) {
        const id = String(x.responseId ?? "");
        if (!/^[A-Za-z0-9_-]{4,200}$/.test(id)) continue;
        const answers: Answer[] = Object.entries(x.answers ?? {}).map(([qid, a]: [string, any]) => ({
          question: titles.get(qid) ?? "Question",
          answer: (a?.textAnswers?.answers ?? []).map((t: any) => String(t?.value ?? "")).join(", ").trim().slice(0, 2000),
        }));
        const email = typeof x.respondentEmail === "string" && EMAIL.test(x.respondentEmail.trim()) ? x.respondentEmail.trim() : undefined;
        out.push({ key: keyFor("g", id), source: "google-forms", received: String(x.lastSubmittedTime ?? x.createTime ?? ctx.now.toISOString()), email, answers });
      }
      page = r.data?.nextPageToken;
      if (!page) break;
    }
    return out;
  },

  /** One row per response in the internal research log. */
  async logRow(ctx: Ctx<Settings>, log: { spreadsheet_id: string; sheet?: string }, r: Response): Promise<void> {
    if (!SHEET_ID.test(log.spreadsheet_id)) throw new Error("google-workspace: bad spreadsheet id");
    const row = [r.received, r.source, r.email ?? "", ...r.answers.map((a) => `${a.question}: ${a.answer}`)].map((v) => cell(v));
    await ctx.draft({ platform: P, op: "sheets.spreadsheets.values.append", summary: "add a row to the research log",
      input: { params: { spreadsheetId: log.spreadsheet_id, range: log.sheet ?? "Responses", valueInputOption: "RAW" }, body: { values: [row] } } });
  },

  /** Create a Gmail draft (a draft operation). Returns the draft id. Nothing is sent. */
  async draftMail(ctx: Ctx<Settings>, to: string, subject: string, html: string): Promise<string> {
    if (!EMAIL.test(to)) throw new Error("google-workspace: bad recipient");
    const r = await ctx.draft<any>({ platform: P, op: "gmail.users.drafts.create", summary: `draft email to ${to}`,
      input: { params: { userId: "me" }, body: { message: { raw: mimeRaw(to, subject.slice(0, 200), html) } } } });
    const id = String(r.data?.id ?? "");
    if (!GMAIL_ID.test(id)) throw new Error("google-workspace: draft not created");
    return id;
  },

  /** The send, as an act for the approval queue. Only a person's approval runs it. */
  sendAct(draftId: string, to: string, key: string): Act {
    if (!GMAIL_ID.test(draftId)) throw new Error("google-workspace: bad draft id");
    return { platform: P, op: "gmail.users.drafts.send", summary: `send email to ${to}`, key,
      input: { params: { userId: "me" }, body: { id: draftId } } };
  },
};
