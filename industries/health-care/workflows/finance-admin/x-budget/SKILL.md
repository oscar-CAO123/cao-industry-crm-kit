---
name: health-care-budget-burn
description: Budget burn for a health-care business, read from its Xero budgets and budget summary. Use when setting up budget tracking for a client, when an owner asks how a budget line is running, or when the stored burn read needs turning into a note for the owner.
---

# Plan budget burn

Plans and tracks budget burn for a health-care business: reads the budgets and the budget summary report from Xero every day and stores them for the owner's burn read. Nothing is changed, sent or approved by a cron.

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
