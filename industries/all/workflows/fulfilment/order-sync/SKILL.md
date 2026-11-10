---
name: all-order-sync
description: Sales and purchase orders from every channel into the stock system, production and accounts, for a trading or manufacturing business on Cin7 and Xero. Use when setting up order sync for a client, when a purchase order is waiting for approval, when a shipped order has no draft invoice, or when a supplier bill does not match its purchase order.
---

# Order sync

Brings sales orders from the stock system into one order book, queues a supplier purchase order when open orders need more stock than is available, drafts a Xero invoice for each shipped order, and matches supplier bills to purchase orders. Crons read and draft; a person approves every purchase order.

## What runs on its own
Four crons in `index.ts`, scheduled by `workflow.json`:
- `intake` reads sales orders changed in Cin7 into the order book.
- `stock-check` works out what open orders need, compares it with Cin7's available stock, and queues a purchase order for approval where stock is short.
- `invoice` drafts one Xero invoice per shipped order. The draft is never authorised or sent by the cron.
- `bill-match` matches authorised Xero supplier bills to Cin7 purchase orders by reference and records mismatches.

Nothing here sends, pays or changes a status a customer sees. A purchase order is only ever queued, and a person approves it
in the CRM shell.

## Setting it up for a client
1. Confirm which stock system and accounts system they use. This build assumes Cin7 and Xero. Unleashed is mapped but not yet wired.
2. Fill `settings.json` from `settings.example.json`. Each reorder rule needs the supplier's Cin7 contact id and an agreed price.
3. Set `KIT_ALLOW_WRITES=1` on the deploy. The Xero draft invoice is a write.
4. Run the sandbox checks listed in `workflow.json` gaps before the first live run.

## When a purchase order is waiting for approval
Check the product, the quantity and the supplier against the open orders it was raised for. If the figures look wrong, reject
it in the CRM shell and fix the reorder rule in settings. Do not approve a purchase order to clear the queue.

## When an order has no draft invoice
Read the order's `error` in the order book. A contact that already exists under the same name, or a line with a code Xero
does not know, needs a person. Fix it in Xero, then the next hourly run drafts the invoice.

## When a supplier bill does not match
The `matches` record says why: no purchase order carries the reference, the supplier differs, or the amount before tax differs.
A person decides whether to pay, hold or query it. The workflow never pays a bill.

## Not covered yet
Order checks (customer, terms, credit), production jobs, warehouse receiving, pick and pack, dispatch writes, returns and
refunds, and payment matching. Do these the business's usual way until the matching gaps in `workflow.json` are closed.
