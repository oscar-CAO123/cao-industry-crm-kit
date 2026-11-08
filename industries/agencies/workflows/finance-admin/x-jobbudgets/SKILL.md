---
name: agencies-job-budgets
description: Keeps an agency's job budgets in view against spend in Xero Projects, and flags jobs heading over budget. Reads and drafts internal records only.
---

# Job budgets (agencies)

## What runs on its own
- Every 6 hours, the burn cron reads each Xero project's estimate, task and expense totals, and minutes logged, and keeps a snapshot.
- Every morning, the overrun cron flags any job that has spent 90 percent or more of its estimate.
- Nothing is written to Xero. Nothing is sent to a client.

## Setup
Connect Xero (read access to Projects). Set `overrun_pct` in settings if 90 percent is not the right warning point.

## Judgment steps the agent does
- Read the flagged jobs and say why each one is heading over: scope creep, a rate that was set too low, or time that was never logged.
- Draft the change request for a person to price and agree with the client. The agent never sets the price.
- Draft a client report for a person to send.

## Not covered
- Setting or approving budgets (a person does this in the budget tool).
- Harvest and Teamwork (no kit platform yet).
- Xero accounting budgets (not read yet).
- Creating jobs or assigning people.
- Pricing change requests and reforecasts.
