// Shared shapes for the retail artwork workflow. The WooCommerce adapter speaks these.

export type Platform = "woocommerce";

export interface Settings {
  business_name?: string;
  store: Platform;
  /** The most images a product may hold after the update (existing plus new). Default 10. */
  max_images?: number;
  /** The hosts the business serves mockup images from (for example "assets.example.com.au"). Listing refuses to run without them. */
  asset_hosts?: string[];
}

/** A product as the store holds it, reduced to what this workflow reads. */
export interface ProductRow {
  id: number;
  name: string;
  sku: string;
  images: { id: number; src: string }[];
}

/** One image the agent has made for a product. The src must be an https URL the business controls. */
export interface MockupImage { src: string; alt?: string }

/** The mockups the agent has made for one product, written to the "mockups" namespace of the store. */
export interface MockupSet {
  product_id: number;
  images: MockupImage[];
}
