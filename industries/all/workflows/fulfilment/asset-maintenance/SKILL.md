---
name: asset-maintenance
description: Tracks equipment, vehicles and machinery from Trackunit and turns planned services and failed inspections into Work Order jobs in ServiceM8. Use when setting up asset maintenance for a client, when a service is missing from the job board, or when an owner asks why an overdue reminder has not gone out.
---

# Asset maintenance

Built from 15 discovery calls that describe how the caller services equipment, vehicles and machinery.
The calls mostly describe manual servicing: spreadsheets, WhatsApp photos and phone bookings. This build covers the parts a
telematics platform and a job board can do: the register, the planned services that are due, failed inspection checks,
and a reminder for an overdue service.

## What runs on its own
Three crons in `index.ts`, scheduled by `workflow.json`:
- `register` refreshes the visible asset register from Trackunit.
- `service-due` drafts one Work Order job in ServiceM8 for each planned service that is overdue or due within the window.
  It queues one reminder email for each overdue service.
- `defects` drafts one Work Order job for each failed inspection response from the last two hours.

Work Order jobs go to the scheduling-dispatch workflow, which allocates them to a crew. The crons never email anyone.
The overdue reminder waits in the CRM shell until a person approves it.

## Setting it up for a client
1. Fill `settings.json` from `settings.example.json`: the depot address for jobs, the internal address for reminders,
   the service window in days, and how many assets to read.
2. Confirm Trackunit shows the assets the client wants tracked, with their service plans assigned in Trackunit.
   Plans are set up in Trackunit, not here.
3. Run `register` and `service-due` once by hand against a sandbox account before turning the schedules on.

## When a service is missing from the job board
Check the planned service status in Trackunit first. A service the platform already shows as booked is skipped on purpose.
If it is due but no job exists, check the cron log for the asset: a missing asset usually means it is hidden in Trackunit.
Do not draft a job by hand to get around it; a manual job in ServiceM8 is fine once the owner has decided on it.

## Judgment steps for the office
- Taking a vehicle or machine out of service after a critical defect. The cron opens the job; a person decides.
- Choosing a workshop, booking an outside service, and ordering parts. None of this is automated.
- Signing off a service so the asset returns to work. The office records that in ServiceM8.

## Not covered yet
MEX CMMS and other CMMS platforms (no mapped operations), operating hours and fuel logging, GPS location, parts orders,
compliance renewals, decommissioning and service history records. See `gaps` in `workflow.json`.
