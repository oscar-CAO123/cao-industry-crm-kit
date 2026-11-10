// Trackunit: the plant register. Reads only. Field names from Trackunit's official assets spec
// (developers.trackunit.com/openapi/assets.json): GET /v2/assets returns PaginatedAsset_v2 with content[] of asset_v2.
// Operating hours are not on the asset record, so this adapter does not report usage (see workflow.json gaps).
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import type { Settings } from "../types.ts";

const P = "trackunit";

export interface TrackunitAsset {
  id: string; name: string; serial?: string; brand?: string; model?: string; type?: string; telematics_devices: number;
}

const str = (v: unknown, max = 200) => String(v ?? "").slice(0, max);

/** Every page of the register, up to the page limit in settings. A read: nothing is written to Trackunit. */
export async function readRegister(ctx: Ctx<Settings>): Promise<TrackunitAsset[]> {
  const size = ctx.settings.trackunit_page_size ?? 100, maxPages = ctx.settings.trackunit_max_pages ?? 10;
  const out: TrackunitAsset[] = [];
  for (let page = 0; page < maxPages; page++) {
    const r = await ctx.draft<any>({ platform: P, op: "assets.getAssets_v2", summary: `read trackunit assets page ${page}`,
      input: { params: { page, size } } });
    const data = r.data ?? {};
    const content: any[] = Array.isArray(data.content) ? data.content : [];
    for (const a of content) {
      if (a?.id === undefined || a?.id === null) continue;
      out.push({
        id: str(a.id, 120), name: str(a.name), serial: a.serialNumber ? str(a.serialNumber, 120) : undefined,
        brand: a.brand ? str(a.brand, 120) : undefined, model: a.model ? str(a.model, 120) : undefined,
        type: a.type ? str(a.type, 120) : undefined,
        telematics_devices: Array.isArray(a.telematicsDevices) ? a.telematicsDevices.length : 0,
      });
    }
    const totalPages = Number(data.totalPages);
    if (content.length < size || (Number.isFinite(totalPages) && page + 1 >= totalPages)) break;
  }
  return out;
}
