---
name: pr-media
description: Pitching journalists with a media release through the agency's Gmail, chasing pitches that get no reply, and reporting replies to the owner. Use when setting up PR for a client, when a pitch needs a new release or a new journalist, or when an owner asks why a pitch has not gone out.
---

# PR and media

Pitches journalists, sends media releases and tracks replies to each pitch, through the agency's Gmail. Crons draft each pitch and follow-up, check threads for replies, and draft one joined report to the owner. A person approves every send. Published coverage is not tracked yet.

## What runs on its own
Three crons in `index.ts`, scheduled by `workflow.json`: `pitch` drafts one pitch to each approved journalist,
`follow-up` marks sent pitches, stops the chase on any reply and queues due follow-ups, and `report` drafts one joined
report to the owner each week. They read and draft only. Every send waits for a person to approve it in the CRM shell.

## Setting it up for a client
1. Fill `settings.json` from `settings.example.json`: the release (id, subject, text), the journalists the owner or agency
   has approved (one entry each), the owner's address for the report, and the follow-up days.
2. Confirm the mailbox that sends is set through `GOOGLE_MAILBOX`, and that the account can create drafts and send them.
3. Change `release.id` when a new release goes out, so each journalist gets one pitch per release.

## The judgment steps
- Writing the release and each pitch. The cron only sends the text it is given, with `{name}` filled from the journalist list.
  Pitch text and journalist details come from the client and its approved list, never from a reply.
- Choosing journalists. Add only people the owner or agency has approved. Remove anyone who asks not to be contacted.
- Answering a reply. The report names who replied. A reply is read in Gmail by a person, who answers it.
- Deciding a follow-up is not wanted. Set `follow_up.after_days` shorter or empty it for that release.

## Not covered yet
Media databases and journalist search (Cision, Meltwater), coverage alerts and share of voice, and any link from coverage to
bookings or revenue. These need the platform's operations mapped in the kit first. Until then, do them the agency's usual way.
