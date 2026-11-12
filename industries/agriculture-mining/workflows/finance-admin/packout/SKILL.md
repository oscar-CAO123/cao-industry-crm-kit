---
name: agriculture-mining-grower-statements
description: Pack-out to grower statement and grower payment in Xero, for a packhouse, grain receival or agricultural pool business. Use when setting up grower statements for a client, when a pack-out is held, or when an owner asks why a grower has not been paid.
---

# Grower statements

Docs-only. The steps come from the job description and the vendor docs. Xero is the only platform with any mapping, and its guides cover only the payment side.

## What runs on its own
Two crons in `index.ts`, scheduled by `workflow.json`: `statement` checks each new pack-out against the grower's supplier bill in
Xero, drafts the statement in the store, and queues the grower payment for approval. `reconcile` marks a grower paid once the approved
payment has gone through and Xero shows the bill paid. They read and draft only. No payment leaves the business without a person
approving it in the CRM shell.

## Setting it up for a client
1. Fill `settings.json` from `settings.example.json`: the business name and the Xero code of the bank account payments leave from.
2. Confirm each grower has a Xero contact and one supplier bill per statement period, and note the bill's id.
3. Record each pack-out in the store as a `packouts` record: grower name, Xero contact id, bill id, period end, gross pack-out value
   ex GST, and each charge (packing, freight, levies) as a positive amount.

## When a pack-out is held
The statement cron holds a pack-out it cannot check and writes the reason on it. Read the reason and fix the record:
- The bill is not AUTHORISED or is not a supplier bill: check the bill in Xero.
- Xero owes less than the net: the bill is short, or the charges are wrong. Check the pack-out before paying.
- A bad id or number: correct the record and set its status back to `new`.

The grower's questions and disputes stay with the business. Nothing in this skill answers them.

## Not covered yet
Packhouse intake, grading, rejects, pack-out totals, pool pricing and statement approval have no platform here. Sending the
statement to the grower is not wired. A grower owed across several bills is held until the bill is split by hand.
