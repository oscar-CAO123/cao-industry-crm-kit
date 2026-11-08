---
name: invoicing-from-completed-work
description: Completed jobs to invoices in Xero, with ServiceM8 as the job system. Use when setting up invoicing for a trade or service business, when the draft cron leaves a job as needs-lines, or when an owner asks why an invoice has not gone out or a payment has not been recorded.
---

# Invoicing from completed work

Built from how 44 Australian businesses described invoicing on discovery calls. Most type invoices up by hand
after the job, check them against what was quoted, and chase payment by hand. This workflow covers the part
ServiceM8 and Xero can do through their APIs.

## What runs on its own
Three crons in `index.ts`, scheduled by `workflow.json`:
- `draft` (every 30 minutes) turns each completed ServiceM8 job with materials into a DRAFT invoice in Xero, then queues
  its authorise and email for approval.
- `payments` (hourly) queues a payment in Xero for each payment the trade took in ServiceM8.
- `chase` (daily) queues the next reminder for a sent invoice that is past due.

The crons read and draft only. Authorising an invoice, emailing it, recording a payment and marking a job invoiced all
wait for a person to approve them in the CRM shell.

## Setting it up for a client
1. Fill `settings.json` from `settings.example.json`: the due period, the Xero sales account, the bank account payments
   land in, and the reminder days.
2. Confirm each job's materials carry a quantity and a price. Labour lines count as materials here, so price them.
3. Check the sales account's GST setting in Xero before the first approval.

## When a job is parked
- `no materials on the job yet`: someone adds the materials in ServiceM8. The next draft run picks it up.
- `a material line has no usable quantity or price`: fix that line in ServiceM8.
- `set bank_account_code in settings`: a payment is parked until the setting is there.
- `more than the amount due`: check the payment in ServiceM8 against the Xero invoice. Do not approve it as is.

## Judgment that stays with the owner
Checking an invoice against its quote, reviewing an unusual amount before it goes out, and any change to what the
customer is charged. The approval summary shows the amount and the customer, and the owner decides.

## Not covered yet
Creating or authorising invoices in MYOB, progress claims, supplier bills, bank-detail checks, and job data that lives in
Simpro, Jobpac, Ignition or paper job sheets. Do these the business's usual way. Reminders are the invoice email again,
because Xero's API has no reminder-send operation mapped.
