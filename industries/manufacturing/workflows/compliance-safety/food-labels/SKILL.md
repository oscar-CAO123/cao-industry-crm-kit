---
name: food-labels
description: Drafts a food product's ingredient declaration, per 100 g nutrition panel and allergens from its recipe in Airtable, for a person to check against the Food Standards Code. Use when a food manufacturer wants label drafts from recipes. Nothing is sent or published.
---

# Food labels (docs-only)

## What runs on its own

- **intake** (every 30 minutes) reads the Products table and records each new product.
- **draft** (at 15 and 45 past) reads the Recipe and Ingredients tables, works out the ingredient declaration (most by weight first), the nutrition per 100 g (weighted by grams) and the allergens each ingredient lists, and writes one row to the Drafts table. A product is drafted once.

Both crons read, or write only the Drafts table. Nothing is sent, published or queued.

## Setup

1. Make an Airtable base with four tables and these columns:
   - Products: `Product`, `Status`
   - Recipe: `Product`, `Ingredient`, `Grams`
   - Ingredients: `Ingredient`, `Energy (kJ)`, `Protein (g)`, `Fat, total (g)`, `Saturated fat (g)`, `Carbohydrate (g)`, `Sugars (g)`, `Sodium (mg)`, `Allergens`
   - Drafts: `Product`, `Ingredients (by weight, most first)`, `Contains`, `Missing data`, `Draft status`, and each nutrient above with ` per 100 g` added
2. Copy `settings.example.json` and fill in the base id (`app...`) and table ids (`tbl...`).
3. Set `AIRTABLE_ACCESS_TOKEN` in the environment. Writes need `KIT_ALLOW_WRITES=1` on the deploy.

## Judgment steps (the agent does these, not the crons)

- Read each Drafts row against the source label rules before any label is printed. The panel is unrounded to one decimal place; rounding and the required format are the person's check.
- Decide whether a compound ingredient needs its own sub-recipe. The crons do not expand them.
- Check allergen wording, including may-contain statements, against the ingredient supplier's specification. The crons only read the list on each ingredient.
- Check any nutrition, health or other claim on the label. The crons make no claims.
- Confirm the artwork and proof. Nothing here produces artwork.

## Not covered

Label artwork, proof approval, printing and packing, supplier specification updates, and Unleashed or other recipe systems (see `workflow.json` gaps).
