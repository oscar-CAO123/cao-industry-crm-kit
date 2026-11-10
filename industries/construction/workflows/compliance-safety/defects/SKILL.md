---
name: construction-defects
description: Defects found on a construction job, from the defect checklist to a trade fix and the client's sign-off, in ServiceM8 or Procore. Use when setting up defect tracking for a client, when a trade has not fixed a defect, or when an owner asks why a job has not been signed off.
---

# Defects

Built from how Australian construction businesses described handling defects on discovery calls (6 of 15 calls
described the process). Defects are logged as they come in, the trade is chased until each one is fixed, then the
client signs off. Most of this is done by hand today, and the calls named spreadsheets and Dashpivot as the record.

## What runs on its own
Three crons in `index.ts`, scheduled by `workflow.json`:
- `log-defects` (every 30 minutes) reads each work-order job's defect checklist section and records each new defect,
  with one task on the job for staff.
- `chase` (daily) reads which defects are ticked off, then queues a reminder to the matching trade for each open
  defect that is due.
- `close-out` (daily) waits until every defect on a job is fixed, then drafts a sign-off task and queues the client's
  sign-off email once.

They read and draft internal records only. Every email to a trade or a client waits in the approval queue for a person.

## Setting it up for a client
1. Confirm the job checklist has a section for defects. Its name goes in `defect_section` (default "Defects"). Staff
   tick each item when it is fixed.
2. Fill `trade_contacts` in `settings.json` from `settings.example.json`. Each trade has a word (for example "plumb")
   that appears in the defect name, plus the email the chase goes to.
3. Check the client's company and primary contact are on each job, or the sign-off email has nobody to go to.

## When a defect is not being chased
- No reminder means no trade contact matched the defect name. Add one to `trade_contacts`, or chase it by hand.
- A reminder that is queued but not approved stays in the approval queue. A rejected one is not queued again.
- A close-out that never queued usually has a defect still open or withdrawn. Check the checklist in ServiceM8.

## Procore instead of ServiceM8
Set `procore.projects` (each project's Procore id and a name for the summaries) in settings instead of `defect_section`; both together are
refused. The defects are the project's punch items. `log-defects` records them (the punch item is the task, so no task is created),
`chase` queues a comment on each open item that is due (visible to the people on the item, and it may notify them) for a person to approve, and
`close-out` records when every item is closed; sign-off stays with the item's final approver in Procore. There are no trade emails
or client emails. Example: `"procore": {"projects": [{"id": "123456", "name": "12 Smith St"}]}`. The token is `PROCORE_ACCESS_TOKEN`
and the company id `PROCORE_COMPANY_ID`.

## Judgment that stays with people
- Whether a defect is real, how serious it is, and whether a fix is good enough.
- Whether to sign off a job and what to tell the client.
- Any backcharge to a trade, and any re-inspection. The workflow does not do these.

## Not covered yet
Spreadsheet or Dashpivot defect registers, pricing small defects, backcharges, pass or fail
re-inspection, booking a trade to attend, and reading trade replies. See `gaps` in `workflow.json`.
