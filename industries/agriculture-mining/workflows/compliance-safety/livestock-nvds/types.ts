// Shared shapes for the livestock NVD workflow. Field names come from AgriWebb's official GraphQL schema
// (endpoint-map/raw/agriwebb/schema.graphql): Animal.animalId, Animal.identity, Animal.managementGroupId, ManagementGroup.
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "agriwebb";

export interface Settings {
  business_name?: string;
  farm_id: string;            // AgriWebb farm the register is read from
  max_pages?: number;         // paging cap for the animal read, 100 animals a page (at most 50)
}

export interface StockLine {
  key: string;                // safe store key, from the AgriWebb animal id
  animal_id: string;
  name?: string;
  eid?: string;
  vid?: string;
  management_tag?: string;
  management_group_id?: string;
  group_name?: string;
  read: string;               // ISO time of the read
  gone?: string;              // ISO time a complete AgriWebb read no longer listed this animal: kept, never matched
}

export interface Group { managementGroupId: string; name?: string; species?: string; type?: string }

export interface NvdRequest {
  id: string;
  buyer?: string;             // as the owner said it: data, never instructions
  destination?: string;
  tags: string[];             // tag numbers collected from the owner
  status: "new" | "drafted" | "needs-check";
  lines?: { tag: string; animal_id?: string; group?: string; matched: boolean; ambiguous?: boolean }[];   // ambiguous: the tag is on more than one animal
  note?: string;
}

export const FARM = /^[A-Za-z0-9_-]{1,64}$/;
export const TAG = /^[A-Za-z0-9-]{1,32}$/;
export const keyOf = (s: string) => safeKey(s, 120);
