// Google Workspace: the selections register (Sheets), and the pack and chase emails as Gmail drafts.
// Reads and drafts only. A draft reaches nobody; sending one is only ever queued for a person to approve.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type SelectionRow, HEADERS, RANGE, SHEET_ID, STATUSES, clean, dueLabel } from "../types.ts";

const P = "google-workspace";
const ME = "me";
const DRAFT_ID = /^[A-Za-z0-9_-]{1,200}$/;

/** Refuses bad settings before any call: the sheet id and range go into a request path, and the form link goes into an email. */
export function checkSettings(s: Settings): void {
  if (!SHEET_ID.test(s.google?.spreadsheet_id ?? "")) throw new Error("selections: google.spreadsheet_id is not a valid id");
  if (!RANGE.test(s.google?.register_range ?? "")) throw new Error("selections: google.register_range is not a valid range");
  let url: URL;
  try { url = new URL(s.selections?.form_url ?? ""); } catch { throw new Error("selections: selections.form_url is not a URL"); }
  if (url.protocol !== "https:") throw new Error("selections: selections.form_url must be https");
}

/** Every row of the register as a typed row. Read only. Rows with no project or selection name are skipped. */
export async function register(ctx: Ctx<Settings>): Promise<SelectionRow[]> {
  const g = ctx.settings.google!;
  const res = await ctx.draft<any>({ platform: P, op: "sheets.spreadsheets.values.get", summary: "read the selections register",
    input: { params: { spreadsheetId: g.spreadsheet_id, range: g.register_range } } });
  const [head = [], ...rows] = (res.data?.values ?? []) as string[][];
  const cols = head.map((h) => clean(h, 60));
  for (const h of HEADERS) if (!cols.includes(h)) throw new Error(`selections: the register has no "${h}" column`);
  const at = (row: string[], name: string) => clean(row[cols.indexOf(name)], 300);
  const out: SelectionRow[] = [];
  for (const row of rows) {
    const project = at(row, "Project"), selection = at(row, "Selection");
    if (!project || !selection) continue;
    const status = at(row, "Status").toLowerCase().replace(/\s+/g, "-");
    out.push({
      project, client: at(row, "Client"), email: at(row, "Email").toLowerCase(), selection,
      allowance: at(row, "Allowance"), chosen: at(row, "Chosen"),
      status: (STATUSES as readonly string[]).includes(status) ? (status as SelectionRow["status"]) : "other",
      due: at(row, "Due"),
    });
  }
  return out;
}

/** A plain-text email as a raw RFC 2822 message. Every line is cleaned, so nothing can add a header. */
function raw(to: string, subject: string, lines: string[]): string {
  const subj = clean(subject, 150);
  const head = [
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subj, "utf8").toString("base64")}?=`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
  ];
  const body = lines.map((l) => clean(l, 500)).join("\r\n");
  return Buffer.from(`${head.join("\r\n")}\r\n\r\n${body}\r\n`, "utf8").toString("base64url");
}

/** The pack email: what to choose, where, and by when. */
export function packMail(s: Settings, r: SelectionRow): { subject: string; lines: string[] } {
  const sign = s.selections?.signoff ?? s.business_name ?? "";
  return {
    subject: `Your ${r.selection} selections for ${r.project}`,
    lines: [
      `Hi ${r.client || "there"},`, "",
      `Your selection pack for ${r.selection} on ${r.project} is ready. Please make your choices in the form below.`, "",
      s.selections!.form_url, "",
      `We need your choices by ${dueLabel(r.due)}, so we can order on time.`, "",
      "Reply to this email if you have any questions.", "",
      sign,
    ],
  };
}

/** The chase email, numbered so each one reads as a follow-up rather than a repeat. */
export function chaseMail(s: Settings, r: SelectionRow, n: number): { subject: string; lines: string[] } {
  const sign = s.selections?.signoff ?? s.business_name ?? "";
  return {
    subject: `Still to choose: ${r.selection} for ${r.project}`,
    lines: [
      `Hi ${r.client || "there"},`, "",
      `We have not had your choice for ${r.selection} on ${r.project} yet${n > 1 ? " (this is follow-up " + n + ")" : ""}.`, "",
      `The form is here: ${s.selections!.form_url}`, "",
      `Could you let us know by ${dueLabel(r.due)}? If you would like to talk it through first, reply and we will call you.`, "",
      sign,
    ],
  };
}

/** Create a Gmail draft to one recipient. A draft, never a send. Returns the draft id. */
export async function createDraft(ctx: Ctx<Settings>, to: string, m: { subject: string; lines: string[] }): Promise<string> {
  const res = await ctx.draft<any>({ platform: P, op: "gmail.users.drafts.create", summary: `draft email to ${to}: ${clean(m.subject, 80)}`,
    input: { params: { userId: ME }, body: { message: { raw: raw(to, m.subject, m.lines) } } } });
  const id = String(res.data?.id ?? "");
  if (!DRAFT_ID.test(id)) throw new Error("google-workspace: the draft came back without an id");
  return id;
}

/** Queue the send of an existing draft for a person to approve. Queued once per key. */
export function queueSend(ctx: Ctx<Settings>, draftId: string, key: string, summary: string): Promise<string> {
  if (!DRAFT_ID.test(draftId)) throw new Error("google-workspace: bad draft id");
  return ctx.queue({ platform: P, op: "gmail.users.drafts.send", key, summary,
    input: { params: { userId: ME }, body: { id: draftId } } }, summary);
}

export const googleWorkspace = { register, createDraft, queueSend };
