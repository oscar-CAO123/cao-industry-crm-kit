---
name: rostering
description: Builds rosters from demand and availability for a shift-based business, in Deputy. Use when setting up rostering for a client, when a demand block shows as short, or when an owner asks why a shift has not been published.
---

# Rostering

Works out who is free for each block of demand, drafts their shifts in Deputy as private drafts, and queues each publish for approval. Crons read and draft; a person approves every publish, because publishing tells staff.

## What runs on its own
Three crons in `index.ts`, scheduled by `workflow.json`. `sync` reads rosters, timesheets and swap requests and flags late
clock-ins. `draft` works out who is free for each demand block and drafts their shifts in Deputy as private drafts, which only
managers see. `publish` queues each unpublished draft for approval. Nothing is published by a cron. Publishing tells staff, so
every publish waits in the approval queue.

## Setting it up for a client
1. Run first-run discovery to confirm the client uses Deputy. Fill `settings.json` from `settings.example.json`: the operational
   unit, the windows to draft and publish, and the demand blocks (date, start, end, headcount).
2. Set `DEPUTY_ACCESS_TOKEN`, `DEPUTY_SUBDOMAIN` and `DEPUTY_REGION` in the client's own secret store.
3. Build demand blocks from the owner's budget or known headcount. The kit does not forecast demand.

## When a block is short
The draft cron records a shortfall when it cannot fill a block. Read the reason. Either the owner adds people, changes the
headcount, or fills the block by hand in Deputy. Re-running the draft does not double-book anyone.

## Before approving a publish
Check each draft in Deputy: the person, the times and the warnings. The kit does not check skills, minimum rest or award rules.

## Not covered yet
Sick calls and late changes, shift swap and leave approvals, availability as a rule for picking staff, and any platform other
than Deputy. See `gaps` in `workflow.json`.
