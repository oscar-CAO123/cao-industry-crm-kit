---
name: all-booking-reminders
description: Appointment book for a service business on Calendly: reads the next bookings, and queues a yes or no on each finished booking so a person can mark a no-show. Use when setting this up for a client, when an owner asks why a no-show was or was not queued, or when the no-show approvals are piling up.
---

# Booking, reminders and no-shows

Works through the appointment book in Calendly: reads each booking into the workflow's book, and queues a yes or no on every finished booking so a person can mark a no-show. Booking a new slot and sending reminders are not covered yet (see gaps). Crons read and queue; a person decides every no-show.

## What runs on its own
Two crons in `index.ts`:
- `intake` (every 15 minutes) reads the next 14 days of active Calendly events and their invitees into the workflow's book.
- `no-show` (every 30 minutes) queues one approval for each finished booking that has no no-show record yet, oldest first, up to 20 a run.

Neither sends anything. Calendly does not record attendance, so the no-show cron cannot know who came. It asks a person.

## Setting it up for a client
1. Copy `settings.example.json` to `settings.json`. Set `calendly.user_uri` to the owner's Calendly user URI
   (`https://api.calendly.com/users/<uuid>`), and check the grace period (default 15 minutes after the booking ends).
2. Put the client's Calendly token in the environment as `CALENDLY_API_TOKEN`. Never write the value in a file.
3. Run `intake` once and check the book has the bookings the owner expects.

## The judgment steps
- **No-show approvals.** Open each one in the CRM shell. Approve it only when the client did not attend. Reject it when they came.
  A rejected one stays rejected. Do not approve in bulk without looking.
- **Reminders.** Turn on Calendly's own invitee reminders in the Calendly settings. The kit does not send reminder texts.
- **Cancel or reschedule from a message.** Do it in Calendly, the way the business does now.

## Not covered yet
Booking a new slot, availability checks, reminder texts, Cliniko and Acuity appointments, and cancel or reschedule
through the workflow. Do these the business's usual way until the matching adapter and cron are built.
