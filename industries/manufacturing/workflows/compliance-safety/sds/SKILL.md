---
name: sds
description: Keeps a manufacturer's safety data sheet register in Airtable, drafts an SDS row for each new chemical from the data the register holds, and flags SDS whose review date is near or past. Use when a business wants SDS drafts and review reminders from its chemical list. Nothing is sent or published.
---

# Safety data sheets (docs-only)

## What runs on its own

- **intake** (every 30 minutes) reads the Chemicals table and records each new chemical (status "New", or blank).
- **draft** (at 10 and 40 past) writes one row to the Drafts table for each new chemical: the SDS fields the register holds, the fields it is missing, and a draft status. A chemical is drafted once.
- **currency** (daily, 22:00 UTC) writes one "Review due" row for each chemical whose review date has passed or falls within the window (30 days by default). Each review date is flagged once.

All three crons read, or write only the Drafts table. Nothing is sent, published or queued.

## Setup

1. Make an Airtable base with two tables and these columns:
   - Chemicals: `Product`, `Status`, `Supplier`, `SDS version`, `Issue date`, `Review date`, `Signal word`, `Hazard statements`, `Precautionary statements`, `Pictograms`, `Storage`, `PPE`
   - Drafts: `Draft type`, `Product`, `Supplier`, `SDS version`, `Issue date`, `Review date`, `Signal word`, `Hazard statements`, `Precautionary statements`, `Pictograms`, `Storage`, `PPE`, `Missing data`, `Draft status`, `Note`
   - Date columns use ISO format (`YYYY-MM-DD`). Set Status to `Retired` on a chemical the review check should skip.
2. Copy `settings.example.json` and fill in the base id (`app...`) and table ids (`tbl...`).
3. Set `AIRTABLE_ACCESS_TOKEN` in the environment. Writes need `KIT_ALLOW_WRITES=1` on the deploy.

## Judgment steps (a person does these, not the crons)

- Get the supplier's current SDS and enter its version, issue date and review date in the register.
- Classify the hazards against the GHS and write the hazard and precautionary statements. The crons only copy what the register holds.
- Write the sections of the SDS from the supplier's sheet and the business's own use. The drafts list what is missing; they do not fill it in.
- Technical review, then approval, before any SDS is used or handed to staff.

## Not covered

Obtaining and filing the supplier's PDF, approval, publishing to staff, withdrawing superseded SDS, training, stock and storage inventory, and audits (see `workflow.json` gaps).
