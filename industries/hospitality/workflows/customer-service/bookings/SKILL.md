---
name: hospitality-bookings
description: Bookings kept in a spreadsheet, checked against the venue's Google calendar, for an activity or party venue. Use when setting up bookings for a client, when a booking row is marked Check or Clash, or when an owner asks why booked revenue or a calendar hold looks wrong.
---

# Bookings in spreadsheets

Built from 7 hospitality discovery calls about bookings. The spreadsheet is the record, and the venue calendar is the room check.

## What runs on its own
Two crons in `index.ts`. `hold` runs every 15 minutes. For each row marked Enquiry it checks the calendar. If the time is free, it puts an opaque hold on the calendar with no guests invited, then writes Held and the event id back. If the time is busy, it marks the row Clash.

`changes` runs daily. It logs each booked-value change once to the Changes tab. It also queues a calendar move for a row marked Moved, and a calendar removal for a row marked Cancelled. Nothing reaches a guest. A person approves the queued calendar changes in the CRM shell.

## Setting it up for a client
1. Create the Bookings tab with these headers in row 1, columns A to J, in this order: Guest, Headcount, Start, End, Booked value, Original value, Logged value, Status, Event ID, Note.
2. Create a Changes tab with these headers: Date, Guest, Original value, Was logged, Now booked, Change.
3. Fill `settings.json` from `settings.example.json`: the spreadsheet id, the venue calendar (an email address or primary), and the timezone.
4. Write Start and End with an offset, for example 2026-12-05T18:00:00+11:00. Status words must match the list above.

## Judgment steps
- Clash: the calendar is busy at that time. Talk to the owner. Offer another time, then change Start and End and set Status back to Enquiry.
- Check: read the Note, fix the row or the calendar by hand, then set Status to Enquiry (to hold again) or Held.
- Holding: the hold may or may not exist. Check the calendar, then set Enquiry or Held.
- Moved: set the new Start and End and set Status to Moved. The calendar move waits in approvals.
- Cancelled: set Status to Cancelled. The calendar removal waits in approvals.
- Money received on the day that differs from the booked value: the owner decides. The Changes tab shows the difference.

## Not covered
Roller, BigQuery, Excel workbooks, guest confirmations and reminders, deposits, pre-orders, seating, day sheets and waitlists. See `gaps` in `workflow.json`.
