---
name: fitness-beauty-failed-payments
description: Failed or overdue member payments for a gym, studio or salon, in Stripe and Xero. Use when setting up failed-payment handling for a client, when an overdue invoice has no chase queued, or when an owner asks why a member was or was not chased.
---

# Failed payments

Finds failed or overdue member payments in Stripe and Xero, notes each one in Xero, and queues the retry or reminder for a person to approve. Crons read and note; nothing charges or emails a member until approved.

## What runs on its own
Three crons in `index.ts`, scheduled by `workflow.json`. `detect` finds failed Stripe charges and overdue Xero invoices and writes one internal note per failure in Xero. `reconcile` closes failures that have since been paid. `chase` queues the next step on each open failure that is due: a Stripe retry on the first step (or an invoice email if `retry_stripe` is false), then reminder emails. They read, note and queue only. Every retry, every email and every money movement waits for a person to approve it in the CRM shell.

## Setting it up for a client
1. Fill `settings.json` from `settings.example.json`: which sources the client uses, the chase days, and whether a first chase retries the card.
2. Confirm each Xero invoice that should be chased has the member's email on it. Chase steps skip an invoice with no email and log it for a person.
3. Run the client's Stripe test mode and a Xero demo company before any live approval.

## What a person decides
- Whether an overdue Xero invoice is a failed membership payment or a one-off bill. Xero cannot tell them apart.
- Each approval. Read the summary (member, amount, step) before approving a retry or an email.
- Any case the workflow skips, such as a missing email address.

## Not covered yet
Phone and text chasing by staff, member card updates, pausing bookings or memberships for an unpaid account, disputes and chargebacks, and Mindbody. See `workflow.json` gaps.
