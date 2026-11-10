---
name: financial-services-settlement-tracker
description: Tracks loan settlements for a broker or lending business: which files lack a lender confirmation, a file note or a settlement date, and which are past their date with post-settlement checks open. Use when setting up settlement tracking for a client, or when an owner asks why a settlement is flagged.
---

# Settlement tracker

Tracks each loan from lender confirmation to settlement and the checks after it, lists what is missing from each file, and flags settlements that are past their date with checks still open. The crons read the settlement records and write internal checklists only; nothing reaches a lender, client, broker or bank.

## What runs on its own
Two crons in `index.ts`, scheduled by `workflow.json`. `checklist` writes one checklist per settlement record every 30 minutes.
`overdue` lists the settlements past their date with checks still open, once a day. Both read the workflow store and write
internal records only. No platform is called, and nothing is sent, paid or changed in a live system.

## Setting it up for a client
1. Fill `settings.json` from `settings.example.json`: business name and how many days after settlement a file counts as overdue.
2. Record each settlement in the workflow store with `id`, `borrower`, `lender`, `settlement_date` (YYYY-MM-DD, optional),
   `lender_confirmed`, `file_notes` and `post_settlement_checks`. Until an intake adapter exists, a person or the agent does this.
3. Records that fail validation are skipped and counted, never written to a checklist.

## The judgment steps the admin does
- Chase the lender for confirmation, and the bank for settlement instructions. The crons cannot do this.
- Write the file note. The checklist only flags that it is missing.
- Run the post-settlement checks (discharge, commission, trust) and close the file.
- Move information from sales and credit onto the file before it reaches post-settlement.

## Not covered yet
No platform is mapped for settlements. brokerengine has no mapped operations, and Xero has none for loan settlement. There is no
client, broker or solicitor reminder, no lender or bank chase, and no intake from any system. Those wait for an adapter and a
sandbox account.
