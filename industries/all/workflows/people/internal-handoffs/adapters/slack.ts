// Slack: requests arrive as messages in the handover channel, and the daily status goes back there. A direct message
// to the person a handover goes to notifies them, so it is queued with the handover. Opening that direct message
// reaches only the people in it, so it is a draft step.
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Handover, type Settings, PERSON_ID, SLACK_ID, TS, clip, keyOf, slackText } from "../types.ts";

const P = "slack";

const channelOf = (ctx: Ctx<Settings>): string => {
  const c = ctx.settings.slack?.channel ?? "";
  if (!SLACK_ID.test(c)) throw new Error("slack: slack.channel is not set or is not a channel id");
  return c;
};

export const slack = {
  id: P,
  /** New messages in the handover channel after the saved cursor. The bot's own posts and system messages are skipped. */
  async requests(ctx: Ctx<Settings>, oldest?: string): Promise<{ rows: Omit<Handover, "status" | "chased">[]; newest?: string }> {
    const channel = channelOf(ctx);
    if (oldest !== undefined && !TS.test(oldest)) throw new Error("slack: saved cursor is not a timestamp");
    const r = await ctx.draft<any>({ platform: P, op: "conversations_history", summary: "read new messages in the handover channel",
      input: { params: { channel, limit: 100, ...(oldest ? { oldest } : {}) } } });
    if (r.data?.ok !== true) throw new Error(`slack: ${clip(r.data?.error ?? "read failed", 80)}`);
    const msgs: any[] = Array.isArray(r.data.messages) ? r.data.messages : [];
    let newest: string | undefined;
    const rows: Omit<Handover, "status" | "chased">[] = [];
    for (const m of msgs) {
      if (!m || typeof m.ts !== "string" || !TS.test(m.ts)) continue;
      if (!newest || Number(m.ts) > Number(newest)) newest = m.ts;
      if (m.bot_id || m.subtype || m.type !== "message" || typeof m.text !== "string" || !m.text.trim()) continue;
      rows.push({ id: keyOf(`slack:${channel}:${m.ts}`), platform: P, title: clip(m.text.split("\n")[0], 200), text: clip(m.text, 6000),
        received: new Date(Number(m.ts) * 1000).toISOString(), ref: { channel, ts: m.ts } });
    }
    return { rows, newest };
  },

  /** Open (or find) the direct message with one person. Reaches only that person and the bot: a draft step. */
  async dm(ctx: Ctx<Settings>, user: string): Promise<string> {
    if (!PERSON_ID.test(user)) throw new Error("slack: the person id is not a Slack person id");
    const r = await ctx.draft<any>({ platform: P, op: "conversations_open", summary: `open a direct message with ${user}`,
      input: { body: { users: user } } });
    const id = String(r.data?.channel?.id ?? "");
    if (r.data?.ok !== true || !SLACK_ID.test(id)) throw new Error(`slack: ${clip(r.data?.error ?? "no direct message", 80)}`);
    return id;
  },

  /** A message to a channel or a direct message. It notifies people, so it is only ever queued. Text is escaped and link parsing is off. */
  postAct(channel: string, text: string, summary: string, key?: string): Act {
    if (!SLACK_ID.test(channel)) throw new Error("slack: the channel is not a Slack channel id");
    return { platform: P, op: "chat_postMessage", summary, ...(key ? { key } : {}),
      input: { body: { channel, text: slackText(clip(text, 3000)), parse: "none" } } };
  },
};
