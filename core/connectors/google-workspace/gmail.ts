// Gmail helper: search, read, and create drafts. There is deliberately no send function. A person
// reads the draft and presses send, which is how the reference CRM runs its mail.
//
// Source of each function, from the reference CRM at commit 28aa5d91 unless marked NEW:
//   search, getMessage, parseFrom   lib/google-gmail.ts gmailSearch, gmailGetMessage, parseFrom.
//                      Changed on purpose: search reads every page up to the limit; the CRM reads one page.
//   bodyText, afterClause   scripts/lib-google-dwd.ts
//   rawMessage, createDraft scripts/crm-email-drafter.ts buildMimeEmail and the drafts call, with its
//                      header-injection guard. Plain text here where the CRM sends HTML.
//   reply threading (threadId, In-Reply-To)   NEW: from Gmail's API docs, not yet run in production

import { call } from "../../lib/http.ts";
import { collect } from "../../lib/paging.ts";
import { authHeaders, SCOPES, spec } from "./auth.ts";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

export interface Mail {
  id: string; threadId: string; messageId: string; from: string; fromEmail: string; fromName: string; to: string; subject: string;
  date: string; internalDate: string | null; text: string; labels: string[];
}

/** "Jo Smith <jo@x.com>" to its address and name, as the CRM's parseFrom does. */
export function parseFrom(from: string): { email: string; name: string } {
  const m = from.match(/<([^>]+)>/);
  return { email: (m ? m[1] : from).trim().toLowerCase(), name: m ? from.replace(/<[^>]+>/, "").replace(/"/g, "").trim() : "" };
}

interface Part { mimeType?: string; body?: { data?: string }; parts?: Part[]; headers?: { name: string; value: string }[] }

const decode = (d: string): string => Buffer.from(d.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

/** text/plain first; an html-only message is reduced to its text. */
export function bodyText(payload?: Part): string {
  if (!payload) return "";
  const find = (p: Part, mime: string): string | null => {
    if (p.mimeType === mime && p.body?.data) return decode(p.body.data);
    for (const c of p.parts ?? []) { const hit = find(c, mime); if (hit) return hit; }
    return null;
  };
  const plain = find(payload, "text/plain");
  if (plain) return plain;
  const html = find(payload, "text/html") ?? "";
  return html.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"');
}

/** Message ids matching a Gmail search such as `from:a@b.com after:2026/11/01`. */
export async function search(mailbox: string, q: string, limit = 200): Promise<{ id: string; threadId: string }[]> {
  const h = await authHeaders(mailbox, SCOPES.gmailRead);
  return collect<{ id: string; threadId: string }, string>("", async (pageToken) => {
    const r = await call<any>(spec, { url: `${API}/messages`, headers: h, query: { q, maxResults: Math.min(limit, 100), pageToken: pageToken || undefined } });
    return { items: r.data?.messages ?? [], next: r.data?.nextPageToken ?? null };
  }, { limit, maxPages: 50 });
}

export async function getMessage(mailbox: string, id: string): Promise<Mail> {
  const h = await authHeaders(mailbox, SCOPES.gmailRead);
  const m = (await call<any>(spec, { url: `${API}/messages/${encodeURIComponent(id)}`, headers: h, query: { format: "full" } })).data;
  const head = (n: string) => (m.payload?.headers ?? []).find((x: any) => x.name.toLowerCase() === n.toLowerCase())?.value ?? "";
  const sender = parseFrom(head("From"));
  return {
    id: m.id, threadId: m.threadId, messageId: head("Message-ID"), from: head("From"), fromEmail: sender.email, fromName: sender.name, to: head("To"), subject: head("Subject"),
    date: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : head("Date"), internalDate: m.internalDate ?? null, text: bodyText(m.payload), labels: m.labelIds ?? [],
  };
}

/** Gmail's after: is day-granular, so ask from the day before and filter on the date afterwards. */
export function afterClause(since: Date): string {
  const a = new Date(since.getTime() - 86_400_000);
  return `after:${a.getUTCFullYear()}/${a.getUTCMonth() + 1}/${a.getUTCDate()}`;
}

// A line break in a header value would start a new header, such as a hidden Bcc, so values are
// folded to one line and every address must be one plain address (CRM review C13, 26 Oct 2026).
const header = (s: string) => s.replace(/[\r\n]+/g, " ").trim();
const PLAIN = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;
function plainList(v: string): string {
  const list = v.split(",").map((x) => x.trim()).filter(Boolean);
  if (!list.length || !list.every((x) => PLAIN.test(x))) throw new Error("each recipient must be one plain email address");
  return list.join(", ");
}

/** Builds the raw message for a draft. A reply keeps the thread and its references. */
export function rawMessage(d: { from: string; to: string; subject: string; text: string; cc?: string; inReplyTo?: string; fromName?: string; toName?: string }): string {
  const named = (name: string | undefined, addr: string) => (name ? `${header(name).replace(/["<>]/g, "")} <${addr}>` : addr);
  const lines = [
    `From: ${named(d.fromName, plainList(d.from))}`, `To: ${d.toName && !d.to.includes(",") ? named(d.toName, plainList(d.to)) : plainList(d.to)}`, ...(d.cc ? [`Cc: ${plainList(d.cc)}`] : []),
    `Subject: ${header(d.subject)}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8",
    ...(d.inReplyTo ? [`In-Reply-To: ${header(d.inReplyTo)}`, `References: ${header(d.inReplyTo)}`] : []),
    "", d.text,
  ];
  return Buffer.from(lines.join("\r\n")).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Creates a draft in the mailbox. Needs KIT_ALLOW_WRITES=1. Never sends. */
export async function createDraft(mailbox: string, d: { to: string; subject: string; text: string; cc?: string; threadId?: string; inReplyTo?: string; fromName?: string; toName?: string }): Promise<{ id: string; threadId: string }> {
  const h = await authHeaders(mailbox, SCOPES.gmailDraft);
  const raw = rawMessage({ from: mailbox, ...d });
  const r = await call<any>(spec, { method: "POST", url: `${API}/drafts`, headers: h, json: { message: { raw, ...(d.threadId ? { threadId: d.threadId } : {}) } } });
  return { id: r.data.id, threadId: r.data.message?.threadId };
}
