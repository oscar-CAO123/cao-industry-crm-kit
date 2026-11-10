---
name: professional-services-add-missingdocs
description: Missing documents for an accounting practice's clients in Xero. Use when setting up the missing documents finder for a client, when a client asks why they were chased, or when the scan list looks wrong.
---

# Missing documents finder

Finds the bank transactions and bills in an accounting practice's Xero file that have no document attached, lists them by client, and drafts one chase email per client for approval. Crons read and draft; a person approves every email before it leaves.

## What runs on its own
Two crons in `index.ts`, scheduled by `workflow.json`:
- `scan` (every 6 hours) reads Xero for authorised bank transactions and bills with no attachment in the lookback, and keeps the list.
- `chase` (daily) drafts one Outlook email per client with missing items, when a chase is due: first at once, then 7 and 14 days later.

They read and draft only. Every chase email waits for a person to approve it in the CRM shell. Nothing here marks a
document as received or changes a Xero record.

## Setting it up for a client
1. Fill `settings.json` from `settings.example.json`: the practice's name, its mailbox for chase emails, the client's own email address (`client_email`), and the lookback.
2. Chase emails go only to `client_email`. A missing or invalid address stops the chase cron. Nothing is ever sent to a supplier or customer on a Xero item.
3. Agree the reminder days with the practice (`chase_after_days`).

## When the list looks wrong
- An item that should not need a document (bank fees, transfers, small cash) stays on the list until the practice
  attaches something or clears it in Xero. Tell the practice which items to ignore; do not remove them by hand.
- Nothing listed for a client who is clearly missing items: check the bank feed in Xero first (not checked by this workflow).
- A chase went out that should not have: it was approved, so it was sent. Nothing is resent without a person.

## What is not covered
Dext and its missing paperwork report, Dext's missing period alerts, bank feed health, the Xero Files inbox, client
portals and document requests in other systems. Judgment on whether an item needs a document stays with the accountant.
