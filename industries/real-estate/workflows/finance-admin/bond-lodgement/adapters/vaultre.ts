// VaultRE: the tenancy list and the bond receipt on each tenancy. Read only.
// Field names come from the vendor spec (VaultRE swagger): TenancyAndProperty.tenancy (start, end, archived) and TenancyExtended.bondReceipted.
import type { Ctx } from "../../../../../../../core/workflows/runtime.ts";
import { type Settings, type Tenancy } from "../types.ts";

const P = "vaultre";
const id = (v: unknown) => { const n = Number(v); if (!Number.isInteger(n) || n <= 0 || n > Number.MAX_SAFE_INTEGER) throw new Error("vaultre: bad tenancy id"); return n; };
const date = (v: unknown) => { const s = String(v ?? ""); return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null; };

export const vaultre = {
  id: P,
  /** Every residential tenancy the account holds, paged. */
  async tenancies(ctx: Ctx<Settings>): Promise<Tenancy[]> {
    const max = Math.min(ctx.settings.max_pages ?? 5, 50);
    const out: Tenancy[] = [];
    for (let page = 1; page <= max; page++) {
      const r = await ctx.draft<any>({ platform: P, op: "getResidentialLeaseTenancies", summary: `tenancies page ${page}`, input: { params: { page, pagesize: 100 } } });
      for (const it of r.data?.items ?? []) {
        const t = it?.tenancy ?? {};
        const receipted = t.bondReceipted == null ? null : Number(t.bondReceipted);
        out.push({
          id: String(id(t.id)), property: String(it?.property?.displayAddress ?? "").slice(0, 200),
          start: date(t.start), end: date(t.end),
          bond_receipted: receipted !== null && Number.isFinite(receipted) ? receipted : null,
          archived: t.archived === true,
        });
      }
      if (!r.data?.totalPages || page >= Number(r.data.totalPages)) break;
    }
    return out;
  },
};
