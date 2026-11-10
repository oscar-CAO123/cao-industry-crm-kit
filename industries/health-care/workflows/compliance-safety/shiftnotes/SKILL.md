---
name: shiftnotes
description: Shift note reader for health-care support work. Reads the shift notes carers and support workers write, checks each against the points a note must cover, and leaves a review comment for the supervisor on any note that misses one. Read and draft only; nothing reaches a worker or client.
---

# Shift note reader

## What runs on its own
- **collect** (every 15 minutes): reads the recent timesheets from Deputy and keeps each new shift note that has text. A timesheet with an empty note or a bad id is skipped.
- **check** (hourly): checks each new note for the points in `settings.checks` and the minimum word count. A note that misses one gets one review comment on its timesheet, which only the supervisor sees. A note that passes is marked ok and gets no comment.

Neither cron sends anything to a worker, client, GP or plan manager. No live operation is mapped yet.

## Setup
1. Copy `settings.example.json` to the business's settings and set `business_name`, `lookback_days`, `min_words` and `checks`.
2. Set the Deputy environment variables: `DEPUTY_ACCESS_TOKEN`, `DEPUTY_SUBDOMAIN`, `DEPUTY_REGION`. Writes stay off until `KIT_ALLOW_WRITES=1` is set on the deploy.

## Judgment steps (the agent, not the crons)
- Reading a flagged note and deciding whether the gap matters, or whether a concern needs escalating.
- Deciding what a supervisor should ask the worker. The crons never write to the worker.
- Any incident, medication or client-update step: these stay with the worker and the coordinator. See `gaps` in `workflow.json`.

## Not covered
- ShiftCare: no adapter, no mapped operations.
- Sending a note back to the worker, incident records, medication logs, handover, client or family updates, and timesheet billing.
- Regulator or funder compliance. The check is keyword matching for the points in settings.
