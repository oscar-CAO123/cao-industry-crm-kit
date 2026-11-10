---
name: all-speed-to-lead
description: Speed to lead for any business that takes enquiries. Alerts the owner when a new lead lands, queues one first text for approval if nobody has replied in time, and escalates a lead that is still uncontacted. Use when setting this up for a client, when an owner asks why a lead was not contacted fast, or when a cron alert looks wrong.
---

# Speed to lead

Alerts the owner the moment a new lead lands, queues one first text for approval if nobody has replied in time, and escalates to a senior person when a lead is still uncontacted. Crons read and draft internal tasks; a person approves every text to a lead.

## What runs on its own
Three crons in `index.ts`, scheduled by `workflow.json`:
- `intake` (every 5 minutes) finds open leads in the new-lead stage and drops one internal task for the owner on each.
- `chase` (every 10 minutes) queues one first text for a lead that has waited the set time with no reply. Nothing is sent.
- `escalate` (every 15 minutes) drafts one internal task for the senior person on a lead still uncontacted after the escalation time.

Only the text to a lead is live. It waits in the approval queue until a person approves it. Tasks stay inside the business.

## Setting it up for a client
1. Fill `settings.json` from `settings.example.json`: the GoHighLevel location, pipeline, new-lead stage, the owner and the senior person.
2. Agree the first-text wording with the owner. Use `{first}` and `{business}` only.
3. Confirm the send body against a sandbox account before the first live approval. The vendor spec marks `subType` and `status` as required, and this build sends `SMS` and `pending`.

## Judgment the team does
- Approve, edit or reject each queued first text in the CRM shell.
- Work the alert task and the escalation task. A lead called by phone is handled once it moves out of the new-lead stage.
- Decide what counts as the right first reply for an unusual enquiry. The cron only sends the template.

## Not covered yet
Round-robin routing, time-to-first-contact reporting, retry sequences, email first contact, and a second chase message.
HubSpot and Pipedrive are not built for this job (see `gaps` in `workflow.json`).
