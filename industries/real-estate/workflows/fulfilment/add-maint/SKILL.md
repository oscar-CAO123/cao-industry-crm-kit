---
name: real-estate-maintenance-dispatch
description: Maintenance requests to an allocated maintenance person for a property manager, in ServiceM8. Use when setting up maintenance dispatch for a client, when a dispatched job has not moved, or when an owner asks why a completed job has not been reported.
---

# Maintenance dispatch

Built from how property managers described dispatching maintenance on discovery calls, and from ServiceM8's own help
and API. The workflow covers the request, the owner's go-ahead, dispatch, the progress messages and the completion
update. Triage, tenant access and invoices stay with a person for now (see gaps in `workflow.json`).

## What runs on its own
Three crons in `index.ts`, scheduled by `workflow.json`. `intake` records new requests (jobs logged as Quote).
`dispatch` queues an allocation for each job the owner has moved to Work Order. `follow-up` records what was approved,
queues the owner update when a job completes, and queues a progress check when a job stalls.
They read and queue only. Nothing is allocated, sent or texted until a person approves it in the CRM shell.

## Setting it up for a client
1. Run the first-run discovery to see which job system they use and who does the maintenance dispatch. Fill
   `settings.json` from `settings.example.json`.
2. Set `dispatch_staff_uuid` to the maintenance person in ServiceM8 (Staff in ServiceM8, not a tradie's company).
3. Set `owner_email` to the owner who should get completion updates. Leave it out to skip owner updates.

## The owner's go-ahead
The workflow reads the owner's approval from the job's status. A person moves the job from Quote to Work Order
in ServiceM8 once the owner says yes. The dispatch cron acts only after that move.

## When a dispatch approval is waiting
The allocation shows in the CRM shell as "Allocate ... to the maintenance person". Check the job and the person,
then approve it. A rejected allocation stays rejected: allocate the job by hand in ServiceM8 and say so in the job.

## Not covered yet
Triage by urgency, choosing a tradie per job, tenant access and appointments, and contractor invoices and payments.
Do these the business's usual way.
