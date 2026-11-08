// Shared shapes for the SDS workflow. The Airtable base must use these column names exactly.

export type Platform = "airtable";

export interface Settings {
  business_name?: string;
  review_window_days?: number;
  airtable: { base_id: string; chemicals_table: string; drafts_table: string };
}

export interface Row { id: string; fields: Record<string, unknown> }

export interface Chemical { id: string; name: string; status: "new" | "drafted"; draft?: string; seen: string }

/** Chemicals table: Product, Status, Supplier, SDS version, Issue date, Review date, Signal word, Hazard statements,
 *  Precautionary statements, Pictograms, Storage, PPE. Drafts table: Draft type, the same SDS fields, Missing data, Draft status, Note. */
export const COL = {
  product: "Product",
  status: "Status",
  supplier: "Supplier",
  version: "SDS version",
  issued: "Issue date",
  review: "Review date",
  signal: "Signal word",
  hazards: "Hazard statements",
  precautions: "Precautionary statements",
  pictograms: "Pictograms",
  storage: "Storage",
  ppe: "PPE",
  draftType: "Draft type",
  missing: "Missing data",
  draftStatus: "Draft status",
  note: "Note",
} as const;

/** What a draft needs before a person can author the SDS from it. Checked against the register, not against the law. */
export const REQUIRED = [COL.supplier, COL.version, COL.issued, COL.review, COL.signal, COL.hazards, COL.precautions,
  COL.pictograms, COL.storage, COL.ppe] as const;
