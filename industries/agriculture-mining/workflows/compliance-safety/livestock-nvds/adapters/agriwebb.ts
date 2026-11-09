// AgriWebb: read only in this workflow. Both operations are draft operations (query.animals, query.managementGroups).
// Field names from AgriWebb's official schema: Animal { animalId, identity { name eid vid managementTag }, managementGroupId }
// and ManagementGroup { managementGroupId, name, species, type }.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type Group, FARM } from "../types.ts";

const P = "agriwebb";
const PAGE = 100;
const ANIMAL_SELECT = "animalId managementGroupId identity { name eid vid managementTag }";
const GROUP_SELECT = "managementGroupId name species type";

export function farmOf(s: Settings): string {
  if (!FARM.test(String(s.farm_id ?? ""))) throw new Error("agriwebb: farm_id is missing or not a plain id");
  return s.farm_id;
}

export async function listGroups(ctx: Ctx<Settings>): Promise<Group[]> {
  const r = await ctx.draft<{ data?: { managementGroups?: Group[] } }>({ platform: P, op: "query.managementGroups", summary: "read management groups",
    input: { params: { farmId: farmOf(ctx.settings) }, select: GROUP_SELECT } });
  const rows = r.data?.data?.managementGroups;
  return Array.isArray(rows) ? rows : [];
}

/** All animals on the farm. `complete` is false when the page cap was hit or a page came back malformed: the list is partial. */
export async function listAnimals(ctx: Ctx<Settings>): Promise<{ animals: any[]; complete: boolean }> {
  const farmId = farmOf(ctx.settings);
  const pages = Math.min(Math.max(ctx.settings.max_pages ?? 20, 1), 50);
  const out: any[] = [];
  for (let page = 0; page < pages; page++) {
    const r = await ctx.draft<{ data?: { animals?: any[] } }>({ platform: P, op: "query.animals", summary: `read animals page ${page + 1}`,
      input: { params: { farmId, limit: PAGE, skip: page * PAGE }, select: ANIMAL_SELECT } });
    const rows = r.data?.data?.animals;
    if (!Array.isArray(rows)) return { animals: out, complete: false };
    out.push(...rows);
    if (rows.length < PAGE) return { animals: out, complete: true };
  }
  return { animals: out, complete: false };
}
