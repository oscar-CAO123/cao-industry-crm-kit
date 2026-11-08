// Google Workspace: questions from Gmail and a Chat space, SOPs from Drive, replies as Gmail drafts (sent on approval)
// or Chat messages (sent on approval), and a question register in a Sheet. Every id from outside is checked before it
// goes into a path, a query or a header.
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Adapter, type Question, type Settings, type Source, EMAIL, cell, clean, keyOf, oneLine } from "../types.ts";

const P = "google-workspace" as const;
const ID = /^[A-Za-z0-9_-]{1,120}$/;
const SPACE = /^spaces\/[A-Za-z0-9_-]{1,120}$/;
const SPACE_MSG = /^spaces\/[A-Za-z0-9_-]{1,120}\/messages\/[A-Za-z0-9_.-]{1,120}$/;
const SPACE_THREAD = /^spaces\/[A-Za-z0-9_-]{1,120}\/threads\/[A-Za-z0-9_.-]{1,120}$/;
const SHEET = /^[A-Za-z0-9_-]{10,100}$/;
const RANGE = /^[A-Za-z0-9 !:'$]{1,120}$/;

const header = (p: any, name: string): string =>
  String(p?.headers?.find((h: any) => String(h?.name ?? "").toLowerCase() === name.toLowerCase())?.value ?? "");

/** The first text/plain part of a Gmail message, decoded. Gmail sends the body base64url-encoded. */
function plainText(part: any, depth = 0): string {
  if (!part || depth > 6) return "";
  if (part.mimeType === "text/plain" && typeof part.body?.data === "string") return Buffer.from(part.body.data, "base64url").toString("utf8");
  for (const p of part.parts ?? []) { const t = plainText(p, depth + 1); if (t) return t; }
  return "";
}

async function gmailQuestions(ctx: Ctx<Settings>) {
  const q = ctx.settings.google?.questions_query ?? "label:staff-questions is:unread";
  const list = await ctx.draft<any>({ platform: P, op: "gmail.users.messages.list", summary: "list new staff questions in Gmail",
    input: { params: { userId: "me", q, maxResults: 25 } } });
  const out: Omit<Question, "status">[] = [];
  for (const m of list.data?.messages ?? []) {
    if (!ID.test(String(m?.id ?? "")) || !ID.test(String(m?.threadId ?? ""))) continue;
    const r = await ctx.draft<any>({ platform: P, op: "gmail.users.messages.get", summary: "read a staff question",
      input: { params: { userId: "me", id: m.id, format: "full" } } });
    const msg = r.data, p = msg?.payload;
    const from = header(p, "From"), addr = (from.match(/<([^>]+)>/)?.[1] ?? from).trim();
    const name = from.replace(/<[^>]*>/, "").replace(/"/g, "").trim();
    out.push({ id: keyOf(`gmail:${m.id}`), source: P, title: oneLine(header(p, "Subject") || "Staff question", 160),
      text: clean(plainText(p) || msg?.snippet, 4000), asker: { name: oneLine(name, 120) || undefined, email: EMAIL.test(addr) ? addr : undefined },
      received: new Date(Number(msg?.internalDate ?? ctx.now.getTime())).toISOString(),
      thread: { gmail_thread: m.threadId, message_id: oneLine(header(p, "Message-ID"), 300) } });
  }
  return out;
}

async function chatQuestions(ctx: Ctx<Settings>) {
  const space = ctx.settings.google?.chat_space;
  if (!space) return [];
  if (!SPACE.test(space)) throw new Error("google.chat_space must look like spaces/AAAA");
  const r = await ctx.draft<any>({ platform: P, op: "chat.spaces.messages.list", summary: "read staff questions in Chat",
    input: { params: { parent: space, pageSize: 25, orderBy: "createTime desc" } } });
  return (r.data?.messages ?? [])
    .filter((m: any) => m?.sender?.type === "HUMAN" && !m.deleteTime && SPACE_MSG.test(String(m.name ?? "")))
    .map((m: any): Omit<Question, "status"> => ({
      id: keyOf(`chat:${m.name}`), source: P, title: oneLine(m.text, 120) || "Chat question", text: clean(m.text, 4000),
      asker: { name: oneLine(m.sender?.displayName, 120) || undefined }, received: String(m.createTime ?? ctx.now.toISOString()),
      thread: { chat_space: space, ...(SPACE_THREAD.test(String(m.thread?.name ?? "")) ? { chat_thread: m.thread.name } : {}) },
    }));
}

async function driveSearch(ctx: Ctx<Settings>, words: string[]): Promise<Source[]> {
  const w = words.map((x) => x.replace(/[^a-z]/g, "")).filter(Boolean).slice(0, 4);
  if (!w.length) return [];
  const folder = ctx.settings.google?.drive_folder_id;
  const parts = [`(${w.map((x) => `fullText contains '${x}'`).join(" or ")})`, "trashed = false"];
  if (folder) { if (!SHEET.test(folder)) throw new Error("google.drive_folder_id is not a Drive id"); parts.push(`'${folder}' in parents`); }
  const r = await ctx.draft<any>({ platform: P, op: "drive.files.list", summary: "search SOPs and policies in Drive",
    input: { params: { q: parts.join(" and "), pageSize: ctx.settings.max_sources ?? 5 } } });
  return (r.data?.files ?? []).filter((f: any) => ID.test(String(f?.id ?? ""))).map((f: any): Source => ({
    platform: P, id: f.id, title: oneLine(f.name, 160), url: `https://drive.google.com/open?id=${f.id}`,
  }));
}

/** A Gmail draft of the reply in the question's thread, and the act that sends that draft on approval. */
async function replyGmail(ctx: Ctx<Settings>, q: Question, text: string): Promise<{ act: Act; draft_id: string }> {
  const to = q.asker.email, threadId = q.thread.gmail_thread;
  if (!to || !EMAIL.test(to)) throw new Error("google-workspace: the question has no sender address to reply to");
  if (!ID.test(threadId ?? "")) throw new Error("google-workspace: the question has no Gmail thread");
  const subject = oneLine(q.title, 160).replace(/^(re:\s*)+/i, "");
  const mid = oneLine(q.thread.message_id, 300);
  const mime = [`To: ${to}`, `Subject: Re: ${subject}`, ...(mid ? [`In-Reply-To: ${mid}`, `References: ${mid}`] : []),
    'Content-Type: text/plain; charset="UTF-8"', "MIME-Version: 1.0", "", clean(text, 8000)].join("\r\n");
  const d = await ctx.draft<any>({ platform: P, op: "gmail.users.drafts.create", summary: `draft reply to ${to}`,
    input: { params: { userId: "me" }, body: { message: { raw: Buffer.from(mime, "utf8").toString("base64url"), threadId } } } });
  const draftId = String(d.data?.id ?? "");
  if (!ID.test(draftId)) throw new Error("google-workspace: the Gmail draft was not created");
  return { draft_id: draftId, act: { platform: P, op: "gmail.users.drafts.send", summary: `send reply to ${to}`,
    input: { params: { userId: "me" }, body: { id: draftId } } } };
}

export const googleWorkspace: Adapter & { logRow(ctx: Ctx<Settings>, q: Question): Promise<void> } = {
  id: P,
  async questions(ctx) {
    const out: Omit<Question, "status">[] = [];
    if (ctx.settings.google) out.push(...(await gmailQuestions(ctx)));
    out.push(...(await chatQuestions(ctx)));
    return out;
  },
  async search(ctx, words) { return driveSearch(ctx, words); },
  async reply(ctx, q, text) {
    if (q.thread.chat_space) {
      if (!SPACE.test(q.thread.chat_space)) throw new Error("google-workspace: bad Chat space");
      return { act: { platform: P, op: "chat.spaces.messages.create", summary: `reply in Chat to ${q.asker.name ?? "staff"}`,
        input: { params: { parent: q.thread.chat_space, messageReplyOption: "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD" },
          body: { text: clean(text, 4000), ...(q.thread.chat_thread ? { thread: { name: q.thread.chat_thread } } : {}) } } } };
    }
    return replyGmail(ctx, q, text);
  },
  /** One row in the question register (a Sheet). Every cell is passed through cell() so nothing becomes a formula. */
  async logRow(ctx, q) {
    const g = ctx.settings.google?.log;
    if (!g) return;
    if (!SHEET.test(g.spreadsheet_id) || !RANGE.test(g.range)) throw new Error("google.log needs a Sheet id and a range such as Questions!A:G");
    const row = [ctx.now.toISOString().slice(0, 10), q.source, q.asker.name ?? q.asker.email ?? "", q.title, clean(q.text, 300),
      q.status, (q.sources ?? []).map((s) => s.title).join("; "), q.reason ?? "", q.reply ? "reply queued" : ""].map((v) => cell(v));
    await ctx.draft({ platform: P, op: "sheets.spreadsheets.values.append", summary: "log a staff question",
      input: { params: { spreadsheetId: g.spreadsheet_id, range: g.range, valueInputOption: "RAW", insertDataOption: "INSERT_ROWS" },
        body: { values: [row] } } });
  },
};
