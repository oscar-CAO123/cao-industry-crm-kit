---
name: data-sync
description: Keeps Xero and HubSpot in step so a business types each contact and supplier bill once. Use when setting up data sync for a client, when a HubSpot company has no Xero contact, when a supplier bill is waiting in Xero as a draft, or when an owner asks why a record did not sync.
---

# Data sync

Built from how 36 Australian businesses described keeping their systems in step on discovery calls. Most re-type the same
contact, order or bill into a second system, and the owner checks it by hand.

## What runs on its own
Three crons in `index.ts`, scheduled by `workflow.json`:
- `contacts` (every 30 minutes) mirrors active Xero contacts changed since the last run into HubSpot companies, matched on the Xero ContactID.
- `new-companies` (hourly) gives each HubSpot company with no Xero contact one in Xero. An exact name match is reused. An unclear match
  (two exact names) is left for a person. The new ContactID is written back to HubSpot.
- `bills` (hourly, only when `sync_bills` is on) queues each supplier bill still in DRAFT in Xero for approval.

The first two only write internal records. `bills` only queues. Nothing is paid, and nothing is authorised, until a person approves it.

## Setting it up for a client
1. Confirm the Xero connection (client id, secret, tenant id, refresh token) and the HubSpot private app token are in the secret store.
2. In HubSpot, create a unique company property for the Xero ContactID (the example name is `xero_contact_id`). Set it in
   `settings.hubspot.idProperty`. The workflow does not create it.
3. Fill `settings.json` from `settings.example.json`. Turn on `sync_bills` only when the owner wants bills queued for approval.
4. Run each cron once by hand against the client's sandbox, then against the live account, and check the first batch with the owner.

## When a record did not sync
- No HubSpot company for a Xero contact: check the contact is ACTIVE in Xero. Archived contacts are not mirrored.
- A company stays without a Xero contact: the name matched two Xero contacts, or the name is empty. Look at both in Xero and fix the
  duplicate or the name. The workflow never picks one of two.
- A bill is not in the queue: it is not a draft in Xero, or it is not a supplier bill (ACCPAY). Bills that arrive by another route
  are not read.

## Judgment steps the agent does
- Deciding whether two near-matching names are the same business. The workflow does exact matches only.
- Deciding whether a queued bill should be authorised. The owner decides in the approval queue.

## Not covered
Intake from email, PDFs or paper dockets; HubSpot edits flowing back to Xero; payment reconciliation; validation rules; duplicate checks
beyond an exact name match; Make, Microsoft 365, ServiceM8, Simpro and the other systems in the calls. Every adapter is docs-only until a
Xero demo company and a HubSpot test portal prove the request shapes on a live account.
