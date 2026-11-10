// Lot trace and recall: the settings, records and validators shared by the crons and the Unleashed adapter.
export type Platform = "unleashed";

export interface Settings {
  business_name?: string;
  /** WarehouseCode that held stock is moved to. */
  quarantine_warehouse: string;
  /** WarehouseCodes the stock reads cover. Empty means every warehouse. */
  warehouse_codes?: string[];
  /** Set true only after a sandbox transfer proves Unleashed moves the named batch: the transfer line names a product and
   *  quantity, not a batch, so until this is set no hold is queued (a move could leave the held lot where it is). */
  lot_selection_confirmed?: boolean;
}

export interface Lot { guid: string; batch: string; product: string; qty: number; warehouse: string; expiry: string; status: string }
export interface Serial { guid: string; serial: string; product: string; warehouse: string; status: string }
export interface Position { guid: string; product: string; warehouse: string; qty: number; available: number }
export interface AuditEntry { guid: string; kind: "count" | "adjustment"; ref: string; date: string; status: string; warehouse: string; reason: string }
/** Written when stock must be held. The quarantine cron queues the transfer for approval; it never runs it. */
export interface Hold { guid: string; batch: string; product: string; qty: number; from: string; reason: string; held_at: string; queued?: string }

export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CODE = /^[A-Za-z0-9_-]{1,15}$/;
export const PRODUCT = /^[A-Za-z0-9._ \/-]{1,100}$/;
/** Plain text from a platform or a person: control characters out, length capped. */
export const text = (v: unknown, max: number) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
export const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= 1e9 ? n : 0; };
export const guidOf = (v: unknown) => (GUID.test(String(v ?? "")) ? String(v) : null);
export const warehouseOf = (v: unknown) => (CODE.test(String(v ?? "")) ? String(v) : "");
