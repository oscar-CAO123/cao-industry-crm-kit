// Shared shapes for the opportunity-finding workflow. The one adapter (adapters/microsoft-365.ts) speaks these.
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "microsoft-365";

export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
/** Graph ids and workbook names: no slashes, so a value cannot change the path it is put in. */
export const ID = /^[A-Za-z0-9=_\-!.{}]{1,400}$/;

export interface Settings {
  business_name?: string;
  microsoft_365: {
    /** The business's own mailbox, where the portal alert emails arrive. */
    mailbox: string;
    /** A Graph mail folder id, or a well-known name such as inbox. */
    folder?: string;
    /** A word the alert must contain. Empty keeps every message in the folder. */
    search?: string;
    /** The register: an Excel table that gets one row per new opportunity. */
    register?: { drive: string; item: string; table: string };
  };
  /** Where the digest is sent. The send is queued for approval. */
  digest_to: string;
}

export interface Opportunity {
  key: string;
  platform: Platform;
  title: string;
  preview?: string;
  from?: string;
  received: string;
  ref: Record<string, string>;
  status: "new" | "logged" | "digested" | "dismissed";
  logged?: string;
  digested?: string;
}

/** Written by the agent skill into the store's "fit" namespace, keyed by the opportunity key. */
export interface Verdict { verdict: "fits" | "maybe" | "no"; reason: string; judged: string }

export const keyOf = (s: string) => safeKey(s, 90);
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
/** A spreadsheet cell that can never become a formula. */
export const cell = (v: unknown) => { const s = String(v ?? ""); return /^[=+\-@\t\r]/.test(s) ? "'" + s : s; };
export const day = (d: Date) => d.toISOString().slice(0, 10);
