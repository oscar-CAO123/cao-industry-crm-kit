---
name: financial-services-invoices
description: Checks bills and sales invoices in Xero against the basics that catch errors, notes the result on each invoice, and queues bill payments and overdue reminders for approval. Use when setting up invoice checking for an accounting practice or finance team, when a check says needs-review, or when someone asks why a payment or reminder has not gone out.
---

# Invoices checked by hand

Built from 12 Australian calls about invoicing, 6 described in detail. Staff check each bill and client invoice by hand, chase late payers by phone, and pay bills from the bank. This workflow does the checks a person repeats on every invoice and keeps every payment and reminder behind an approval.

## What runs on its own
Three crons in `index.ts`, scheduled by `workflow.json`:
- `check` (every 30 minutes) reads open bills and draft sales invoices in Xero, checks each one (supplier, due date, total, account codes, source document, possible duplicate), and writes a note on the invoice.
- `payments` (hourly) queues a payment for each passed bill that falls due within the set number of days.
- `chase` (daily) queues the next reminder for an overdue sales invoice, at most one a day.

They read and note only. Every payment and every email to a customer waits for a person to approve it in the CRM shell.

## Setting it up for a client
1. Fill `settings.json` from `settings.example.json`: the bank account code bills are paid from, how many days before due a payment is queued, the tolerance for totals, and the reminder days.
2. Confirm the bank account code in Xero. Payments park until it is set.
3. Confirm how the business codes bills in Xero (an account code on each line). The check flags any line without one.

## When a check says needs-review
Read the reasons in the invoice's note, fix the invoice in Xero, and the next check run clears it.
- No supplier or customer, no due date, or a zero total: fix the invoice.
- A line has no account code: code the line.
- Lines add to a different subtotal: check the lines against the source document.
- No source document attached: attach the bill, or confirm the supplier sent none.
- Possible duplicate: check whether the bill was entered twice.

## Judgment that stays with the bookkeeper
Matching a bill to its purchase order, asking a supplier for a statement, deciding whether an unusual amount is right, and any call to a late customer. The crons cannot do these. The approval summary shows the amount and the party, and the person decides.

A rejected reminder still counts as sent, so the next one is measured from the day the rejected one was queued.

## Not covered yet
Dext, MYOB, Ignition and XPM, bank transaction classing for SMSF clients, and reconciliation. See the gaps in `workflow.json`.
