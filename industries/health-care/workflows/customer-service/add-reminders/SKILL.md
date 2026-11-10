---
name: health-care-add-reminders
description: Appointment reminders and waitlist for a clinic or pharmacy that runs Cliniko. Use when setting up reminders for a client, when a reminder or waitlist draft needs checking, when a waitlisted patient has accepted an opening, or when an owner asks why a patient got no reminder.
---

# Appointment reminders and waitlist

Finds upcoming appointments that Cliniko sent no reminder for and drafts the text to send by hand, turns cancelled appointments into waitlist offers, and queues a booking for a waitlisted patient once a person has marked them accepted. Crons read and draft; a person approves every booking.

## What runs on its own
Three crons in `index.ts`, scheduled by `workflow.json`:
- `reminders` finds upcoming appointments that Cliniko sent no reminder for, and drafts the text.
- `cancellations` records each cancelled appointment still ahead as an opening, and drafts a waitlist offer.
- `waitlist-book` queues a booking for an opening a person has marked accepted, if the slot is still free.

The crons read Cliniko and write their own drafts and openings. They never send a text or email, and they never book.
A booking waits in the approval queue until a person approves it in the CRM shell.

## Setting it up for a client
1. Confirm the Cliniko shard and that the API key belongs to the client's account.
2. Fill `settings.json` from `settings.example.json`: the business id if they run more than one site, the reminder hours,
   and the wording of the reminder and offer texts.
3. Check Cliniko's own SMS reminder templates are on. These crons only fill the gaps those templates leave.

## What a person does
- Read the drafted reminders and send them by hand in Cliniko, or leave them if Cliniko already sent one.
- Read the drafted waitlist offers and send them to the patients on the waitlist. Cliniko's wait list is kept by hand.
- When a patient accepts an opening, a person marks it accepted in the CRM shell. The next `waitlist-book` run queues
  the booking, and a person approves it.
- A failed or rejected booking is not retried by the cron. A person decides what to do.

## Not covered yet
- Patient confirmations and replies. Cliniko forwards replies to a practitioner, and the docs do not say they are recorded.
- Recording an accepted opening in the CRM shell (the step the booking cron depends on).
- HotDoc, Jane App and GoHighLevel adapters.
- Cancelling appointments, no-show follow-up and recall outreach.
- A book with more than 1,000 future appointments. The crons refuse to read part of it and stop with an error until the SDK can send Cliniko's date-range filter.
