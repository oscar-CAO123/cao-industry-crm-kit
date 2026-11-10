---
name: scheduling-dispatch
description: Schedules and dispatches jobs to field crews in the business's own software (ServiceM8). Use when setting up scheduling for a client, when a job is stuck with no crew or reported as no-capacity, or when an owner asks why a client has not had a visit text.
---

# Scheduling and dispatch

Schedules and dispatches jobs to field crews: gives each open job the earliest day a crew member has room, drafts the allocation and the crew note in the business's own system, and queues the client's visit text for approval. Crons read and draft; a person approves every client message.

## What runs on its own
Three crons in `index.ts`, scheduled by `workflow.json`:
- `intake` reads open Work Order jobs that have no crew yet.
- `allocate` gives each waiting job the earliest day a crew member has room (fewest jobs that day, within the daily limit),
  drafts the allocation in ServiceM8, and drafts a note to that crew member.
- `notify` queues the client's visit text for each upcoming allocation.

The crons never text or email anyone. The client text waits in the CRM shell until a person approves it.
Crew allocations and notes are internal drafts, so the office can move a job to another person in ServiceM8 before
the client is told.

## Setting it up for a client
1. Fill `settings.json` from `settings.example.json`: the crew (ServiceM8 staff ids), the office user the notes come from,
   the daily limit per crew member, how far ahead to look, and whether weekends count.
2. Confirm each crew member is active in ServiceM8 and that clients have a mobile on their contact record in the 04xx format.
3. Run `intake` and `allocate` once by hand against the sandbox account before turning on the schedules.

## When a job is marked no-capacity
Nobody in the crew has room in the look-ahead window. Either widen `horizon_days`, raise `max_jobs_per_crew_day`,
or put the job on a person's list. Do not draft a booking by hand to get around it; a manual allocation in ServiceM8 is
picked up by the next `allocate` run.

## Judgment steps the office does
- Routes and vehicles: group jobs by suburb and assign vans or tools in ServiceM8. The crons do neither.
- Leave and sick days: the crons do not read them. Move the job before the client is texted.
- Overruns, same-day changes and reschedules: handle them in ServiceM8, then tell the client by hand.
- Approve or reject each client text in the CRM shell. A rejected text is not sent again by the crons.

## Not covered yet
Deputy and other rostering (no adapter), Tradify, route planning, vehicles and equipment, client self-booking,
on-the-day swaps, and timesheet checks. Each one is listed in `workflow.json` under `gaps`.
