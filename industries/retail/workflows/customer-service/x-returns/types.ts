// Shared shapes for the returns workflow. Each adapter speaks these, so the crons never touch a platform directly.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "google-workspace" | "gorgias";

export interface Settings {
  business_name: string;
  intake: Platform[];            // where return requests arrive (each request is answered on the platform it came from)
  search?: string;               // Gmail search for return requests
  return_form_url: string;       // https link to the business's own returns form or portal
}

export interface Request {
  id: string; source: Platform; subject: string; received: string;
  ref: Record<string, string>;   // message_id, thread_id, from (Gmail) or ticket_id (Gorgias)
  status: "new" | "queued";
  approval?: string; queued_at?: string;
}

export interface Adapter {
  id: Platform;
  /** Read new return requests from the platform. Reads only. */
  requests?(ctx: Ctx<Settings>): Promise<Omit<Request, "status">[]>;
  /** Put the reply in front of a person: a draft where the platform makes one, and a queued send. Returns the approval id. */
  queueReply?(ctx: Ctx<Settings>, r: Request, text: string): Promise<string>;
}

export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const keyOf = (s: string) => safeKey(s, 90);

/** The reply every request gets. It uses only the business's own settings, never text from the customer. */
export function replyText(s: Settings): string {
  if (!/^https:\/\/[^\s]{1,400}$/.test(s.return_form_url)) throw new Error("returns: return_form_url must be an https link");
  const name = s.business_name.replace(/[\r\n]+/g, " ").slice(0, 120);
  return [
    "Hi,", "",
    "Thanks for getting in touch about your return. You can start it here:",
    s.return_form_url, "",
    `If anything about the return is unclear, reply to this and someone at ${name} will help.`, "",
    name,
  ].join("\n");
}
