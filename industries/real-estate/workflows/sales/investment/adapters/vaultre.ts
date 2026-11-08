// VaultRE: the property record the investment check is filed against. Reads the property; writes one note on it (internal only).
// Field names come from the vendor spec (endpoint-map/raw/vaultre): addPropertyNote takes body, readOnly and type.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import type { Settings } from "../types.ts";

export const P = "vaultre";

export function propertyId(v: unknown): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 2_000_000_000) throw new Error("vaultre: bad property id");
  return n;
}

export async function getProperty(ctx: Ctx<Settings>, id: unknown): Promise<unknown> {
  const pid = propertyId(id);
  const r = await ctx.draft<any>({ platform: P, op: "getProperty", summary: `read property ${pid}`, input: { params: { id: pid } } });
  if (r.status >= 300) throw new Error(`vaultre: read property ${pid} returned ${r.status}`);
  return r.data;
}

export async function addPropertyNote(ctx: Ctx<Settings>, id: unknown, body: string, noteType: number): Promise<number> {
  const pid = propertyId(id);
  const text = body.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").slice(0, 4000);
  const r = await ctx.draft<any>({ platform: P, op: "addPropertyNote", summary: `note on property ${pid}`,
    input: { params: { id: pid }, body: { body: text, readOnly: false, type: noteType } } });
  if (r.status >= 300) throw new Error(`vaultre: note on property ${pid} returned ${r.status}`);
  return r.status;
}
