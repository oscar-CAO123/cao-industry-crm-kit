---
name: construction-costs-watch
description: Watches the cost of a construction job against its budget in Xero. Use with the costs workflow (construction:costs) when a person asks why a job is over budget, what is committed or spent on an account, or which timesheets still need approving.
---

# Costs blow out unseen

## What runs on its own

- **budget-watch** (daily, 22:00 UTC): reads the Xero budget lines for the period in settings and keeps them as the baseline.
- **spend-watch** (every two hours): adds open purchase orders (committed) and authorised or paid bills (actual) for each account code, then records every code whose total is over budget.
- **timesheet-approval** (hourly, quarter past): reads timesheets still in Draft in Xero payroll and queues each one for approval.

Nothing here sends, pays or approves. The timesheet approvals sit in the CRM shell until a person approves them.

## Setup

- Set the Xero keys by name in the secret store: XERO_CLIENT_ID, XERO_CLIENT_SECRET, XERO_TENANT_ID, XERO_REFRESH_TOKEN. Values never go in files or logs.
- Copy `settings.example.json` and set the budget period and the overrun tolerance.
- Writes need KIT_ALLOW_WRITES=1 on the deploy. The crons run with reads only until a timesheet is approved.

## Judgment steps for the agent

- Read the flagged spend records and say which account codes are over, by how much, and whether the cause is committed cost or bills.
- Ask the owner which job each over-budget code belongs to, since the check is per account code across the business.
- Do not decide on a variation or a supplier hold. Hand those to the owner.

## Not covered

- Per-job figures (needs job tracking on bills and orders).
- Client claims, progress claims, variations.
- Buildxact, MYOB and Fergus. See `workflow.json` gaps.
