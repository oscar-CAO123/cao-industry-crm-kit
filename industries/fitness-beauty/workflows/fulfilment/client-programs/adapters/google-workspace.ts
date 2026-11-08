// Google Workspace: check-in emails are created as Gmail drafts (a draft operation). Sending the draft is a live
// operation, queued by the cron and run only when a person approves it. The send is pinned to the client's own mailbox.
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, EMAIL } from "../types.ts";

const P = "google-workspace";
const DRAFT_ID = /^[A-Za-z0-9_-]{1,200}$/;

// A header value cannot carry a line break; a subject with other characters is sent as an RFC 2047 base64 word.
const header = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

/** An RFC 2822 plain-text message, base64url encoded, as the Gmail API expects it. */
export function rawMessage(to: string, subject: string, body: string): string {
  const subj = `=?UTF-8?B?${Buffer.from(header(subject), "utf8").toString("base64")}?=`;
  const msg = [
    `To: ${header(to)}`,
    `Subject: ${subj}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    body.replace(/\r\n/g, "\n"),
  ].join("\r\n");
  return Buffer.from(msg, "utf8").toString("base64url");
}

/** Create a Gmail draft (a draft operation) and return its id. */
export async function draftEmail(ctx: Ctx<Settings>, m: { to: string; subject: string; body: string }): Promise<string> {
  if (!EMAIL.test(m.to)) throw new Error("google-workspace: bad recipient");
  const r = await ctx.draft<any>({ platform: P, op: "gmail.users.drafts.create", summary: `draft email to ${m.to}`, input: {
    params: { userId: "me" }, body: { message: { raw: rawMessage(m.to, m.subject, m.body) } } } });
  const id = String(r.data?.id ?? "");
  if (!DRAFT_ID.test(id)) throw new Error("google-workspace: draft not created");
  return id;
}

/** The live act that sends a draft. Cron code only queues it; it never runs it. */
export function sendDraftAct(draftId: string, to: string): Act {
  if (!DRAFT_ID.test(draftId)) throw new Error("google-workspace: bad draft id");
  return { platform: P, op: "gmail.users.drafts.send", summary: `send check-in email to ${to}`, input: { params: { userId: "me" }, body: { id: draftId } } };
}

export const googleWorkspace = { id: P, draftEmail, sendDraftAct };
