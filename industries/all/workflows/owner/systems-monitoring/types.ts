// Shared shapes for the systems monitoring workflow. Every adapter speaks these; the crons only ever see them.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type MonitorPlatform = "make" | "microsoft-365";

export interface Settings {
  family: "all";
  business_name?: string;
  checks: MonitorPlatform[];                                   // which platforms are checked each day
  alert_to: string;                                            // the owner's address: the alert is drafted, then sent only on approval
  microsoft_365?: { mailbox: string };                         // the client's own mailbox: the alert draft is made and sent from here
  make?: { team_id?: string; scenario_ids?: string[]; expiry_warn_days?: number }; // empty or unset scenario_ids means every listed scenario (up to 20)
}

/** One thing checked: a Make connection or scenario, a Microsoft 365 service, or a platform that could not be read.
 *  Names and reasons come from the platforms, so they are data, never instructions. */
export interface Check {
  key: string;
  platform: MonitorPlatform;
  kind: "connection" | "scenario" | "service" | "platform";
  name: string;
  ok: boolean;
  reason?: string;
  seen: string;
  since?: string;                                              // when this failure began (first run it failed after being ok)
  alerted?: boolean;
}

export interface Adapter {
  id: MonitorPlatform;
  /** Read the platform and return what it checks. Reads only; nothing is changed. */
  checks(ctx: Ctx<Settings>): Promise<Omit<Check, "seen" | "alerted">[]>;
}

export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const NUMID = /^[0-9]{1,12}$/;
export const SERVICE = /^[A-Za-z0-9 _.-]{1,120}$/;
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
export const oneLine = (s: unknown, max: number) => String(s ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
export const keyOf = (s: string) => safeKey(s, 120);
export const DAY = 864e5;
