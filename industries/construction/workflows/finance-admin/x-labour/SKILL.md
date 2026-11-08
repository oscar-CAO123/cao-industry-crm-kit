---
name: construction-labour-by-person
description: Labour by person for a construction business that clocks crews on in ServiceM8 and runs payroll in Xero. Use when setting this up for a client, when a person asks why a timesheet is not approved, or when a person is held or a shift is marked needs-check.
---

# Labour by person

Built from how 40 Australian construction businesses described tracking labour by person on discovery calls. Crews clock on and
off in a time app, hours are split across jobs, checked, approved, costed and paid. Most of it is manual.

## What runs on its own
Two crons in `index.ts`, scheduled by `workflow.json`:
- `mirror` (every 30 minutes) reads ServiceM8 clock-on, clock-off and lunch events for the pay period and drafts each complete
  shift as a line on that person's Xero Payroll AU timesheet. A shift over the daily limit is held. A person still clocked on, or
  with clock events that do not pair, is held from approval.
- `approve` (hourly) queues each Draft Xero timesheet with hours for approval, except held people.

Nothing here approves a timesheet or pays anyone. Approvals are queued and wait for a person in the CRM shell.

## Setting it up for a client
1. Confirm the crew clock in ServiceM8. If hours live somewhere else, this workflow does not apply.
2. Map each ServiceM8 staff member to their Xero employee id in `employee_map`. Anyone missing is skipped and counted, never guessed by name.
3. Set `earnings_rate_id` to the Xero earnings rate for ordinary hours, and `payroll_calendar_id` to the Xero calendar.
4. Set `pay_period` for the cycle being run. Update it each cycle.
5. Agree the daily limit with the owner (`max_hours_per_shift`, default 12).

## The judgment steps the person does
- Splitting hours across jobs and checking them against the labour budget. This workflow does not allocate hours to jobs.
- Applying labour rates, loadings and allowances in Xero and ServiceM8. No cron changes pay rates.
- Clearing a held person after checking their clock events in ServiceM8. Do not rerun a needs-check shift blindly; it may already exist in Xero.
- Reviewing the timesheet hours in Xero before approving the queued approval.

## Things to know before the first run
- Run `approve` only after `mirror` has run for the period. Until it has, `approve` queues nothing.
- Anyone who clocked on before the pay period starts is held until someone checks, because the start falls outside the read window.

## Not covered yet
Job costing, client claims, subcontractor hours, paper or photo timesheets, Deputy, Procore and Simpro. See `workflow.json` gaps for the full list.
