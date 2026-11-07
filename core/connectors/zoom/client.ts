// Zoom helper: cloud recordings, transcripts, and who attended a call.
// Keys: ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET, from a Server-to-Server OAuth app with
// recording read scope. Nothing here records, starts or changes a meeting.
//
// Source of each function, from the CAO CRM at commit 28aa5d91 unless marked NEW:
//   accessToken        lib/zoom-pmr.ts (account credentials grant)
//   personalMeetingUrl lib/zoom-pmr.ts getRepPersonalMeetingUrl (users/{email}, personal_meeting_url or pmi, cached)
//   listRecordings     the CRM's Zoom call scorer script (users/{user}/recordings, next_page_token)
//   meetingRecording   scripts/cao-crm-zoom-attendance.ts timelineFor (meetings/{uuid}/recordings, same-call check)
//   download           scripts/cao-crm-zoom-attendance.ts (key in a header, Zoom hosts only, read whole). The
//                      scorer's 10 MB Range cap is an option for audio. The older scorer put the key in the URL; refused here.
//   getTimeline, attendance, tsSeconds, encodeUuid   scripts/lib-zoom-attendance.ts
//   getTranscript      the CRM's Zoom call scorer script (the TRANSCRIPT file)
//   vttToText          NEW: written from the WebVTT format, not yet run in production
// The CRM's own domain and rep names are now parameters.

import { call, type AppSpec } from "../../lib/http.ts";
import { secret } from "../../lib/secrets.ts";
import { collect } from "../../lib/paging.ts";

export const spec: AppSpec = { app: "zoom", hosts: ["zoom.us", "api.zoom.us"], hostPattern: /^([a-z0-9-]+\.)+zoom\.us$/, readPosts: ["zoom.us/oauth/token"] };
const API = "https://api.zoom.us/v2";
let cached: { token: string; until: number } | null = null;

export async function accessToken(): Promise<string> {
  if (cached && cached.until > Date.now() + 60_000) return cached.token;
  const basic = Buffer.from(`${secret("ZOOM_CLIENT_ID")}:${secret("ZOOM_CLIENT_SECRET")}`).toString("base64");
  // The account id goes in the query, as Zoom's docs and the CRM do. It names the account; it is not a key.
  const r = await call<any>(spec, { method: "POST", url: "https://zoom.us/oauth/token", headers: { Authorization: `Basic ${basic}` }, query: { grant_type: "account_credentials", account_id: secret("ZOOM_ACCOUNT_ID") }, retries: 1 });
  if (!r.data?.access_token) throw new Error("Zoom login failed. Check the Server-to-Server app is activated.");
  cached = { token: r.data.access_token, until: Date.now() + (r.data.expires_in ?? 3600) * 1000 };
  return cached.token;
}
export function clearTokenCache(): void { cached = null; }
const auth = async () => ({ Authorization: `Bearer ${await accessToken()}` });

const pmrCache = new Map<string, { url: string; at: number }>();

/**
 * A person's personal meeting room link, with its passcode, for booking a call into. Cached for an
 * hour. Throws if the person has no Zoom user or no personal room. Ported from lib/zoom-pmr.ts.
 */
export async function personalMeetingUrl(email: string): Promise<string> {
  const key = email.toLowerCase();
  const hit = pmrCache.get(key);
  if (hit && Date.now() - hit.at < 3_600_000) return hit.url;
  const r = await call<any>(spec, { url: `${API}/users/${encodeURIComponent(key)}`, headers: await auth() });
  const url = r.data?.personal_meeting_url || (r.data?.pmi ? `https://zoom.us/j/${r.data.pmi}` : "");
  if (!url) throw new Error(`zoom: no personal meeting room for ${key}`);
  pmrCache.set(key, { url, at: Date.now() });
  return url;
}

/** Zoom wants a meeting UUID double encoded when it starts with "/" or holds "//". */
export function encodeUuid(uuid: string): string {
  const once = encodeURIComponent(uuid);
  return uuid.startsWith("/") || uuid.includes("//") ? encodeURIComponent(once) : once;
}

export interface RecordingFile { id?: string; file_type: string; recording_type?: string; download_url: string; file_size?: number }
export interface Recording { uuid: string; id: number; topic: string; start_time: string; duration: number; host_email?: string; recording_files: RecordingFile[] }

/** Cloud recordings for one user between two dates (YYYY-MM-DD). */
export async function listRecordings(user: string, from: string, to: string): Promise<Recording[]> {
  const h = await auth();
  return collect<Recording, string>("", async (next) => {
    let r;
    try { r = await call<any>(spec, { url: `${API}/users/${encodeURIComponent(user)}/recordings`, headers: h, query: { from, to, page_size: 100, next_page_token: next || undefined } }); }
    catch (e: any) { if (e?.status === 404) return { items: [], next: null }; throw e; } // no such user or no recordings, as production treats it
    return { items: r.data?.meetings ?? [], next: r.data?.next_page_token || null };
  }, { maxPages: 50 });
}

/**
 * The recording of one call. A reused meeting room returns its latest meeting, which may be a
 * different call the same day, so the recording must start within 30 minutes of the call.
 */
export async function meetingRecording(meetingId: string, calledAt: string, sameCallMs = 30 * 60_000): Promise<Recording | null> {
  try {
    const r = await call<Recording>(spec, { url: `${API}/meetings/${encodeUuid(meetingId)}/recordings`, headers: await auth() });
    const gap = Math.abs(Date.parse(r.data.start_time ?? "") - Date.parse(calledAt));
    return Number.isFinite(gap) && gap <= sameCallMs ? r.data : null;
  } catch (e: any) {
    if (e?.status === 404) return null;
    throw e;
  }
}

/**
 * Downloads a recording file whole. The key goes in a header, and only to a Zoom host.
 * Pass maxBytes only for audio or video, where the first part is enough (the CRM's scorers read
 * 10 MB); timelines and transcripts are always read in full.
 */
export async function download(file: RecordingFile, maxBytes?: number): Promise<Buffer> {
  const headers: Record<string, string> = { ...(await auth()), ...(maxBytes ? { Range: `bytes=0-${maxBytes - 1}` } : {}) };
  const r = await call<ArrayBuffer>(spec, { url: file.download_url, headers, binary: true, followDownloadRedirects: true });
  return Buffer.from(r.data);
}

const findFile = (rec: Recording, type: string) => rec.recording_files.find((f) => f.file_type === type || f.recording_type?.toLowerCase() === type.toLowerCase());

export async function getTranscript(rec: Recording): Promise<string | null> {
  const f = findFile(rec, "TRANSCRIPT");
  return f ? (await download(f)).toString("utf8") : null;
}

export type Timeline = { timeline?: { ts?: string; users?: { username?: string; email_address?: string }[] }[] };

/** The TIMELINE file: who was on screen at each moment. Comes with the recording at no extra scope. */
export async function getTimeline(rec: Recording): Promise<Timeline | null> {
  const f = findFile(rec, "TIMELINE");
  return f ? (JSON.parse((await download(f)).toString("utf8")) as Timeline) : null;
}

/** "01:02:03.500" to seconds. */
export function tsSeconds(ts?: string): number | null {
  const m = /^(\d+):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(ts ?? "");
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + (m[4] ? Number(`0.${m[4]}`) : 0);
}

const BOT = /^(fireflies(\.ai)?|otter(\.ai)?|read\.ai|fathom)(\s+(notetaker|note taker|bot|meeting notes|assistant))?$|\bnote ?taker\b/i;

/**
 * Did the guest join, and for how long? A guest is anyone who is not on the business's own email
 * domain, not the host by name or by device ("Sam's iPhone"), and not a notetaker bot. A guest who
 * only shares the host's first name still counts. Null when the host's name is unknown, because the
 * host cannot then be told from the guest.
 */
export function attendance(data: Timeline, o: { hostName: string | null; internalDomain: string }): { guestJoined: boolean; guestMinutes: number; guests: string[] } | null {
  const norm = (v: string) => v.replace(/[’‘]/g, "'").toLowerCase();
  const host = norm((o.hostName ?? "").replace(/\(.*?\)/g, " ")).replace(/\s+/g, " ").trim();
  if (!host) return null;
  const domain = `@${o.internalDomain.replace(/^@/, "").toLowerCase()}`;
  const first = host.split(/\s+/)[0] ?? "";
  const span = new Map<string, { first: number; last: number }>();
  for (const entry of data.timeline ?? []) {
    const t = tsSeconds(entry.ts);
    if (t == null) continue;
    for (const u of entry.users ?? []) {
      const name = (u.username ?? "").trim();
      const email = (u.email_address ?? "").trim().toLowerCase();
      if (!name || email.endsWith(domain) || BOT.test(name)) continue;
      const lower = norm(name).replace(/\s+/g, " ");
      const isHost = (` ${lower} `).includes(` ${host} `) || lower.startsWith(`${host}'s `) || (first.length >= 3 && (lower === first || lower.startsWith(`${first}'s `)));
      if (isHost) continue;
      const s = span.get(name);
      if (s) s.last = Math.max(s.last, t); else span.set(name, { first: t, last: t });
    }
  }
  const longest = Array.from(span.values()).reduce((m, s) => Math.max(m, s.last - s.first), 0);
  return { guestJoined: span.size > 0, guestMinutes: Math.round((longest / 60) * 10) / 10, guests: Array.from(span.keys()) };
}

/** NEW: "Name: line" text from a WebVTT transcript. Not yet run in production. */
export function vttToText(vtt: string): string {
  return vtt.split(/\r?\n/).filter((l) => l && l !== "WEBVTT" && !/^\d+$/.test(l) && !/-->/.test(l)).join("\n");
}
