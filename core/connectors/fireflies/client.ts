// Fireflies helper: list and read meeting transcripts.
//
// Source, from the reference CRM at commit 28aa5d91 unless marked NEW:
//   listTranscripts    lib/fireflies.ts fetchRecentTranscripts (50 a page, skip paging, no sentence text)
//   getTranscript, transcriptText   NEW: from Fireflies' GraphQL docs, not yet run in production
// Key: FIREFLIES_API_KEY. Fireflies answers everything on one GraphQL endpoint by POST, so the gate
// treats that path as a read, and this file refuses anything but a plain query: no mutation can
// leave through it.

import { call, type AppSpec } from "../../lib/http.ts";
import { secret } from "../../lib/secrets.ts";
import { collect } from "../../lib/paging.ts";

export const spec: AppSpec = { app: "fireflies", hosts: ["api.fireflies.ai"], readPosts: ["api.fireflies.ai/graphql"] };
const ENDPOINT = "https://api.fireflies.ai/graphql";
const PAGE = 50; // Fireflies caps a page at 50

export async function query<T>(gql: string, variables: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
  if (!/^\s*(query\b|\{)/.test(gql) || /\bmutation\b/i.test(gql)) throw new Error("fireflies: only read queries are allowed");
  const r = await call<any>(spec, { method: "POST", url: ENDPOINT, headers: { Authorization: `Bearer ${secret("FIREFLIES_API_KEY")}` }, json: { query: gql, variables }, signal });
  if (r.data?.errors?.length) throw new Error(`fireflies: ${r.data.errors[0]?.message ?? "query failed"}`);
  return r.data?.data as T;
}

export interface TranscriptSummary { id: string; title: string | null; date: number | null; duration: number | null; organizer: string | null; attendees: { name: string | null; email: string | null }[]; sentenceCount: number }

/** Every transcript the account can see, newest first, with no sentence text. sentenceCount tells a real conversation from an empty recording, as the CRM uses it. */
export async function listTranscripts(opts: { fromDate?: string; limit?: number; signal?: AbortSignal; deadline?: number } = {}): Promise<TranscriptSummary[]> {
  // signal and deadline stop the page walk early, as the CRM's caller time caps do. What was read so far is returned.
  const out: TranscriptSummary[] = [];
  try {
    await collect<TranscriptSummary, number>(0, async (skip) => {
      if (opts.signal?.aborted || (opts.deadline && Date.now() > opts.deadline)) return { items: [], next: null };
    const d = await query<any>(`query List($limit: Int, $skip: Int, $fromDate: DateTime) {
      transcripts(limit: $limit, skip: $skip, fromDate: $fromDate) { id title date duration organizer_email meeting_attendees { displayName email } sentences { index } }
    }`, { limit: PAGE, skip, fromDate: opts.fromDate }, opts.signal);
    const rows = d?.transcripts ?? [];
    return {
      items: rows.map((t: any) => ({ id: t.id, title: t.title ?? null, date: t.date ?? null, duration: t.duration ?? null, organizer: t.organizer_email ?? null, attendees: (t.meeting_attendees ?? []).map((a: any) => ({ name: a.displayName ?? null, email: a.email ?? null })), sentenceCount: Array.isArray(t.sentences) ? t.sentences.length : 0 })),
      next: rows.length < PAGE ? null : skip + PAGE,
    };
    }, { maxPages: 2000, limit: opts.limit }).then((all) => out.push(...all));
  } catch (e) { if (!opts.signal?.aborted) throw e; }
  return opts.limit ? out.slice(0, opts.limit) : out;
}

export interface Transcript extends TranscriptSummary { sentences: { speaker: string; text: string; start: number }[]; summary: { overview: string | null; action_items: string | null } }

export async function getTranscript(id: string): Promise<Transcript | null> {
  const d = await query<any>(`query One($id: String!) {
    transcript(id: $id) { id title date duration organizer_email meeting_attendees { displayName email }
      sentences { speaker_name text start_time } summary { overview action_items } }
  }`, { id });
  const t = d?.transcript;
  if (!t) return null;
  return {
    id: t.id, title: t.title ?? null, date: t.date ?? null, duration: t.duration ?? null, organizer: t.organizer_email ?? null,
    attendees: (t.meeting_attendees ?? []).map((a: any) => ({ name: a.displayName ?? null, email: a.email ?? null })),
    sentences: (t.sentences ?? []).map((s: any) => ({ speaker: s.speaker_name ?? "", text: s.text ?? "", start: s.start_time ?? 0 })), sentenceCount: (t.sentences ?? []).length,
    summary: { overview: t.summary?.overview ?? null, action_items: t.summary?.action_items ?? null },
  };
}

export const transcriptText = (t: Transcript): string => t.sentences.map((s) => `${s.speaker}: ${s.text}`).join("\n");
