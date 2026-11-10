---
name: construction-stock
description: Stock and materials for a construction business in Xero: reorder requests, draft purchase orders, award approvals and supplier bill checks. Use when setting up stock for a client, when a draft purchase order is waiting for approval, or when an owner asks why an item was not reordered.
---

# Stock

Keeps the materials a construction business buys in stock: reads stock on hand in Xero, drafts a purchase order for each item at or below its reorder level, queues the award for approval, and checks supplier bills against their purchase orders. Crons read and draft; a person approves every award.

## What runs on its own
Three crons in `index.ts`, scheduled by `workflow.json`:
- `stock-levels` reads stock on hand in Xero and raises a request for each reordered item at or below its level.
- `po-draft` drafts a purchase order in Xero for each new request (DRAFT, so nobody outside the business sees it) and queues the award for approval.
- `bill-match` compares each supplier bill with an authorised purchase order from the same supplier and logs the result.

They read and draft only. Setting a purchase order AUTHORISED is a live step and waits for a person to approve it in the CRM shell.

## Setting it up for a client
1. Run the first-run discovery skill to see which tools they use, then fill `settings.json` from `settings.example.json`.
2. Set a reorder rule for each item the business reorders: the Xero item code, the level, the quantity to order, and the supplier's email.
   Items without a rule are never reordered.
3. Check that the supplier's email matches a contact in Xero. A request whose supplier has no contact is skipped, not guessed.

## Judgment steps the agent does
- Counts kept outside Xero (yard sheets, van stock, spreadsheets) are not read by the crons. Enter them in Xero first, or record them for the owner.
- Deciding whether a pending award is still needed. If an item came back above its level, the stock check closes its request;
  reject the award in the shell if it is no longer wanted.
- Clearing a skipped request. Read the reason it carries, fix the cause (a unit price, a supplier contact, or the award), then clear it by hand.

## Not covered
Sending a purchase order to the supplier, allocating materials to a job, receiving deliveries, and any stock held in Buildxact, MYOB or ServiceM8.
Do these the business's usual way. The stock check and bill check still run on what is in Xero.
