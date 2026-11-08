---
name: retail-batches-landed-costs
description: Batches and landed costs for a retail business that receives stock on purchase orders in Cin7. Use when setting up batch tracking for a client, when a received line is missing its batch or serial number, when a proposed stock adjustment needs queuing, or when an owner asks where a landed cost stands.
---

# Batches and landed costs

Built from the Cin7 product pages and the platform map. No discovery calls describe this workflow yet, so the steps are
not yet confirmed by how owners do it. Check them against a first client before relying on them.

## What runs on its own
Three crons in `index.ts`, scheduled by `workflow.json`: `receive` records each purchase-order line once its order is fully
received, with the PO freight and surcharge. `batch-trace` records the serial or batch numbers on those lines and the stock
on hand. `adjust` queues any stock adjustment a person has proposed. They read and record only. Nothing changes stock in Cin7
until a person approves the queued adjustment in the CRM shell.

## Setting it up for a client
1. Fill `settings.json` from `settings.example.json`: the Cin7 branch, and the adjustment reason the owner wants on every change.
2. Confirm the client's Cin7 sign-in works with read access first (CIN7_USERNAME and CIN7_API_KEY from their secret store).
3. Confirm products that carry batches or serial numbers are set up that way in Cin7, so `batch-trace` has something to read.

## The judgment steps the agent does
- Landed cost: the cron records the cost pool (freight, surcharge) per purchase order. Spreading it across lines needs the
  owner's basis (by value, by quantity or by weight). Ask the owner which basis they use, then write the allocation as a
  proposal. Do not guess a basis.
- Partial receipts and condition: Cin7 does not show a line-by-line received quantity in the docs we have. A person checks
  quantity and condition against the paperwork.
- Stock proposals: write a proposal into the store with the barcode, the signed quantity and a reason. The `adjust` cron
  checks the barcode and queues it. A proposal with a bad barcode or quantity is rejected with its reason.

## Not covered
Trace from a batch to the customer it shipped to, quality holds, and reconciling stock value to purchase invoices: none of
these are in the docs we have. Fishbowl and Unleashed are not wired: Fishbowl has no operations file, and Unleashed needs a
sign-in signer the kit does not have yet.
