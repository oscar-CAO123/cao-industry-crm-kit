---
name: financial-services-portfolio-reviews
description: Portfolio reviews for a financial adviser business in HubSpot. Flags the client reviews that are due, prepares each review pack from the client record, and queues the review meeting invite for an adviser to approve. Use when setting up portfolio reviews for a client, when an invite is waiting for an agreed slot, or when an adviser asks why a review has not been booked.
---

# Portfolio reviews

Finds the client portfolios whose review date has come, prepares a review pack from the client record, and queues the review meeting invite for an adviser to approve. Crons read and draft; a person approves every invite.

## What runs on its own
Three crons in `index.ts`, scheduled by `workflow.json`. `review-due` flags the clients whose review date has come.
`prepare` writes each due client's review pack into the workflow store. `invite` queues a calendar invite for each prepared
client that has an agreed slot. They read and draft only. Nothing reaches a client until an adviser approves the invite.

## Setting it up for a client
1. Fill `settings.json` from `settings.example.json`: the HubSpot property names for the client name and the next review date,
   the fields to copy into the review pack, the adviser's owner id, the organiser user id and the timezone.
2. Confirm `HUBSPOT_ACCESS_TOKEN` is in the deploy's secret store. Only the name is recorded here.
3. Check the property names against the client's HubSpot account before the first run.

## The steps the adviser does
Objectives, recommendations, compliance documentation, the statement or record of advice, the client's decision, any changes
and follow-up are done by the adviser. The review pack is the input to that work. No cron writes any of them.

## Booking a review
The invite cron only queues an invite for a client whose agreed slot is in the workflow store. Recording that slot is not built
yet (see `gaps` in `workflow.json`). Until it is, the adviser books the meeting by hand.

## Not covered
Portfolio holdings, values, returns and fees. Midwinter AdviceOS, which has mapped operations but no wired sign-in. Xplan, which
has no operations file in the kit. The compliance check.
