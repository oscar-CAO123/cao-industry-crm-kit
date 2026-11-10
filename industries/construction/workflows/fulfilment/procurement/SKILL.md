---
name: construction-procurement
description: Trade and supplier quote replies to a checked scope, a draft Xero purchase order and a bill check, for a construction business that buys from trades and suppliers by email and Excel. Use when setting up procurement for a client, when a quote is flagged for missing scope, when an order-draft run parks a quote, or when an owner asks why a PO has not been drafted.
---

# Trade quotes miss scope

Logs trade and supplier quote replies, checks each one against the scope the business needs for that package, drafts the purchase order in Xero once the agreed amount is in the register, and checks supplier bills against that order. Crons read and draft; a person approves every email to a supplier and every purchase order award.

## What runs on its own
Four crons in `index.ts`, scheduled by `workflow.json`:
- `intake` logs each new quote reply from the buying mailbox to the quote register.
- `scope-check` compares each reply with the scope list for its package. A gap queues a clarification email to the supplier.
- `order-draft` drafts a purchase order in Xero for each complete quote that has an amount in the register, and queues its award.
- `bill-match` compares each supplier bill with its purchase order and writes matches and differences to the checks log.

They read and draft only. A clarification email and an award (setting the PO to AUTHORISED) wait for a person to approve them in the CRM shell.

## Setting it up for a client
1. Fill `settings.json` from `settings.example.json`: the buying mailbox, the quote register and checks workbook tables, and the scope list.
2. For each package the business buys, write the terms a complete quote must mention (trusses, fixings, crane, exclusions, allowances).
   The scope check is a keyword check against this list, so use the words the trades actually write.
3. Connect Xero and confirm each supplier has an email address on their Xero contact. Without one, order-draft parks the quote.

## Judgment steps the agent does
- Reading a plan or spec and writing the scope list for a package. This is not in the crons.
- Deciding whether an exclusion really changes the price, and what to ask the supplier.
- Typing the agreed amount ex GST into the register. order-draft will not draft a PO without it, so the owner or the agent sets it once the quote is agreed.
- Reading a flagged bill difference and deciding what happens next. Nothing is paid or changed by the crons.

## Not covered
Requests out to trades (sent by hand), Buildxact, Simpro, JackApp, Buildertrend, MYOB supplier quotes, goods receipt and delivery confirmation.
See `workflow.json` `gaps` for the full list and the reason for each.
