---
name: automotive-commission
description: Commission for an automotive dealership or workshop, worked out from paid sales each month and entered on each salesperson's payslip in Xero payroll. Use when setting up commission for a client, when the figures cron cannot match an invoice to a rep, or when someone asks why a commission line is missing from a pay run.
---

# Commission calculator

Built from one discovery call and the Xero payroll API. The steps the call did not cover are in `gaps` in `workflow.json`.

## What runs on its own
Three crons in `index.ts`, scheduled by `workflow.json`:
- `figures` (hourly) reads last month's paid sales invoices in Xero, matches each to a rep, and works out the commission from the tiers.
- `draft-pay` (every 45 minutes) creates last month's pay run as a DRAFT if it does not exist, and puts each rep's commission on their payslip.
- `queue-post` (daily) queues the pay run post for a person once every commission line is on it.

The crons read and draft only. Posting the pay run pays staff, so it waits in the CRM shell for a person to approve it. Nothing in this skill changes that.

## Setting it up for a client
1. Fill `settings.json` from `settings.example.json`: the Xero payroll calendar, the earnings rate that commission is paid under, the tiers, and each rep with their Xero employee ID.
2. Agree the tiers with the owner. The example tiers are a placeholder, not the client's plan.
3. Agree the match text for each rep. Xero invoices carry no sales rep, so the workflow matches text in the invoice Reference. The owner puts that text on each sale, for example "SL-" before a rep's sales.
4. Check the payroll calendar runs monthly, with one pay run per calendar month. The workflow looks for that run and will not create a second one.

## When an invoice is not counted
The figures cron logs how many paid sales have no rep match. Check the Reference on those invoices. Add the match text to the rep in settings, or leave it out if the sale is not commissionable.

## Not covered yet
Chargebacks, refunds and credit notes, splitting commission between staff, sending staff statements, corrections after posting, and month-end reconciliation. Do these the business's usual way and note the result on the pay run.
