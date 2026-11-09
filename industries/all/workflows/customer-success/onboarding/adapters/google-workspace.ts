// Google Workspace: the client's onboarding checklist (a Google Tasks list, internal) and the welcome email, which is a
// Gmail draft. The cron creates the draft; only an approval sends it. Nothing here reaches a client by itself.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, EMAIL, GID, clean, bodyText } from "../types.ts";

const P = "google-workspace";
const ME = "me";
const enc = (s: string) => `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;

/** A plain-text message as a base64url RFC 2822 string. The subject is encoded, so no header can take a line break. */
export function mime(to: string, subject: string, text: string): string {
  if (!EMAIL.test(to)) throw new Error("google-workspace: bad recipient");
  const body = Buffer.from(bodyText(text).replace(/\n/g, "\r\n"), "utf8").toString("base64");
  return Buffer.from([`To: ${to}`, `Subject: ${enc(clean(subject, 200))}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64", "", body].join("\r\n"), "utf8").toString("base64url");
}

const need = (v: unknown, re: RegExp, what: string): string => {
  const s = String(v ?? "");
  if (!re.test(s)) throw new Error(`google-workspace: ${what} not returned`);
  return s;
};
const checkId = (v: string, what: string) => { if (!GID.test(v)) throw new Error(`google-workspace: bad ${what} id`); return v; };

export const google = {
  id: P,
  /** A checklist for one client: a Google Tasks list. Internal, so a draft operation. */
  async newList(ctx: Ctx<Settings>, title: string): Promise<string> {
    const r = await ctx.draft<any>({ platform: P, op: "tasks.tasklists.insert", summary: `create checklist ${clean(title, 80)}`,
      input: { body: { title: clean(title, 200) } } });
    return need(r.data?.id, GID, "checklist");
  },
  /** One step on the checklist. */
  async addTask(ctx: Ctx<Settings>, list: string, title: string): Promise<void> {
    await ctx.draft({ platform: P, op: "tasks.tasks.insert", summary: `add checklist step ${clean(title, 60)}`,
      input: { params: { tasklist: checkId(list, "checklist") }, body: { title: clean(title, 200) } } });
  },
  /** Done and open steps on a checklist (the first 100 steps). */
  async checklist(ctx: Ctx<Settings>, list: string): Promise<{ done: number; open: number }> {
    const r = await ctx.draft<any>({ platform: P, op: "tasks.tasks.list", summary: "read checklist",
      input: { params: { tasklist: checkId(list, "checklist"), showCompleted: true, showHidden: true, maxResults: 100 } } });
    const items: any[] = Array.isArray(r.data?.items) ? r.data.items : [];
    const done = items.filter((t) => t?.status === "completed").length;
    return { done, open: items.length - done };
  },
  /** A plain-text email kept as a Gmail draft. Nothing leaves the mailbox. The run log names the client, never the address. */
  async draft(ctx: Ctx<Settings>, to: string, subject: string, text: string, client: string): Promise<string> {
    const r = await ctx.draft<any>({ platform: P, op: "gmail.users.drafts.create", summary: `draft email for client ${clean(client, 61)}: ${clean(subject, 80)}`,
      input: { params: { userId: ME }, body: { message: { raw: mime(to, subject, text) } } } });
    return need(r.data?.id, GID, "draft");
  },
  /** Queue the send of an existing draft. Approving sends this exact draft. */
  queueSend(ctx: Ctx<Settings>, draftId: string, summary: string, key: string): Promise<string> {
    return ctx.queue({ platform: P, op: "gmail.users.drafts.send", key, summary,
      input: { params: { userId: ME }, body: { id: checkId(draftId, "draft") } } }, summary);
  },
};
