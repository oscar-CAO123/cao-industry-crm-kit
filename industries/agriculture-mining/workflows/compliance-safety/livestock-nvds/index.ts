// The livestock NVD workflow's two crons. Each reads AgriWebb or the local store and drafts. Nothing is signed,
// lodged on NLIS or sent by code: the vendor signs each NVD and records each NLIS movement (see SKILL.md).
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { NvdRequest, Settings, StockLine } from "./types.ts";
import { TAG, keyOf } from "./types.ts";
import { listAnimals, listGroups } from "./adapters/agriwebb.ts";

/** Every six hours: copy the farm's animals and management groups into the local stock register. */
export async function stockRegister(ctx: Ctx<Settings>) {
  const groups = new Map((await listGroups(ctx)).map((g) => [g.managementGroupId, g.name]));
  const animals = await listAnimals(ctx);
  const read = ctx.now.toISOString();
  let saved = 0;
  for (const a of animals) {
    const id = String(a.animalId ?? "");
    if (!id) continue;
    const line: StockLine = { key: keyOf(id), animal_id: id, name: a.identity?.name, eid: a.identity?.eid, vid: a.identity?.vid,
      management_tag: a.identity?.managementTag, management_group_id: a.managementGroupId, group_name: groups.get(a.managementGroupId), read };
    await ctx.store.put("stock", line.key, line);
    saved++;
  }
  ctx.log(`stock-register: ${saved} animals, ${groups.size} groups`);
  return { animals: saved, groups: groups.size };
}

/** Every thirty minutes: match each new NVD request's tags to the stock register and draft its stock lines. */
export async function nvdDraft(ctx: Ctx<Settings>) {
  const byTag = new Map<string, StockLine>();
  for (const s of Object.values(await ctx.store.list<StockLine>("stock")))
    for (const t of [s.eid, s.vid, s.management_tag]) if (t) byTag.set(t.toUpperCase(), s);
  let drafted = 0, needsCheck = 0;
  for (const [key, r] of Object.entries(await ctx.store.list<NvdRequest>("nvd-requests"))) {
    if (r.status !== "new") continue;
    const lines: NonNullable<NvdRequest["lines"]> = [];
    for (const raw of r.tags ?? []) {
      const tag = String(raw ?? "").trim();
      if (!TAG.test(tag)) { lines.push({ tag: tag.slice(0, 32), matched: false }); continue; }
      const hit = byTag.get(tag.toUpperCase());
      lines.push({ tag, animal_id: hit?.animal_id, group: hit?.group_name, matched: !!hit });
    }
    const ok = lines.length > 0 && lines.every((l) => l.matched);
    await ctx.store.put("nvd-requests", key, { ...r, lines, status: ok ? "drafted" : "needs-check",
      note: ok ? undefined : "a tag is missing from the stock register or is malformed" } satisfies NvdRequest);
    if (ok) drafted++; else needsCheck++;
  }
  ctx.log(`nvd-draft: ${drafted} drafted, ${needsCheck} need a check`);
  return { drafted, needs_check: needsCheck };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { stockRegister, nvdDraft };
