---
name: health-care-rebates
description: Finds missed Medicare, DVA and health fund rebates in a clinic's practice system and ledger, and lists them for a person to check. Use when setting up the rebates finder for a clinic, when the flag list has rows to check, or when an owner asks why a rebate has not been paid.
---

# Missed rebates finder

Finds Medicare, DVA and health fund rebates a clinic has not been paid, from its practice system and its ledger, and lists them for a person to check. Crons read and list only; nothing is lodged, chased or changed.

## What runs on its own
Two crons in `index.ts`. `pull` (every 6 hours) reads invoices and their items from Cliniko and payments from Xero.
`flag` (daily) lists open invoices with a rebate item, older than the review window, that Xero shows no payment against.
Both only read. The flag list is a register in this workflow's store. Nothing is lodged, chased, sent or changed.

## Setting it up for a clinic
1. Fill `settings.json` from `settings.example.json`: the business name, the item codes that carry rebates, and how long
   an open invoice may sit before it is listed.
2. Ask the clinic which item codes it uses for Medicare, DVA and health fund rebate items. Only those codes are checked.
3. Confirm the clinic's Xero invoice numbers match its Cliniko invoice numbers before trusting the flag list.

## When a row is listed
Open the claim in Cliniko. Check whether a Medicare, DVA or health fund claim was lodged for that invoice, and whether it
was paid. Claim status is not in the API, so this check is a person's job. If the claim was never lodged, the clinic lodges
it through its usual route (Tyro Health or HiCaps). Then mark the row in the store or the CRM shell.

## Not covered
Lodging claims, chasing payers, eligibility and rebate rule checks, and HiCaps. Each needs a mapped operation before it can
join this workflow. See `gaps` in `workflow.json`.
