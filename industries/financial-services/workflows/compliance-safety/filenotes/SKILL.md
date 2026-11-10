---
name: financial-services-file-notes
description: Fireflies meeting summaries to draft file notes for an adviser to check and file, for a financial services or insurance broking business. Use when setting up file notes for a client, when a draft note looks wrong, or when an adviser asks why a meeting has no note yet.
---

# File notes

Turns a finished Fireflies meeting summary into a draft file note that the adviser checks and files. Crons read and draft only; nothing is filed on a client record, shared or sent without a person.

## What runs on its own
Two crons in `index.ts`, scheduled by `workflow.json`. `intake` lists new Fireflies meetings from the last few days. `draft` reads each new meeting's Fireflies summary and writes a draft file note into the workflow store. Both only read. Nothing is filed on a client record, shared with anyone or sent.

## Setting it up for a client
1. Confirm the business records calls with Fireflies. The crons only see meetings Fireflies has recorded.
2. Fill `settings.json` from `settings.example.json`: the business name, the adviser who checks notes, how far back to look.
3. Connect the Fireflies API key through the secret store as `FIREFLIES_API_KEY`. Never paste it into a file.

## What the adviser does
Each draft says it is a draft and that it was taken from the Fireflies summary, not checked against the transcript. Read it against the transcript, correct it, then file it on the client record by hand. The draft is not a file note until the adviser has checked it.

## When a meeting has no note
- It has no summary yet: the draft cron waits and checks again. After six checks it is skipped with a reason.
- It does not say which client it is for: the draft lists the attendees, not a client record. File it against the right client by hand.

## Not covered yet
Phone calls, texts and emails that are not in a recorded meeting. Writing the note into HubSpot or a client file, because the HubSpot note field is not confirmed. Client copies, chasing missing details, and any sign-off step. Do these by hand for now.
