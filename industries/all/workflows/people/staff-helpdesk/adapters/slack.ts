// Slack: questions from one channel, SOP files found by search, replies posted in the question's thread on approval.
// The channel id and thread timestamp are checked before they go into a request.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Adapter, type Settings, type Source, clean, keyOf, oneLine } from "../types.ts";

const P = "slack" as const;
const CH = /^[CGD][A-Z0-9]{6,20}$/;
const TS = /^\d{1,12}\.\d{1,8}$/;
/** Slack reads &, < and > as markup, so they are escaped and no mention or link can be forged. */
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const slack: Adapter = {
  id: P,
  async questions(ctx: Ctx<Settings>) {
    const ch = ctx.settings.slack?.channel;
    if (!ch) return [];
    if (!CH.test(ch)) throw new Error("slack.channel is not a Slack channel id");
    const r = await ctx.draft<any>({ platform: P, op: "conversations_history", summary: "read staff questions in Slack",
      input: { params: { channel: ch, limit: 25 } } });
    return (r.data?.messages ?? [])
      .filter((m: any) => !m?.subtype && !m?.bot_id && TS.test(String(m?.ts ?? "")))
      .map((m: any) => ({
        id: keyOf(`slack:${ch}:${m.ts}`), source: P, title: oneLine(m.text, 120) || "Slack question", text: clean(m.text, 4000),
        asker: {}, received: new Date(Number(m.ts) * 1000).toISOString(), thread: { slack_channel: ch, slack_ts: m.ts },
      }));
  },
  async search(ctx, words) {
    const w = words.map((x) => x.replace(/[^a-z]/g, "")).filter(Boolean).slice(0, 4);
    if (!w.length) return [];
    const r = await ctx.draft<any>({ platform: P, op: "search_files", summary: "search Slack files for SOPs and policies",
      input: { params: { query: w.join(" OR "), count: ctx.settings.max_sources ?? 5 } } });
    const matches: any[] = r.data?.files?.matches ?? [];
    return matches.filter((f) => typeof f?.id === "string").map((f): Source => ({
      platform: P, id: f.id, title: oneLine(f.name ?? f.title, 160),
      url: typeof f.permalink === "string" && f.permalink.startsWith("https://") ? f.permalink : undefined,
    }));
  },
  async reply(ctx, q, text) {
    const ch = q.thread.slack_channel, ts = q.thread.slack_ts;
    if (!CH.test(ch ?? "") || !TS.test(ts ?? "")) throw new Error("slack: the question has no channel thread to reply in");
    return { act: { platform: P, op: "chat_postMessage", summary: `reply in Slack thread to ${q.asker.name ?? "staff"}`,
      input: { body: { channel: ch, thread_ts: ts, text: esc(clean(text, 3000)) } } } };
  },
};
