---
name: checkins-winback
description: Check-ins, renewals and win-backs for any business that has repeat customers, run through Mailchimp, the only email tool built so far. Use when setting this up for a client, when a due group has no campaign yet, when a reply needs answering, or when an owner asks why a check-in has not gone out.
---

# Check in, renew or win back customers

Works out which customers are due a check-in, renewal or win-back, drafts the campaign for each group in the business's email tool, and queues every send for approval. Crons read and draft; a person approves every send.

## What runs on its own
Three crons in `index.ts`, scheduled by `workflow.json`:
- `due-list` (every 6 hours) reads the subscribed members and records who is due in each group.
- `draft` (hourly) creates one Mailchimp campaign draft per group per day, with the owner's approved text, and queues the send.
- `replies` (every 30 minutes) notes each unread reply to a check-in campaign on the member, so a person knows to answer.

They read and draft only. Nothing is sent until a person approves the queued send in the CRM shell.

## Setting it up for a client
1. Fill `settings.json` from `settings.example.json`: the Mailchimp list id, the sender name and reply address, and one entry per group.
2. The owner builds a saved segment in Mailchimp for each group and puts the group's tag on its members (for example `lapsed-90-days`).
   `after_days` is how long a member's record must sit unchanged before they are due.
3. The owner approves the subject and HTML body for each group. The cron puts that text in the draft unchanged.
4. Set `MAILCHIMP_API_KEY` and `MAILCHIMP_DC` (the data centre, such as `us1`) in the deploy's secret store. Keys come only from there.

## The judgment steps (a person does these)
- Decide the groups and their wording. The cron never writes copy.
- Call customers who need a conversation, and answer replies. The note tells you who replied; the reply text is read in Mailchimp.
- Decide renewal terms, win-back offers and bookings. Those are not in this workflow.
- Approve or reject each queued send in the CRM shell. Check the subject, the group and the due count first.

## Not covered
Phone calls, renewal terms and prices, win-back offers, bookings, payments and signing, chasing silence, and setting the next
check-in date. The real due date (renewal, service or membership end) lives in the business's own system; Mailchimp's last
change date is only a proxy. GoHighLevel, HubSpot, ActiveCampaign and spreadsheet-based lists have no adapter here yet.
