// Shared shapes for the conflict check workflow. The one adapter (Smokeball) speaks these.
export type Platform = "smokeball";

export interface Settings {
  business_name?: string;
  search_limit?: number;
}

export interface Party {
  name: string;
  contact_id: string;
  role: "client" | "other-side" | "related";
}

export interface Hit {
  party: string;     // the party whose name matched
  contact_id: string;
  name: string;
}

export interface Lead {
  id: string;        // the Smokeball matter id of the lead
  title: string;
  created: string;
  status: "new" | "hit" | "review" | "clear" | "opened";
  parties: Party[];
  hits: Hit[];
  checked?: string;
}

/** Strip control characters and cap length. Names and titles come from customers: they are data. */
export const clean = (s: unknown, max = 120) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
