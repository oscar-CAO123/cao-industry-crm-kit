// Trackunit: the vehicle register. Reads assets and queues asset note updates. Field names come from Trackunit's
// official assets spec: asset_v2, PaginatedAsset_v2 (content, number, totalPages), AssetIdentifier (type ASSET_ID),
// UpdateAssetNoteRequest (identifier, note).
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import type { Settings, VehicleRecord } from "../types.ts";

export const P = "trackunit";
const PAGE = 100;
const MAX_PAGES = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const text = (v: unknown, max = 200) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

/** Every page of the register, as plain vehicle records. Reads only. */
export async function readRegister(ctx: Ctx<Settings>): Promise<VehicleRecord[]> {
  const out: VehicleRecord[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await ctx.draft<{ content?: any[] }>({ platform: P, op: "assets.getAssets_v2", summary: `read vehicle register page ${page}`,
                                                    input: { params: { page, size: PAGE } } });
    const rows = Array.isArray(r.data?.content) ? r.data!.content! : [];
    for (const a of rows) {
      if (!UUID.test(String(a?.id ?? ""))) continue;
      out.push({
        id: String(a.id),
        name: text(a.name) ?? "",
        assetType: text(a.assetType, 100),
        type: text(a.type, 100),
        brand: text(a.brand, 100),
        model: text(a.model, 100),
        serialNumber: text(a.serialNumber, 100),
        productionYear: Number.isInteger(a.productionYear) ? a.productionYear : undefined,
        externalReference: text(a.externalReference, 200),
      });
    }
    if (rows.length < PAGE) break;
  }
  return out;
}

/** A live act that replaces the note on one vehicle. Only ever queued; a person approves it. */
export function noteAct(assetId: string, note: string, key: string): Act {
  if (!UUID.test(assetId)) throw new Error("trackunit: bad asset id");
  return {
    platform: P, op: "assets.updateAssetNote_v2", key, summary: `note on vehicle ${assetId}`,
    input: { body: { identifier: { type: "ASSET_ID", value: assetId }, note: note.slice(0, 4000) } },
  };
}
