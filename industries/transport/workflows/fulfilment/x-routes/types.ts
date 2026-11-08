// Shared shapes for the route planning workflow. Every adapter speaks these, so a cron can point at any platform.
import crypto from "node:crypto";

export type Platform = "onfleet";

export interface Settings {
  business_name?: string;
  timezone?: string;                 // for the day label on drafts, for example "Australia/Sydney"
  teams: string[];                   // Onfleet team ids the plan cron may dispatch
  route_end?: string | null;         // where each route ends: teams://DEFAULT, workers://ROUTING_ADDRESS, hub://<id>, or null
  lookback_hours?: number;           // first intake run reads this far back
}

/** A delivery or job the business wants routed. Kept from the platform's own record: only the fields the crons use. */
export interface Stop {
  id: string;
  shortId?: string;
  state?: number;
  routed: boolean;                   // true when the platform already puts the task in a route plan
  address?: string;                  // destination address text, when the platform returns one
  completeAfter?: number | null;
  completeBefore?: number | null;
  seen: string;
}

/** The ids and values a cron may use after they pass the checks below. Anything else from outside is refused. */
export const ID = /^[A-Za-z0-9~*_-]{8,64}$/;
export const ROUTE_END = /^(teams:\/\/DEFAULT|workers:\/\/ROUTING_ADDRESS|hub:\/\/[A-Za-z0-9~*_-]{8,64})$/;

export const routeEndOf = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v);
  if (!ROUTE_END.test(s)) throw new Error("route_end must be teams://DEFAULT, workers://ROUTING_ADDRESS, hub://<id>, or null");
  return s;
};

/** A store key that always passes the store's name rule (Onfleet ids hold ~ and *), unique thanks to the hash. */
export const storeKey = (s: string) =>
  `t-${s.replace(/[^a-z0-9]/gi, "-").slice(0, 60)}-${crypto.createHash("sha256").update(s).digest("hex").slice(0, 12)}`;
