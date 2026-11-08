// Shared shapes for the carbon-credits workflow. The one adapter (AgriWebb) reads farm data; nothing here writes.
export interface Settings {
  farms: string[];               // AgriWebb farm ids to read
  business_name?: string;
}

export interface FieldSnapshot {
  id: string;
  name?: string;
  total_area?: number;           // hectares
  unit?: string;
  land_use?: string;
  crop_type?: string;
}

export interface FarmSnapshot {
  farm: string;
  name?: string;
  time_zone?: string;
  fields: FieldSnapshot[];
  records_count: number;         // count only: the records themselves are not kept
}

export interface Snapshot { taken: string; farms: FarmSnapshot[] }

export type ItemStatus = "on file" | "partial" | "missing";
export interface ChecklistItem { item: string; status: ItemStatus; detail: string }
export interface ChecklistDraft { snapshot: string; farms: { farm: string; items: ChecklistItem[] }[] }
