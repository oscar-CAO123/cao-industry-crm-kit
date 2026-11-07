// Aircall helper: calls, transcripts, users, numbers, contacts and SMS.
// Keys: AIRCALL_API_ID and AIRCALL_API_TOKEN (basic auth). Aircall allows about 60 requests a
// minute, so a 429 waits 15s, then 30s, as the CRM's reconciler does.
// Aircall has no message-history endpoint (every /messages read 404s, even on Pro), so a workflow
// that needs past texts keeps its own copy as they are sent or received.
//
// Source of each function, from the CAO CRM at commit 28aa5d91 unless marked NEW:
//   listCalls          the CRM's Aircall call scorer script (follows meta.next_page_link)
//   getCall            scripts/cao-crm-aircall-reconciler.ts
//   searchCalls        lib/aircall-comms.ts fetchAircallCalls
//   getTranscript      lib/aircall-comms.ts fetchAircallTranscript
//   listContacts       scripts/cao-crm-aircall-contact-sync.ts getExistingContacts (pages by meta.total)
//   createContact      scripts/cao-crm-aircall-contact-sync.ts createContact
//   sendSms            lib/aircall-sms-send.ts sendSms
//   listUsers, listNumbers   NEW: written from Aircall's API docs, not yet run in production

import { call, checkUrl, type AppSpec } from "../../lib/http.ts";
import { secret } from "../../lib/secrets.ts";
import { collect } from "../../lib/paging.ts";

export const spec: AppSpec = { app: "aircall", hosts: ["api.aircall.io"], retryBaseMs: 15_000 };
const API = "https://api.aircall.io/v1";

const auth = () => ({ Authorization: `Basic ${Buffer.from(`${secret("AIRCALL_API_ID")}:${secret("AIRCALL_API_TOKEN")}`).toString("base64")}` });

export const normalisePhone = (p: string): string => p.replace(/[\s\-().]/g, "");

export interface Call {
  id: number; direction: "inbound" | "outbound"; status: string; started_at: number; answered_at: number | null; ended_at: number | null;
  duration: number; raw_digits: string; missed_call_reason: string | null; recording: string | null; voicemail: string | null;
  user: { id: number; name: string; email: string } | null; number: { id: number; digits: string } | null; tags: { name: string }[];
}

/**
 * Calls between two times (unix seconds), oldest first, every page.
 * settleMinutes holds back inbound calls that ended less than that long ago: Aircall can attribute an inbound call to
 * the wrong person for a while and its transcript is not ready yet. The CRM's scorers use 25.
 */
export async function listCalls(from: number, to: number, opts: { settleMinutes?: number; now?: number } = {}): Promise<Call[]> {
  const h = auth();
  const first = `${API}/calls?from=${from}&to=${to}&per_page=50&order=asc`;
  return collect<Call, string>(first, async (url) => {
    const r = await call<any>(spec, { url, headers: h, retries: 5 });
    const next: string | null = r.data?.meta?.next_page_link ?? null;
    if (next) checkUrl(spec, new URL(next));
    return { items: r.data?.calls ?? [], next };
  }, { maxPages: 400 }).then((calls) => {
    if (!opts.settleMinutes) return calls;
    const cutoff = Math.floor((opts.now ?? Date.now()) / 1000) - opts.settleMinutes * 60;
    return calls.filter((c) => c.direction !== "inbound" || (c.ended_at ?? c.started_at ?? 0) <= cutoff); // from when the call ended, as the CRM does
  });
}

export async function getCall(id: number | string): Promise<Call> {
  const r = await call<any>(spec, { url: `${API}/calls/${encodeURIComponent(String(id))}`, headers: auth(), retries: 5 });
  return r.data?.call;
}

/** Link to the call's page in the Aircall web app, where the recording and transcript sit. */
export const callUrl = (id: number | string): string => `https://phone.aircall.io/calls/${id}`;

/** The last nine digits, so +61 412 345 678 and 0412 345 678 match. */
export const last9 = (p: string): string => normalisePhone(p).replace(/^\+/, "").slice(-9);

/**
 * Calls with one number, newest first. Aircall's search can return near misses, so only calls whose
 * number matches on the last nine digits are kept, as the CRM does. Use /calls/search: plain /calls
 * ignores the phone filter.
 */
export async function searchCalls(phone: string): Promise<(Call & { transcriptUrl: string })[]> {
  const r = await call<any>(spec, { url: `${API}/calls/search`, headers: auth(), query: { phone_number: normalisePhone(phone), per_page: 50 } });
  const want = last9(phone);
  return (r.data?.calls ?? [])
    .filter((c: Call) => last9(c.raw_digits ?? "") === want)
    .sort((a: Call, b: Call) => b.started_at - a.started_at)
    .map((c: Call) => ({ ...c, transcriptUrl: callUrl(c.id) }));
}

export interface Utterance { speaker: "internal" | "external"; text: string }

/** One call's transcript, or null when the call has none (Aircall answers 404). */
export async function getTranscript(callId: number | string): Promise<Utterance[] | null> {
  try {
    const r = await call<any>(spec, { url: `${API}/calls/${encodeURIComponent(String(callId))}/transcription`, headers: auth() });
    const u = r.data?.transcription?.content?.utterances;
    if (!Array.isArray(u) || u.length === 0) return null;
    return u.map((x: any) => ({ speaker: x.participant_type === "internal" ? "internal" : "external", text: String(x.text ?? "").trim() }));
  } catch (e: any) {
    if (e?.status === 404) return null;
    throw e;
  }
}

/** "Rep: ..." and "Caller: ..." lines, as the CRM builds them. */
export const transcriptText = (u: Utterance[]): string =>
  u.map((x) => `${x.speaker === "internal" ? "Rep" : "Caller"}: ${x.text}`).filter((l) => l.length > 6).join("\n");

export interface Contact { id: number; first_name: string; last_name: string; company_name: string; information: string; phone_numbers: { label: string; value: string }[]; emails: { label: string; value: string }[] }

/** Every contact, newest first. Stops when the pages read cover meta.total. */
export async function listContacts(): Promise<Contact[]> {
  const h = auth();
  return collect<Contact, number>(1, async (page) => {
    const r = await call<any>(spec, { url: `${API}/contacts`, headers: h, query: { per_page: 50, page, order: "desc" }, retries: 5 });
    const items: Contact[] = r.data?.contacts ?? [];
    const total = r.data?.meta?.total ?? 0;
    return { items, next: items.length === 0 || page * 50 >= total ? null : page + 1 };
  }, { maxPages: 2000 });
}

/** Normalised phone to contact id, for dedupe before creating. */
export function phoneIndex(contacts: Contact[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of contacts) for (const p of c.phone_numbers ?? []) { const v = normalisePhone(p.value); if (v && !m.has(v)) m.set(v, c.id); }
  return m;
}

/** Creates one contact. Needs KIT_ALLOW_WRITES=1. Dedupe with phoneIndex first: Aircall does not. */
export async function createContact(c: { name: string; company?: string; email?: string; phone: string }): Promise<number | null> {
  const parts = c.name.trim().split(/\s+/).filter(Boolean);
  const r = await call<any>(spec, {
    method: "POST", url: `${API}/contacts`, headers: auth(),
    json: { first_name: parts[0] ?? "", last_name: parts.slice(1).join(" "), company_name: c.company ?? "", information: c.email ?? "", phone_numbers: [{ label: "work", value: c.phone }] },
  });
  return r.data?.contact?.id ?? null;
}

/** Sends one SMS from an Aircall number. Needs KIT_ALLOW_WRITES=1. "native" sends as an agent. */
export async function sendSms(o: { numberId: number; to: string; body: string; mode?: "native" | "public_api"; agentId?: number; signal?: AbortSignal }): Promise<{ id: string }> {
  const endpoint = o.mode === "native" ? "messages/native/send" : "messages/send";
  const r = await call<any>(spec, {
    method: "POST", url: `${API}/numbers/${o.numberId}/${endpoint}`, headers: auth(), signal: o.signal,
    json: { to: o.to, body: o.body, ...(o.mode === "native" && o.agentId ? { agentId: o.agentId } : {}) },
  });
  const id = r.data?.id ?? r.data?.message?.id;
  if (id === undefined || id === null || id === "") throw new Error("aircall: the SMS was accepted but no message id came back; check it was sent before retrying");
  return { id: String(id) };
}

/** NEW: from Aircall's API docs, not yet run in production. */
export async function listUsers(): Promise<{ id: number; name: string; email: string; available: boolean }[]> {
  const h = auth();
  return collect<any, number>(1, async (page) => {
    const r = await call<any>(spec, { url: `${API}/users`, headers: h, query: { per_page: 50, page } });
    return { items: r.data?.users ?? [], next: r.data?.meta?.next_page_link ? page + 1 : null };
  }, { maxPages: 100 });
}

/** NEW: from Aircall's API docs, not yet run in production. */
export async function listNumbers(): Promise<{ id: number; name: string; digits: string }[]> {
  const h = auth();
  return collect<any, number>(1, async (page) => {
    const r = await call<any>(spec, { url: `${API}/numbers`, headers: h, query: { per_page: 50, page } });
    return { items: r.data?.numbers ?? [], next: r.data?.meta?.next_page_link ? page + 1 : null };
  }, { maxPages: 100 });
}

/** The kit's activity record for a call. */
export function toActivity(c: Call) {
  return {
    id: `aircall:${c.id}`, kind: c.direction === "inbound" ? (c.answered_at ? "call_in" : "call_missed") : "call_out",
    at: new Date(c.started_at * 1000).toISOString(), phone: c.raw_digits, user: c.user?.email ?? null, seconds: c.duration,
  };
}
