---
name: agriculture-mining-carbon-credits
description: Carbon project evidence from a farm's AgriWebb records. Use when setting up carbon-credit tracking for a client, when the checklist shows missing farm data, or when an owner asks what a carbon project would need from their records.
---

# Earn carbon credits from field records

Built from the platform docs for AgriWebb, Agworld and CropX (no call evidence yet). Only AgriWebb has kit operations, and this
workflow uses its reads only.

## What runs on its own
Two crons in `index.ts`. `snapshot` reads each configured farm's fields and records from AgriWebb and keeps them as evidence.
`checklist` drafts what is on file and what is missing, from that snapshot. Neither one sends, registers, claims, sells or pays.

## Setting it up for a client
1. Fill `settings.json` from `settings.example.json` with the AgriWebb farm ids.
2. Set `AGRIWEBB_ACCESS_TOKEN` on the deploy. The token exchange is not built, so a token must be supplied.
3. Run `snapshot` once and then `checklist`, and read the draft before relying on it.

## What the judgment steps are
The checklist reports only what AgriWebb holds. Whether a block of land qualifies, which method to use and what to submit
is the person's decision and the project's rules, not something the cron decides.

## Not covered
Verification, project registration, claims, credit issuing, sale and payment. No platform in the kit maps them. Agworld and
CropX have no kit folder, so their soil sampling and lab data are not read. See `workflow.json` gaps.
