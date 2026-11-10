---
name: automotive-ppsr
description: PPSR checks and registrations for a dealership. Use when setting up the PPSR check register for a dealer, when the register cron reports vehicles not added, or when an owner asks why a digest did not go out or which searches are still to run.
---

# Run PPSR checks and manage registrations

Run PPSR checks and manage registrations for a dealership: each stock vehicle is added to the dealer's own PPSR check register as a search to run, and a daily digest of searches and discharges due is drafted and queued for a person to approve. The PPSR searches and registrations themselves are run by a person on the PPSR site; no platform in the kit runs them yet.

## What runs on its own
Two crons in `index.ts`, scheduled by `workflow.json`:
- `register` adds each stock vehicle with no check row yet to the dealer's own PPSR check register, status To search.
- `digest` drafts one email to the compliance contact listing searches to run and discharges due, and queues its send
  for approval. No digest is drafted on an empty day or twice in a day.

They read and draft only. The send waits for a person to approve it. Nothing here runs a PPSR search or lodges anything.

## Setting it up for a dealer
1. Fill `settings.json` from `settings.example.json`: the Excel workbook item ids for the stock list and the check register,
   the dealer's mailbox, and the compliance contact.
2. Make the stock table columns VIN | Rego | Stock no | Received, and the check register columns Date added | VIN | Rego |
   Stock no | Status | Searched on | Ref | Notes, in that order.
3. Confirm with the dealer which vehicles need a search before sale or handover.

## The judgment steps a person does
- Run each To search row on the PPSR site: a VIN search for a motor vehicle, or a grantor search when a serial search is not
  possible. Record the result in the row: status, searched on, certificate reference.
- Read the search certificate. The register shows registered interests and NEVDIS written-off or stolen data where available.
  The owner decides whether to buy, hold or ask the seller. The skill does not.
- Set Discharge due when a security interest has ended. Discharge is due within 5 business days. A person lodges it.
- For NSW vehicle registration checks and renewals, use the Service NSW pages directly. No platform in the kit covers them.

## Not covered
PPSR searches, registrations, amendments and discharges through the PPSR site or its B2G channel; NSW dealer lodgements and
transfers; transport authority lodgements in any state; a dealer-system feed into the register; lender payout figures.
See `workflow.json` gaps.
