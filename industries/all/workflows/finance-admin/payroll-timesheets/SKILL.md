---
name: payroll-timesheets
description: Timesheets to a Xero Payroll run for a business that captures hours in Deputy or Xero. Use when setting up payroll for a client, when a person asks why a timesheet is not approved or a pay run is not drafted, or when a shift is held or marked needs-check.
---

# Payroll from timesheets

Turns timesheets into a payroll run: approved Deputy shifts become draft Xero Payroll timesheets, each person's timesheet is queued for approval once its shifts are clean, and a draft pay run is created in Xero with its posting queued for the owner. Crons read and draft only; no timesheet is approved, no pay run is posted and nobody is paid without a person's approval.

## What runs on its own
Three crons in `index.ts`, scheduled by `workflow.json`:
- `mirror` (every 30 minutes, Deputy only) reads approved Deputy shifts for the pay period and drafts them as lines on each
  person's Xero timesheet. A shift over the daily limit is held. A shift with an unclear write is marked needs-check.
- `approve` (hourly) queues each Draft Xero timesheet with hours for approval. It holds anyone with a held or unconfirmed shift.
- `pay-run` (every two hours) creates a DRAFT pay run in Xero once every timesheet in the period is approved, then queues its
  posting, with the net pay, for the owner.

Nothing here approves a timesheet, posts a pay run or pays anyone. Those are queued and wait for a person in the CRM shell.

## Setting it up for a client
1. Confirm where hours are captured. If Deputy, set `timesheets` to `deputy`. If Xero already holds the hours, set it to `xero`
   and the `mirror` cron does nothing.
2. Map each Deputy employee to their Xero employee id in `employee_map`. Anyone missing is skipped and counted, never guessed by name.
3. Set `earnings_rate_id` to the Xero earnings rate for ordinary hours, and `payroll_calendar_id` to the Xero calendar.
4. Set `pay_period` for the cycle being run. Update it each cycle.
5. Agree the daily limit with the owner (`max_hours_per_shift`, default 12).

## The judgment steps the person does
- Checking hours against rosters and client timesheets before approval. The cron holds only the shifts over the daily limit.
- Applying awards, allowances and pay rates in Xero and the time app. No cron changes pay rates.
- Reviewing the draft pay run in Xero before approving its posting. The queued approval shows the net pay; check it in Xero first.
- Clearing a shift marked needs-check after checking Xero. Do not rerun it blindly; it may already exist there.

## Things to know before the first run
- Run `approve` only after the period's shifts are approved in Deputy. Approval in Xero does not wait for `mirror`.
- Do not create a pay run by hand in Xero for the same period. This workflow cannot see one.
- Approvals are one per timesheet. A large casual roster means many approvals.

## Not covered yet
Collecting timesheets from photos, paper or email, job costing and allowances split across jobs, MYOB, Xero Payroll NZ and UK, and
any shift edited in Deputy after it was mirrored. See `workflow.json` gaps for the full list.
