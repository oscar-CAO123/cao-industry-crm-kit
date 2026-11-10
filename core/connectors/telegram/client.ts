// Telegram helper: send a message to a chat, for owner reports and alerts.
// Key: TELEGRAM_BOT_TOKEN. Telegram puts the key in the URL path, so logs redact the path.
//
// Source, from the reference CRM at commit 28aa5d91:
//   sendMessage        scripts/lib-alerts.ts and scripts/lib-telegram.ts (sendMessage, plain text).
//                      Changed on purpose: the CRM cuts text at 3,900 characters; the kit splits it so nothing is lost.
//                      Link previews are off through link_preview_options, the field Telegram documents now.
//   chunk              NEW: splits text under Telegram's documented 4,096-character limit. Not yet run in production.

import { call, type AppSpec } from "../../lib/http.ts";
import { secret } from "../../lib/secrets.ts";

export const spec: AppSpec = { app: "telegram", hosts: ["api.telegram.org"], keyInPath: /\/bot[^/]+/ };

/** Telegram refuses a message over 4,096 characters, so long reports go in parts, split on lines where possible. */
export function chunk(text: string, max = 4000): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const cut = rest.lastIndexOf("\n", max);
    const at = cut > max / 2 ? cut : max;
    out.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^\n/, "");
  }
  if (rest) out.push(rest);
  return out;
}

/** Sends plain text to one chat. Needs KIT_ALLOW_WRITES=1. */
export async function sendMessage(chatId: string, text: string): Promise<number> {
  let sent = 0;
  for (const part of chunk(text)) {
    const r = await call<any>(spec, { method: "POST", url: `https://api.telegram.org/bot${secret("TELEGRAM_BOT_TOKEN")}/sendMessage`, json: { chat_id: chatId, text: part, link_preview_options: { is_disabled: true } } });
    // Only ok:true means delivered, as the CRM treats it. Telegram can answer 200 with ok:false.
    if (r.data?.ok !== true) throw new Error(`telegram: not sent (${String(r.data?.description ?? "no reason given").slice(0, 80)})`);
    sent++;
  }
  return sent;
}
