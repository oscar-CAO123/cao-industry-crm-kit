---
name: agriculture-mining-market-forecasting
description: Forecasts demand and prices for a primary producer or packer (logs, timber, grain, potatoes, garlic) from its own Xero invoice history, price list and buyer enquiries. Use when setting up forecasting for a client, when the monthly forecast summary has not arrived, or when an owner asks why a price move was flagged.
---

# Market forecasting

Forecasts how much of each product the business will sell and what it can charge, from its own invoice history, its price list and buyer enquiries, so the owner can decide what to sell, pack and store. Crons read and draft; the monthly summary is sent only when a person approves it.

## What runs on its own
Three crons in `index.ts`, scheduled by `workflow.json`: `demand-signal` reads sales invoices from Xero and buyer enquiries
from the Outlook folder, `price-watch` compares list prices with the last price invoiced, and `forecast` runs on the 1st of
each month to write one register row per item and draft one summary email to the owner. They read and draft only. The
summary email is sent only when a person approves it. Nothing in this skill changes that.

## Setting it up for a client
1. Fill `settings.json` from `settings.example.json`: the owner's address for the summary, the mailbox that receives buyer
   enquiries, the Excel price list and register (if they keep them), and the trailing months to average.
2. Confirm the Xero sales invoices are authorised, not drafts, and that each product is an item with a sales price.
3. Agree the alert level for price moves with the owner (5 percent is the default).

## What the owner decides
The cron forecast is a trailing average of what was invoiced. The owner adjusts it for the season, the weather, the crop, and
what buyers have said on the phone. Stock and pack decisions belong to the owner. Note the adjustment on the register row
or in a reply, never by editing the cron's numbers.

## When a price move is flagged
A list price more than the alert level away from the last price invoiced appears in the summary under "Price moves to
check". Check whether the list price changed on purpose (a new season, a new buyer contract) before anyone quotes it. Only
then change the price list.

## Not covered yet
Supply estimates from the packing whiteboard or stock counts, buyer and retailer portals, phone price negotiations, scenario
checks and forecast accuracy review. Do these the usual way. Record the result in the register so the forecast log stays
complete.
