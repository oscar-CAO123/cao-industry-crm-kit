// Shared shapes for the crop and livestock records workflow. Field names come from AgriWebb's official GraphQL schema
// Farm, Field, Session, Record, AnimalsWithCount, Rainfall, AddRainfallInput.
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "agriwebb";

export interface Settings {
  business_name?: string;
  farm_ids?: string[];        // farms to watch; when empty, every farm the token can see (at most 5)
  stale_days?: number;        // days with no farm record before the review flags it (default 14)
  rain_window_days?: number;  // days with no rainfall reading before the review flags it (default 30)
}

export interface Farm { id: string; name?: string; timeZone?: string }
export interface Field { id: string; name?: string; farmId?: string; totalArea?: number; unit?: string; landUse?: string; cropType?: string; lastModifiedDate?: unknown }
export interface Session { id: string; name?: string; type?: string; state?: string; farmId?: string }
export interface Rainfall { id?: string; value?: number; unit?: string; sensorId?: string; time?: unknown; mode?: string; farmId?: string }

export interface Snapshot {
  farm: Farm;
  read: string;               // ISO time of the read
  fields: Field[];
  sessions: Session[];
  recent_records: number;     // farm records dated inside stale_days
  animals?: number;
  rainfall: Rainfall[];       // readings inside rain_window_days
}

/** A rainfall reading the owner or the agent has entered. It is only queued; a person approves the write. */
export interface RainProposal {
  kind: "rainfall";
  farm_id: string;
  sensor_id: string;          // the AgriWebb rain gauge id (mapFeatures, type RAIN_GAUGE)
  value: number;              // millimetres
  time: number;               // UNIX epoch milliseconds
  mode?: "absolute" | "cumulative";
  status?: "new" | "queued" | "refused";
  reason?: string;
  approval?: string;
}

export interface ReviewDraft {
  farm_id: string;
  farm_name?: string;
  made: string;
  flags: string[];
  fields: number;
  sessions: number;
  animals?: number;
}

export const FARM = /^[A-Za-z0-9_-]{1,64}$/;
export const SENSOR = /^[A-Za-z0-9._:-]{1,64}$/;
export const DAY = 864e5;
export const keyOf = (s: string) => safeKey(s, 120);
/** AgriWebb timestamps are epoch milliseconds in the filters and may come back as numbers or strings. */
export const toMs = (v: unknown): number => (typeof v === "number" ? v : Date.parse(String(v ?? "")));
