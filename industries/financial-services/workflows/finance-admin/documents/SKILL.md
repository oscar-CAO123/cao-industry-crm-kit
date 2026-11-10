---
name: financial-services-forms-typed-by-hand
description: Client forms (loan applications, matter intake) read straight from the form, checked for the fields the business needs, and chased when something is missing, so the adviser stops retyping them. Use when setting this up for a financial services client, when a submission is marked needs-contact, or when an adviser asks why a chase has not gone out.
---

# Forms typed by hand

Reads what clients type into their forms so the adviser never retypes it. Checks each submission for the fields the business needs, drafts a chase email for anything missing and queues it for approval, and marks complete submissions ready for entry. Crons read and draft; a person approves every send and enters every record.

## What runs on its own
Three crons in `index.ts`, scheduled by `workflow.json`: `intake` reads new and edited form responses, `draft` marks complete
submissions ready and drafts a chase for incomplete ones, `follow-up` chases again when a chase is due. They read and draft
only. A chase send waits in the CRM shell for a person to approve it. Nothing in this skill changes that.

## Setting it up for a client
1. Find the form ids and the question ids for each field (Google Forms: the response's answer keys). Fill `settings.json`
   from `settings.example.json`: each form, its label, and the fields it must answer, marking which are required.
2. Confirm the client's mailbox is the one set as `GOOGLE_MAILBOX`, and that its form responses are readable by that account.
3. Agree the chase wording and timing with the client (default: follow-ups at 3 and 7 days).

## When a submission is ready
It is complete, so nothing is chased. The answers in `sheet` are in field order, and each value has been made safe for a
spreadsheet. The adviser enters it into the client's own system (Smokeball or other) by hand. The workflow does not do that step yet.

## When a submission needs a contact
The form did not collect an email address, so no chase can be drafted. Ask the client for an address, or add an email
question to the form, then run intake again.

## Deciding not to chase
If the business has decided not to pursue a submission, leave it alone. Do not draft a chase to be polite.

## Not covered yet
Identity checks, locating client data in other systems, preparing and sending documents for signature, submitting to a lender
or provider, and uploaded files. Jotform and Smokeball are not connected yet (see `workflow.json` gaps).
