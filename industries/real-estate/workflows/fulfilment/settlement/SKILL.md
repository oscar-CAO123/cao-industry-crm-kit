---
name: settlement-dates
description: Keeps each real estate matter's settlement date in one place. The date the solicitors agree goes onto the Smokeball matter calendar, a typed date that disagrees is queued for a person, and the team gets a reminder before settlement. Use for the settlement workflow in real estate fulfilment.
---

# Settlement dates

## What runs on its own

Three crons, all in `index.ts`:

- `register` (every 30 minutes) reads the open matters and their settlement events. It reads only.
- `check` (every 30 minutes, on the 10 and 40 minute marks) compares each agreed date with the register. A matter with no settlement event gets one drafted on its calendar, once. A matter whose event has a different date gets a date change queued for approval. Nothing is written to a live record.
- `reminders` (daily) drafts one reminder per upcoming settlement event. It does nothing until `settings.reminder` is set.

## Setup

Copy `settings.example.json` to the client's settings and fill in:

- `settlement_subject`: the calendar subject the firm uses for settlements.
- `time_zone`: the IANA zone the firm's Smokeball uses.
- `reminder`: the offset type, its id and the staff ids to remind. Leave it empty to keep reminders off.

Smokeball's sign-in is unproven. Run a sandbox read before any live use.

## Judgment steps (the agent or a person does these)

- Read the signed contract or the solicitor's written confirmation. Write the agreed date (YYYY-MM-DD), its source and the matter id into the `agreed` store. Never write a date the source does not state.
- When the register shows two settlement events on one matter, a person picks the right one and removes the other in Smokeball. `check` leaves that matter alone until then.
- A person approves or rejects each queued date change in the CRM shell. A rejected change is not proposed again for the same date; write a new agreed date to try again.

## Not covered

Rex (no mapped operations). The solicitor mailbox and the conveyancer's own portal. Trust portal deposit requests. Cooling-off, finance and title dates. Only the settlement date is tracked.
