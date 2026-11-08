// Google Workspace (Gmail): the client report goes in as a Gmail draft (a draft operation). Its send is a live
// operation the crons only queue, so a person approves every report before it leaves the business.
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, EMAIL, GID } from "../types.ts";

const P = "google-workspace";
const ME = "me";

/** A base64url RFC 2822 message. The subject is encoded, so no header can take a line break. */
function mime(to: string, subject: string, html: string): string {
  const enc = (s: string) => `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
  const body = Buffer.from(html, "utf8").toString("base64");
  return Buffer.from([`To: ${to}`, `Subject: ${enc(subject)}`, "MIME-Version: 1.0", "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64", "", body].join("\r\n"), "utf8").toString("base64url");
}

export const googleWorkspace = {
  id: P,
  /** Create the report as a Gmail draft and return its id. */
  async draftReport(ctx: Ctx<Settings>, to: string, subject: string, html: string): Promise<string> {
    if (!EMAIL.test(to)) throw new Error("google-workspace: bad recipient");
    const r = await ctx.draft<any>({ platform: P, op: "gmail.users.drafts.create", summary: `draft report to ${to}`,
      input: { params: { userId: ME }, body: { message: { raw: mime(to, subject.slice(0, 200), html) } } } });
    const id = String(r.data?.id ?? "");
    if (!GID.test(id)) throw new Error("google-workspace: draft not created");
    return id;
  },
  /** The send, for the caller to queue for approval. */
  sendAct(draftId: string, to: string, key: string): Act {
    return { platform: P, op: "gmail.users.drafts.send", summary: `send report draft to ${to}`, key,
      input: { params: { userId: ME }, body: { id: draftId } } };
  },
};
