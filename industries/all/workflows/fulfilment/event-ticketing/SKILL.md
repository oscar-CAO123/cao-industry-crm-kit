---
name: event-ticketing
description: Ticketed events in Eventbrite, from setup to wrap-up: publishing waits for approval, the register stays current, and each event gets a drafted run sheet and wrap-up counts. Use when setting up event ticketing for a client, when an event is not publishing, or when an owner asks why a register or run sheet is out of date.
---

# Event ticketing

Runs ticketed events on Eventbrite. Queues publishing for events that are ready (a person approves each one), keeps the registration list current, and drafts each event's run sheet and wrap-up counts. Venue hire, suppliers and catering stay with the business and are not automated here.

## What runs on its own
Four crons in `index.ts`, scheduled by `workflow.json`:
- `setup` (hourly) reads each event in `event_ids`. An event still in draft with a ticket type and a venue, or an online event, is
  queued to publish. It is never published without approval, and nothing is queued unless `publish_when_ready` is true.
- `registrations` (every 30 minutes) reads attendees changed since the last run and keeps the register in the workflow store.
  Email addresses are not kept.
- `run-day` (daily) drafts a run sheet for each event starting within `run_sheet_days_ahead` days: times, check-in teams and team sizes.
- `wrap-up` (daily) drafts counts per ticket type for each event that has ended: sold, checked in, cancelled and refunded.

The crons read and draft only. The one thing that changes what a buyer sees, publishing, waits for a person to approve it.

## Setting it up for a client
1. Confirm which Eventbrite account the events sit in, then fill `settings.json` from `settings.example.json`: the event ids,
   the timezone for run sheets, and whether ready events should be queued to publish.
2. Set `EVENTBRITE_TOKEN` from the client's own Eventbrite account. Do not use another client's token.
3. Run the first pass with `publish_when_ready` false. Check the `setup` log for each event's status before turning publishing on.

## When an event is not publishing
`setup` logs what is missing: a ticket type or a venue. Add it in Eventbrite, and the next hourly run queues the publish. Eventbrite
can also refuse a publish (for example, paid tickets with no payment set up). That shows as a failed approval with Eventbrite's
reason, and the business fixes it in Eventbrite.

## When the register looks wrong
The register reads one page of attendees per event. An event with more attendees than one page is incomplete, and the log says so.
Until the kit can page through, check that event's full list in Eventbrite before relying on the register.

## Not covered yet
Venue hire, supplier and catering orders, promotion, reminders, thank-you messages, surveys, refunds, and the Eventbrite check-in
scanner. Do these the business's usual way. Humanitix and Moshtix have no mapped operations in the kit.
