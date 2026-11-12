---
name: hospitality-tabs-room-charges
description: Guest tabs and room charges posted to the guest folio in a hotel or hospitality property's own system. Use when setting this up for a client, when the night auditor asks why a folio or trial balance looks wrong, or when a charge needs posting to a folio.
---

# Run guest tabs and post room charges to the folio

Status: docs-only. Built from the docs of three property and POS vendors. Only Cloudbeds is mapped in the kit, and it is not yet proven against a real account.

## What runs on its own
Two crons in `index.ts`, scheduled by `workflow.json`. `folio-config` reads the property's folio setup every 30 minutes. `reconcile` reads the trial balance each night. Both read and draft only, and neither changes a guest's bill.

## Setting it up for a client
1. Fill `settings.json` from `settings.example.json`: the Cloudbeds property number and the business name.
2. Confirm the Cloudbeds key is set in the environment. It is never written into settings.
3. Confirm with the front desk which tab feed they use. No tab feed is mapped in the kit yet.

## Judgment steps the agent does
- Opening tabs, authorising room charges, disputes, end-of-shift close and payment stay with the agent and the property's staff.
- A tab charge only reaches a folio after a person approves it. Creating a folio, moving a charge and routing a charge are all live operations.

## Not covered yet
- Posting a charge to a folio. It needs a tab feed and the request body fields confirmed from the vendor spec.
- Lightspeed (Tableside, Foratable) and Mews. Neither is mapped in the kit.
- Oracle Opera. The fetched pages were the wrong product, so it needs a fresh fetch.
