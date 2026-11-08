---
name: safety-forms
description: Safety checklists, incident reports and corrective actions for a construction or trade business that keeps them in SiteBook. Use when setting up the safety-forms workflow for a client, when an incident or checklist report has not appeared in the register, or when an owner asks why a corrective action has not been chased.
---

# Safety forms, inspections and incident reports

Built from how 14 Australian businesses described their safety paperwork on discovery calls: 9 by hand or with no tool named,
4 with a safety template subscription and Dropbox, 1 with a spreadsheet. Of the platforms the evidence names, only SiteBook has
mapped operations in the kit, so the crons run there. Everything else is judgment or manual, listed in `workflow.json` under gaps.

## What runs on its own
Three crons in `index.ts`, scheduled by `workflow.json`:
- `incidents` (every 30 minutes) generates each open incident's report inside SiteBook, once.
- `checklists` (hourly) generates each completed checklist's report inside SiteBook, once.
- `actions` (each morning) queues a chase email to the recipient of each overdue corrective action, at most once a week.

The first two only read and generate reports into SiteBook's own register. The third queues. Nothing is emailed until a person
approves it in the CRM shell.

## Setting it up for a client
1. Confirm the SiteBook API key is in the client's secret store as `SITEBOOK_API_KEY`. Confirm the key is for their own company.
2. Fill `settings.json` from `settings.example.json`: the job to limit reads to (or leave empty for all jobs), the lookback
   window for checklists, and the email template for chase emails (or leave empty for SiteBook's default).
3. Check the crons on the first run with the owner present. Read the approval summaries before approving any chase.

## The judgment steps the agent does
- Pre-start checks and toolbox talks: the crew runs these in SiteBook. Creating them from this workflow waits for a confirmed
  SiteBook request schema.
- Incident triage: a person decides whether an incident is a notifiable event. A notifiable incident goes to the regulator
  by hand; nothing in this workflow submits to a regulator.
- SWMS review: read the SWMS templates in SiteBook when the owner asks, and check each against its last review date by hand.

## Not covered yet
Creating incidents, checklists, sign-offs and SWMS; checklist report emails to a recipient; Procore and Sitemate (no operations
in the kit); Dropbox and Microsoft 365 filing. See `workflow.json` gaps for the full list.
