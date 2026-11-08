---
name: health-care-budget-burn
description: Budget burn for a health-care business, read from its Xero budgets and budget summary. Use when setting up budget tracking for a client, when an owner asks how a budget line is running, or when the stored burn read needs turning into a note for the owner.
---

# Plan budget burn

Built from the workflow spec for health-care budgeting. The call evidence file for this workflow is missing, so the steps are not yet checked against how owners describe their budgets on calls.

## What runs on its own
Two crons in `index.ts`: `budget-read` copies the Xero budgets (planned amounts per account and period) into the store, and `burn-check` stores the Xero budget summary report under today's date. They read only. They change nothing in Xero, send nothing and queue nothing.

## Setting it up for a client
1. Confirm the client uses Xero and has budgets set up there. Fathom and Microsoft 365 have no mapped operations for this job.
2. Fill `settings.json` from `settings.example.json`: the business name and the report window (MONTH, QUARTER or YEAR).

## The judgment steps the agent does
- Read the stored burn read for the day. The report rows are not parsed by code yet, so read the raw report and work out the burn and variance by line.
- Flag the lines running hot or under, and say what the owner could do about each one.
- Draft the owner's note. Budget figures come from the client's own books. Write the note as a draft for a person to send.

## What is not covered
Forecasting, overspend alerts, budget edits, spend approval checks, a budget decision log, and the hand-off to an accountant. Each needs a live account to confirm what the platform supports.
