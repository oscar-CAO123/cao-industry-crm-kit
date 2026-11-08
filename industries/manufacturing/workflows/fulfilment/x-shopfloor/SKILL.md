---
name: shop-floor
description: Shop-floor builds and low components for a manufacturing business that runs its floor in Unleashed. Crons read and draft the board; a person approves every build completion.
---

# Shop floor

## What runs on its own
- **schedule** (every 30 minutes): open builds from Unleashed go onto the shop-floor board in the workflow store.
- **stock** (every 6 hours): components below the minimum in `settings.reorder_levels` go onto a short list in the store.
- **complete-builds** (hourly): each build whose status is the `ready_status` setting is queued for approval as a completion. A build queues once, however many times the cron runs.

No cron completes a build, edits stock, or contacts anyone. Completion runs only after a person approves it in the CRM shell.

## Setup
- Copy `settings.example.json` into the business's settings. Set `ready_status` to the status the floor uses (create it in Unleashed first). Set `reorder_levels` to the minimum quantity per product code.
- Keys by environment name only: `UNLEASHED_API_ID`, `UNLEASHED_API_KEY`, `UNLEASHED_CLIENT_TYPE`. Writes need `KIT_ALLOW_WRITES=1` on the deploy.
- Calls go through the kit's Unleashed signer. Nothing has run against a live account yet, so the reads and the completion stay unproven until a sandbox Unleashed account confirms them (see `gaps` in `workflow.json`).

## Judgment the agent does
- Read the board and say which builds are late or blocked, in plain words.
- Ask the floor before marking a build ready. The agent never sets a build's status itself.

## Not covered
Setup of machines, in-process checks, final inspection, rework or scrap, time logging, dispatch, order release from a sales order, and job costing or invoicing. These stay with the people on the floor until a mapped platform covers them.
