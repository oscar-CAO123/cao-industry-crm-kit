---
name: transport-invoices
description: Completed transport trips to priced, authorised invoices in Xero, from the rate card, once proof of delivery is on file. Use when setting up invoicing for a transport or haulage client, when a trip is parked as needs-check, or when an owner asks why an invoice has not gone out.
---

# Invoices from rates

Turns each completed transport trip into a priced invoice in the business's accounting software, from the rate card, once its proof of delivery is on file. Queues each invoice to be authorised and emailed for approval, queues reminders for overdue invoices, and keeps the trip records in step with what the accounts say. Crons read and draft; a person approves every authorisation, email and reminder.

## What runs on its own
Three crons in `index.ts`, scheduled by `workflow.json`:
- `draft` prices each trip with proof of delivery from the Xero item list and creates a DRAFT invoice. It queues the authorise and
  email for approval.
- `reconcile` reads each invoice's status and amount due from Xero, so the trip records match the accounts.
- `chase` queues the next reminder for an authorised, sent invoice that is past due.

They read and draft only. Authorising, emailing and every reminder wait for a person to approve them in the CRM shell.

## Setting it up for a client
1. Confirm which accounting software they use and that the item list in it is the rate card: each item needs a code and a sales
   unit price. Fill `settings.json` from `settings.example.json`.
2. Confirm the sales account and its GST setting with the owner before the first invoice is authorised.
3. Agree how trips get into the trip store. No transport system is mapped yet, so each completed trip is written as a record
   (`types.ts`, `Trip`): customer, PO or docket reference, proof of delivery on file (`pod: true`), and item codes with quantities.

## When a trip is parked as needs-check
The draft cron parks a trip it cannot invoice, and the reason says why:
- No proof of delivery: wait for the signed docket, then mark `pod: true`. The next run drafts it.
- A code not on the rate card, or a bad quantity: correct the code or quantity on the trip record, or add the item to Xero.
- No items: add the items the trip was for.
Customer-specific rates and surcharges are not built. A trip that needs a different price is priced by hand in Xero.

## Not covered yet
CartonCloud and MYOB trip data and invoicing, customer-specific rate cards and surcharges, recording payments, disputes and credit
notes, and reverse billing to drivers. Do these the business's usual way. The rest of this workflow still runs for trips recorded here.
