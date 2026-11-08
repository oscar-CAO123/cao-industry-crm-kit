---
name: all-lead-capture
description: Web form and live chat leads into the CRM for any business, with an approved acknowledgement and follow-ups. Use when setting up lead capture for a client on GoHighLevel, when an owner asks why a lead was not picked up or not contacted, or when a new lead is missing its tags or opportunity.
---

# Lead capture

Built from how 40 Australian businesses described capturing leads on discovery calls (21 described the process). The
mapped path is GoHighLevel: form submissions and live chat become contacts with tags and an opportunity in the new-lead stage.

## What runs on its own
Three crons in `index.ts`, scheduled by `workflow.json`:
- `intake` (every 10 minutes) reads new form submissions and live chats with an unanswered message, tags each lead, and opens an opportunity in the new-lead stage.
- `acknowledge` (every 15 minutes) queues a short acknowledgement for each new lead that has an email (or a phone, for SMS).
- `follow-up` (daily) queues follow-ups for leads who have not replied or booked, up to the set number.

They read and record only. Nothing reaches a lead until a person approves the queued message in the CRM shell.

## Setting it up for a client
1. Confirm the GoHighLevel location, the pipeline and the new-lead stage. Copy their ids into `settings.json` from `settings.example.json`.
2. Set `GHL_ACCESS_TOKEN` in the client's secret store. Do not put it in settings or in a file.
3. Set the acknowledgement and follow-up text with the owner. Keep it plain: say who they are and that a person will follow up. Do not write as a person.
4. The first `intake` run only records the start time. Leads from before setup are not imported.

## When a lead is missing
- No tags or no opportunity: check the lead's record in the store. The intake cron records the lead before it writes, so a lead with no opportunity failed after that point. Its log line says why. Add the opportunity by hand.
- No acknowledgement queued: it needs an email on the contact (or a phone for SMS). Check the contact.
- A follow-up was not queued: the lead has an appointment, or a message from them is waiting for a reply. That is by design.

## Judgment steps (the agent does these, not the crons)
- Qualifying a lead: reading what they asked and deciding whether it fits the business. Write the outcome into the CRM by hand.
- Answering a chat that needs a person: the chat stays with staff.
- Deciding not to pursue a lead: mark it in the CRM. Do not queue a message to be polite.

## Not covered yet
Google Ads and Meta lead forms (GoHighLevel creates their contacts, but this workflow reads form submissions only), HubSpot, AI voice or chat qualifying calls, booking writes, round-robin routing, and SMS consent checks. The full list is in `workflow.json` under `gaps`.
