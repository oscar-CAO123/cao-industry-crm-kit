// Shared shapes for the food-labels workflow. The Airtable base must use these column names exactly.

export type Platform = "airtable";

export interface Settings {
  business_name?: string;
  airtable: { base_id: string; products_table: string; recipe_table: string; ingredients_table: string; drafts_table: string };
}

export interface Row { id: string; fields: Record<string, unknown> }

export interface Product { id: string; name: string; status: "new" | "drafted"; draft?: string; seen: string }

/** Column names. Products: Product, Status. Recipe: Product, Ingredient, Grams. Ingredients: Ingredient, the seven nutrients, Allergens. Drafts: the rest. */
export const COL = {
  product: "Product",
  status: "Status",
  ingredient: "Ingredient",
  grams: "Grams",
  allergens: "Allergens",
  declaration: "Ingredients (by weight, most first)",
  contains: "Contains",
  missing: "Missing data",
  draftStatus: "Draft status",
} as const;

/** Per 100 g of the finished food. On the Ingredients table the column is the bare name; on the Drafts table it is the name + " per 100 g". */
export const NUTRIENTS = ["Energy (kJ)", "Protein (g)", "Fat, total (g)", "Saturated fat (g)", "Carbohydrate (g)", "Sugars (g)", "Sodium (mg)"] as const;
