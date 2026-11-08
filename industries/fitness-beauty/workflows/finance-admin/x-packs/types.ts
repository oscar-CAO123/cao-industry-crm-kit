// Shared shapes for the packs and gift cards workflow. Every adapter here only reads from a platform.
export type Platform = "square" | "xero";

export interface Settings {
  business_name?: string;
  gift_card_state?: "ACTIVE" | "DEACTIVATED" | "BLOCKED" | "PENDING";
}

/** One gift card as kept in the snapshot: its id and balance only. Card numbers (GANs) are never read or stored. */
export interface GiftCardRow { id: string; state: string; cents: number; currency: string }

export interface Snapshot {
  date: string;
  cards: number;
  total_cents: number;
  skipped: number;
  truncated: boolean;
  rows: GiftCardRow[];
}
