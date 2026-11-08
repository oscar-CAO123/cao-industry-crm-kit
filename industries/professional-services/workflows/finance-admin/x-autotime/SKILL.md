---
name: professional-services-automatic-time-capture
description: Automatic time capture for a professional services practice on Clio. Reads a fee earner's time entries and running timer, flags entries with no matter or note, and queues time entries a person records for approval. Use when setting up time capture for a fee earner, when an entry is flagged, or when missed time needs to go into Clio.
---

# Automatic time capture

Docs-only. Built from the Clio docs and the mining run for this job. Clio is the only platform with mapped operations in the kit.

## What runs on its own
Three crons in `index.ts`. `capture` runs every 30 minutes. It reads the fee earner's time entries for today and the running timer, then flags any entry with no matter and any entry with no note. `matters` runs each morning and reads the open matters, so an entry can be checked against a real matter. `entries` runs every 15 minutes. It takes each time entry a person recorded in the workflow store and queues it in Clio for approval.

None of the crons writes a time entry. A queued entry waits for a person to approve it, and only the approval creates it in Clio.

## Setting it up for a fee earner
1. Fill `settings.json` from `settings.example.json`: the Clio user id of the fee earner, the matter status to offer (default Open), and optionally an activity description id. Set `CLIO_ACCESS_TOKEN` in the environment, and `CLIO_REGION` if the firm is not on the Australian region.
2. Confirm the token belongs to the fee earner, then run one `capture` and one `matters` pass by hand and check the flags against what the fee earner recorded.
3. Before any approval runs, a sandbox must confirm the Clio quantity unit (seconds on the latest API version). See the gaps in `workflow.json`.

## When a flag or a queued entry needs a decision
- A `no-matter` flag means the entry has no matter. The fee earner picks the matter in Clio, or the entry is left for a person to decide.
- A `no-note` flag means the entry has no description. The fee earner adds one in Clio.
- A request parked as `needs-check` carries the reason in `reason_parked`. Usually the matter is not one of the open matters, or a field is missing. Fix the request, or drop it.
- A queued entry shows in the approvals list with its matter, date and hours. Approve it only if those are right.

## Not covered
Timers starting and stopping, the billable decision, write-offs, period timesheet submission, partner approval, and invoice handover. These stay with the fee earner and the practice's own process. Actionstep and Harvest are documented in the evidence but have no kit operations, so they are not mapped.
