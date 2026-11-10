// Google Workspace: the enquiry inbox (Gmail), the venue's event calendar, and reply drafts. Reads, calendar holds with no
// guests invited, and drafts reach nobody outside the business. Sending a reply is only ever queued for a person to approve.
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Booking, type Enquiry, type Settings, CALENDAR, EMAIL, EVENT_ID, MSG_ID, RFC_ID, TZ } from "../types.ts";

const P = "google-workspace";
const ME = "me";
const DEFAULT_QUERY = "label:enquiries newer_than:14d";

/** Refuses bad settings before any call: the calendar id and the query go into request paths or search strings. */
export function checkSettings(s: Settings): void {
  if (!TZ.test(s.timezone ?? "")) throw new Error("timezone must be an IANA name, such as Australia/Sydney");
  if (!CALENDAR.test(s.google_workspace?.calendar_id ?? "")) throw new Error("google_workspace.calendar_id must be an email address or primary");
  const q = s.enquiries?.query ?? DEFAULT_QUERY;
  if (q.length > 200 || /[\r\n\0]/.test(q)) throw new Error("enquiries.query must be one line of at most 200 characters");
  const n = s.enquiries?.max_results ?? 25;
  if (!Number.isInteger(n) || n < 1 || n > 50) throw new Error("enquiries.max_results must be a whole number from 1 to 50");
}

const clean = (v: unknown, max: number) => String(v ?? "").replace(/[\r\n\0]/g, " ").trim().slice(0, max);
const header = (headers: any[], name: string) =>
  clean(headers.find((h) => String(h?.name ?? "").toLowerCase() === name.toLowerCase())?.value ?? "", 400);

/** The enquiry emails that match the query, as ids only. */
export async function listMessages(ctx: Ctx<Settings>): Promise<{ id: string; threadId: string }[]> {
  const r = await ctx.draft<any>({ platform: P, op: "gmail.users.messages.list", summary: "list enquiry emails",
    input: { params: { userId: ME, q: ctx.settings.enquiries?.query ?? DEFAULT_QUERY, maxResults: ctx.settings.enquiries?.max_results ?? 25 } } });
  return (r.data?.messages ?? [])
    .filter((m: any) => MSG_ID.test(String(m?.id ?? "")) && MSG_ID.test(String(m?.threadId ?? "")))
    .map((m: any) => ({ id: String(m.id), threadId: String(m.threadId) }));
}

/** Sender, subject and threading headers of one enquiry email. Metadata only: the body is never read. Null when the sender has no address. */
export async function readEnquiry(ctx: Ctx<Settings>, m: { id: string; threadId: string }): Promise<Omit<Enquiry, "id" | "status"> | null> {
  const r = await ctx.draft<any>({ platform: P, op: "gmail.users.messages.get", summary: `read enquiry headers ${m.id}`,
    input: { params: { userId: ME, id: m.id, format: "metadata" } } });
  const h: any[] = r.data?.payload?.headers ?? [];
  const from = header(h, "From");
  const addr = (from.match(/<([^<>]+)>/)?.[1] ?? from).trim();
  if (!EMAIL.test(addr)) return null;
  const rfc = header(h, "Message-ID");
  const ms = Number(r.data?.internalDate);
  return {
    message_id: m.id, thread_id: m.threadId, from: addr,
    subject: clean(header(h, "Subject"), 150) || "(no subject)",
    rfc_message_id: RFC_ID.test(rfc) ? rfc : undefined,
    received: Number.isFinite(ms) ? new Date(ms).toISOString() : ctx.now.toISOString(),
  };
}

/** "free", "busy", or "unknown" when Google does not report the calendar. */
export async function slot(ctx: Ctx<Settings>, b: Booking): Promise<"free" | "busy" | "unknown"> {
  const id = ctx.settings.google_workspace.calendar_id;
  const r = await ctx.draft<any>({ platform: P, op: "calendar.freebusy.query", summary: "calendar check for an enquiry",
    input: { body: { timeMin: b.start, timeMax: b.end, timeZone: ctx.settings.timezone, items: [{ id }] } } });
  const c = r.data?.calendars?.[id];
  if (!c || (c.errors ?? []).length) return "unknown";
  const s = Date.parse(b.start), e = Date.parse(b.end);
  return (c.busy ?? []).some((x: any) => Date.parse(x.start) < e && Date.parse(x.end) > s) ? "busy" : "free";
}

/** A hold on the venue calendar: an opaque event with no guests, so Google sends no invitation. Returns the event id. */
export async function hold(ctx: Ctx<Settings>, e: Enquiry, b: Booking): Promise<string> {
  const tz = ctx.settings.timezone;
  const r = await ctx.draft<any>({ platform: P, op: "calendar.events.insert", summary: `calendar hold for enquiry ${e.id}`,
    input: { params: { calendarId: ctx.settings.google_workspace.calendar_id, sendUpdates: "none" }, body: {
      summary: clean(`HOLD ${b.event || "Event"} (${b.guests})`, 120),
      description: `Held from enquiry email ${e.message_id}. Not an invitation: no guests are added.`,
      start: { dateTime: b.start, timeZone: tz }, end: { dateTime: b.end, timeZone: tz },
      transparency: "opaque",
      extendedProperties: { private: { enquiry: e.id } } } } });
  const id = String(r.data?.id ?? "");
  if (!EVENT_ID.test(id)) throw new Error("google-workspace: the hold came back without an event id");
  return id;
}

/** Plain-language date and times for the reply and the approval summary. */
export function whenLabel(s: Settings, b: Booking): string {
  const day = new Intl.DateTimeFormat("en-AU", { timeZone: s.timezone, weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date(b.start));
  const time = (t: string) => new Intl.DateTimeFormat("en-AU", { timeZone: s.timezone, hour: "numeric", minute: "2-digit" }).format(new Date(t));
  return `${day}, ${time(b.start)} to ${time(b.end)}, ${b.guests} guests`;
}

/** The reply as a raw RFC 2822 message in the enquiry's thread. Nothing from the sender goes into the body. */
function replyRaw(s: Settings, e: Enquiry, b: Booking): string {
  if (!EMAIL.test(e.from)) throw new Error("google-workspace: bad recipient");
  const subj = clean(e.subject, 150);
  const subject = /^re:/i.test(subj) ? subj : `Re: ${subj}`;
  const body = [
    "Hi there,", "",
    `The date you asked about is free: ${whenLabel(s, b)}. We have held that time for you.`, "",
    "Reply to this email if you would like to go ahead, and we will send the details.", "",
    clean(s.signoff ?? s.business_name ?? "", 200),
  ].join("\r\n");
  const head = [
    `To: ${e.from}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`,
    ...(e.rfc_message_id ? [`In-Reply-To: ${e.rfc_message_id}`, `References: ${e.rfc_message_id}`] : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
  ];
  return Buffer.from(`${head.join("\r\n")}\r\n\r\n${body}\r\n`, "utf8").toString("base64url");
}

/** Creates the reply as a Gmail draft in the enquiry's thread. Returns the draft id. */
export async function draftReply(ctx: Ctx<Settings>, e: Enquiry, b: Booking): Promise<string> {
  const r = await ctx.draft<any>({ platform: P, op: "gmail.users.drafts.create", summary: `reply draft for enquiry ${e.id}`,
    input: { params: { userId: ME }, body: { message: { threadId: e.thread_id, raw: replyRaw(ctx.settings, e, b) } } } });
  const id = String(r.data?.id ?? "");
  if (!MSG_ID.test(id)) throw new Error("google-workspace: the reply draft came back without an id");
  return id;
}

/** The send of a reply draft, for a person to approve. Keyed on the enquiry, so it is queued once. */
export function sendAct(e: Enquiry, draftId: string): Act {
  return { platform: P, op: "gmail.users.drafts.send", key: `reply:${e.id}`, summary: `send the reply to ${e.from}`,
    input: { params: { userId: ME }, body: { id: draftId } } };
}
