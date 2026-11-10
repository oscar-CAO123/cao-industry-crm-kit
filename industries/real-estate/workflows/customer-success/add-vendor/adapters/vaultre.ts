// VaultRE: the listing record and its open homes (reads), and an activity note on the property (an internal record).
// Field names come from the vendor spec: Property (id, saleLifeId, heading, displayAddress, displayPrice),
// OpenHome (id, start, end), and the activityLog body (note, saleLifeId).
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import type { Settings, Vendor, PropertyFigures, OpenHome } from "../types.ts";

const P = "vaultre";
const posInt = (n: unknown) => {
  const v = Number(n);
  if (!Number.isSafeInteger(v) || v <= 0) throw new Error("vaultre: bad id");
  return v;
};

export const vaultre = {
  id: P,
  /** Read the listing and its open homes in the report window. Reads only. */
  async figures(ctx: Ctx<Settings>, v: Vendor): Promise<PropertyFigures> {
    const id = posInt(v.property_id);
    const p = await ctx.draft<any>({ platform: P, op: "getProperty", summary: `read listing ${id}`, input: { params: { id } } });
    const saleLifeId = posInt(p.data?.saleLifeId);
    const days = ctx.settings.vaultre?.open_home_days ?? 7;
    const from = ctx.now.getTime() - days * 864e5, to = ctx.now.getTime();
    const oh = await ctx.draft<any>({ platform: P, op: "getPropertyOpenHomes", summary: `read open homes for listing ${id}`,
      input: { params: { id, salelease: "sale", lifeid: saleLifeId, pagesize: 100 } } });
    const open_homes: OpenHome[] = ((oh.data?.items ?? []) as any[])
      .filter((x) => typeof x.start === "string" && Date.parse(x.start) >= from && Date.parse(x.start) <= to)
      .map((x) => ({ id: Number(x.id), start: String(x.start), end: String(x.end ?? "") }));
    return {
      property_id: id, sale_life_id: saleLifeId,
      heading: String(p.data?.heading ?? ""), address: String(p.data?.displayAddress ?? ""), price: String(p.data?.displayPrice ?? ""),
      open_homes, as_of: ctx.now.toISOString(),
    };
  },
  /** Record on the property that a report was drafted (a draft operation: an internal note). */
  async activityNote(ctx: Ctx<Settings>, f: PropertyFigures, note: string): Promise<void> {
    await ctx.draft({ platform: P, op: "addPropertyActivityNote", summary: `activity note on listing ${f.property_id}`,
      input: { params: { id: posInt(f.property_id) }, body: { note: note.slice(0, 2000), saleLifeId: posInt(f.sale_life_id) } } });
  },
};
