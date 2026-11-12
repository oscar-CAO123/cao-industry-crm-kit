---
name: health-care-support-desk
description: Patient and client enquiries from the help desk to a holding reply a person approves, checked against the clinic's patient records (Cliniko) for a physiotherapy or wellness clinic. Use when setting up the support desk for a client, when a clinical enquiry has been escalated, or when an owner asks why a reply has not gone out.
---

# Patient support desk

Takes patient and client enquiries from the help desk, checks the enquirer against the clinic's patient records, and queues a holding reply for a person to approve. Clinical enquiries go to a clinician and never get an automatic reply. Crons read and draft; a person approves every reply that reaches a patient.

## What runs on its own
Three crons in `index.ts`, scheduled by `workflow.json`: `intake` collects new tickets, `draft` matches the enquirer to a
patient record and queues one holding reply (or escalates a clinical enquiry), and `follow-up` chases replies still waiting
on the enquirer. They read and draft only. Every reply that reaches a patient waits for a person to approve it. Nothing in
this skill changes that.

## Setting it up for a client
1. Run the first-run discovery to see where enquiries arrive and which patient system they use. Fill `settings.json` from
   `settings.example.json`: the business name, the turnaround the holding reply should promise, the sign-off, and any words
   that mean a clinician should answer.
2. Confirm the turnaround with the owner. The holding reply states it, so it must be true.
3. Add the client's own clinical words to `clinical_words`. They add to the built-in list and never remove from it.

## When an enquiry is escalated to a clinician
The draft cron stops and marks it `clinician` when the text holds a clinical word (pain, surgery, symptoms, medication and
similar). No reply is queued. The clinician or owner writes the reply by hand. Do not draft a clinical answer for it.

## Judgment steps the agent does not run on its own
- Booking and cancelling appointments: staff do these in Cliniko.
- Deciding whether a patient needs a call back: the owner or receptionist decides.
- Patient creation: a new patient is added by staff, after the enquirer's details are checked.
- Anything that depends on a clinical history: read it in Cliniko, never copy it into a reply.

## Not covered yet
Rescheduling, reminders and SMS in Cliniko, Medicare and health fund claims, complaints, and hand-off between staff. Booking
changes through the API are mapped but not wired, because who may change a booking is not in the platform docs.
