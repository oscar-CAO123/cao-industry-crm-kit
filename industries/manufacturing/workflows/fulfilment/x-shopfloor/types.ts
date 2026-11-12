// Shared shapes for the shop-floor workflow. The only platform is Unleashed; its field names come from the vendor's
// own pages: Assemblies, StockOnHand.
export interface Settings {
  business_name?: string;
  ready_status: string;                 // the status the floor sets on a build when it is ready to complete
  reorder_levels: Record<string, number>; // product code to minimum quantity on hand
}

export interface Build {
  Guid?: string;
  AssemblyNumber?: string;
  AssemblyStatus?: string;
  CustomAssemblyStatus?: string;
  AssemblyDate?: string;
  Product?: { ProductCode?: string; ProductDescription?: string } | string;
  Quantity?: number;
}

export interface StockRow {
  Guid?: string;
  ProductCode?: string;
  ProductDescription?: string;
  QtyOnHand?: number;
  AvailableQty?: number;
  Warehouse?: string;
  WarehouseCode?: string;
}

export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A value from outside, bounded before it is stored or shown. */
export const str = (v: unknown, max = 200) => String(v ?? "").slice(0, max);
export const productCode = (p: Build["Product"]) => (typeof p === "object" && p ? p.ProductCode : p);
