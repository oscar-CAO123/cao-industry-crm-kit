---
name: real-estate-inspections
description: Property inspections from booked visit to owner report, in the business's own software (ServiceM8). Use when setting up inspections for a client, when intake flags an inspection with no inspector, when a draft note has no findings, or when an owner asks why a report has not gone out.
---

# Inspections need a trip each

Built from how 6 Australian real estate businesses described inspections on discovery calls. The common shape: an office
allocates an inspector, the inspector visits and records findings, someone types up the report, a person checks it, and it
goes to the owner.

## What runs on its own
Three crons in `index.ts`, scheduled by `workflow.json`. `intake` finds inspection jobs booked in ServiceM8 and notes whether an
inspector is allocated and whether the visit is marked done. `draft` writes a findings note on the job from the staff notes and
photo count once a visit is done. `report` queues the owner's email, with the job's photos, for approval.

They read and draft only. The owner's email waits for a person to approve it in the CRM shell. Nothing in this skill changes that.

## Setting it up for a client
1. Confirm the business runs inspections as ServiceM8 jobs. If they use an inspection app instead, this workflow does not reach it yet.
2. Fill `settings.json` from `settings.example.json`. Set `inspection_match` to the word their inspection job descriptions use.
3. Check that the owner's email sits on the job's primary company contact. Without it, the report waits for a person.

## When intake flags a job with no inspector
Allocate an inspector in ServiceM8 yourself. The workflow does not choose who attends.

## When a draft note has no findings
The draft lists "none recorded" when staff have not written notes on the job. Ask the inspector for the notes, or write them on
the job. The report cron will not queue an email with no findings.

## Before approving the owner's email
Read the findings in the approval summary, then open the job in ServiceM8 and check the photos. The workflow reads the notes and
counts photos; it cannot judge condition.

## Not covered yet
Inspection Express, Property Tree and 360 cameras; PropertyMe and Rex (no kit operations mapped); assigning inspectors; the
formatted report PDF; reinspections; tenant replies. Do these the business's usual way and record the result on the job so
the record stays in one place.
