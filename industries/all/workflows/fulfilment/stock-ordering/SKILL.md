---
name: all-stock-ordering
description: Stock on hand checked against each item's minimum, with a draft supplier purchase order in Xero when an item runs low. Use when setting up stock ordering for a client, when a reorder is missing, or when an owner asks why a purchase order has not gone out.
---

# Stock ordering

Built from how 40 Australian businesses described stock ordering on discovery calls. Most owners count stock, spot a low item
and raise the purchase order by hand, often in a spreadsheet or a stock system, and chase the delivery themselves. This workflow
does the checking and the drafting. The owner still decides what to buy and sends it.

## What runs on its own
Three crons in `index.ts`, scheduled by `workflow.json`: `stock-check` reads stock on hand for each item the owner reorders,
`reorder-draft` drafts a purchase order in Xero for any item at or below its minimum and queues its authorisation for approval,
and `po-check` reads each open order's status and flags the ones past their delivery date.
They read and draft only. A DRAFT purchase order reaches nobody. Authorising one is queued, and it runs only when a person approves it.

## Setting it up for a client
1. Confirm the client's stock sits in Xero, with the items tracked as inventory. Fill `settings.json` from `settings.example.json`:
   the business name, `delivery_days`, and one rule per item with its minimum, its maximum and the supplier's Xero contact ID.
2. Agree the minimum and maximum with the owner. The workflow orders the top-up to the maximum.
3. Run one `stock-check` by hand and read the result. An item listed as missing is not tracked as inventory in Xero.

## When a reorder is missing
Check the stock snapshot for the item first. A reorder is only drafted when the item is at or below its minimum, has a purchase
price in Xero, and has no open order. An open order for the item blocks a new one until it is billed or deleted. Read the
`reorder-draft` run log before re-running.

## Judgment the owner or agent does
- Choose the minimum and maximum, and any supplier, for each item.
- Check a drafted order's quantity and price before approving it.
- Send the authorised purchase order to the supplier. The workflow does not email it.
- Decide what to do with an overdue order: chase the supplier, or cancel it in Xero.

## Not covered yet
Demand forecasting from sales history, supplier confirmation, matching supplier bills to orders, returns and credits, and
any stock system other than Xero (Unleashed, Cin7 Core, Fishbowl, Ordermentum). Do these the business's usual way.
