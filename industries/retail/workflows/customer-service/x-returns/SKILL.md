---
name: retail-returns
description: Customer return requests for a retail business with its own warehouse, answered with the business's returns form, through its Gmail or Gorgias helpdesk. Use when setting up returns for a client, when a return reply is waiting for approval, or when an owner asks why a return has not been answered.
---

# Returns

Built from how retail businesses described handling returns on discovery calls. The owner gets a return request in the inbox,
emails back a returns form, the customer posts the item, and staff check it in, refund or exchange it, and restock it.

## What runs on its own
Two crons in `index.ts`, scheduled by `workflow.json`. `intake` reads new return requests from Gmail and from Gorgias.
`draft` queues the business's returns-form reply for each new request. Both read or draft only. A reply is sent, or posted on
a ticket, only after a person approves it in the CRM shell. Nothing in this skill changes that.

## Setting it up for a client
1. Fill `settings.json` from `settings.example.json`: the business name, where requests arrive (`google-workspace`, `gorgias`
   or both), the Gmail search that finds return requests, and the https link to the business's returns form or portal.
2. Confirm the Gmail mailbox is set as GOOGLE_MAILBOX in the secret store, and that Gorgias has its domain, email and API key.
3. Read the first few queued replies with the owner before approving any of them.

## What the staff do
- Decide the return: approve or decline it in the business's returns app or store admin.
- Issue the return label in the carrier or returns app.
- Check the item in when it arrives, and note its condition.
- Refund or exchange, and restock or write off the item in the store.
Each of these happens in the business's own system. This workflow does not do them.

## Not covered yet
Shopify and WooCommerce return steps, the Gorgias return apps, label creation, check-in, refund and restock.
Read `workflow.json` `gaps` for the reasons and what each one needs.
