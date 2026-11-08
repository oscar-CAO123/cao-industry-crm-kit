// Shared shapes for the bill of materials workflow. The one platform is Unleashed, the only platform in the kit with bill endpoints.
import crypto from "node:crypto";
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "unleashed";

export interface BomLine { code: string; qty: number }
export interface BomSpec { parent: string; lines: BomLine[] }
export interface Settings { business_name?: string; boms?: BomSpec[] }

/** One component on a bill, as the platform knows it. */
export interface BomPart { code: string; qty: number; guid: string }
/** What the workflow keeps about a bill it created, so a later run finds it instead of making a second one. */
export interface BomRecord { parent: string; parent_guid: string; guid: string; hash: string; created: string; lines: BomPart[] }
/** Something a person should look at. Written to the store, never sent. */
export interface Problem { parent: string; kind: string; detail: string; seen: string }

const CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A product code from settings: checked before it goes into a filter. The error never echoes the value. */
export const productCode = (v: unknown): string => {
  const s = String(v ?? "");
  if (!CODE.test(s)) throw new Error("bad product code");
  return s;
};
export const qtyOf = (v: unknown): number => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 1e6) throw new Error("bad quantity");
  return n;
};
/** An id from the platform, checked before it goes into a path. */
export const guid = (v: unknown, what: string): string => {
  const s = String(v ?? "");
  if (!GUID.test(s)) throw new Error(`unleashed: bad ${what} id`);
  return s;
};
export const keyOf = (s: string) => safeKey(s, 90);
/** A short fingerprint of a bill's components and quantities: the same bill always gives the same value. */
export function linesHash(lines: { code: string; qty: number }[]): string {
  const norm = lines.map((l) => `${l.code}=${l.qty}`).sort().join("|");
  return crypto.createHash("sha256").update(norm).digest("hex").slice(0, 16);
}
