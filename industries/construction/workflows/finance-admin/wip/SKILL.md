---
name: construction-wip
description: Work in progress, progress claims and retention for a construction business, with the billing kept in Xero. Use when setting up WIP tracking for a client, when a progress claim or a reminder is waiting for approval, or when an owner asks why a claim has not gone out.
---

# WIP and retention

Built from how 17 Australian construction businesses described WIP, progress claims and retention on discovery calls.
Most keep this by hand or in a spreadsheet, and invoicing and cost tracking take 20 or more hours a week.

## What runs on its own
Three crons in `index.ts`, scheduled by `workflow.json`:
- `wip-snapshot` (weekly) reads each job's authorised and paid invoices from Xero and compares them with the earned value.
- `progress-claim` (daily) drafts the next progress claim for each job whose claim interval has passed. It is a DRAFT invoice
  in Xero, with one approval queued to authorise it and email it to the client.
- `chase` (daily) queues the next reminder for an authorised invoice that is past due, at the days set in settings.

They read and draft only. Authorising a claim, emailing a claim, and emailing a reminder all wait for a person to approve them
in the CRM shell. Rejecting a queued reminder still counts as sent for the schedule.

## Setting it up for a client
1. Fill `settings.json` from `settings.example.json`: one entry per open job, with the client's Xero ContactID (a GUID, not a name),
   the contract value ex GST (signed contract plus accepted variations), the percent complete, and the claim interval.
2. Set retention per job if the contract holds it back. The claim records the retention it holds, and the owner nets it off when
   the client pays, because the Xero invoice carries the gross claim.
3. Confirm the sales account's default tax in Xero before the first claim is authorised.

## Judgment steps the agent does
- Set `percent_complete` from the owner's figures or the site report. The cron uses that number as it stands.
- Before the first claim goes out, check the progress claim draft in Xero against what the site says is done.
- Read the `wip-snapshot` rows as billing position only. A job that is over billed or under billed by the snapshot is a question
  for the owner. Cost to date is not read yet, so job margin is checked in the business's own system.
- Variations, job set-up and month-end close stay with the business. Record a variation in the contract value once it is accepted.

## Not covered
Buildxact, MYOB and SimPro: none has the operations this job needs in the kit yet, so WIP and claims there stay with the business.
Retention owed to subcontractors and retention release at completion. Cost to date and job margin. Custom reminder wording.
See `gaps` in `workflow.json` for the full list.
