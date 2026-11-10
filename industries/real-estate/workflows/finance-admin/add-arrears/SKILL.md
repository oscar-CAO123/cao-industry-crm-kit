---
name: real-estate-add-arrears
description: Rent arrears ladder for a residential property business, run from Re-Leased with reminders drafted in Outlook. Use when setting up arrears chasing for a client, when a reminder is waiting for approval, or when an owner asks why a tenant has or has not been chased.
---

# Arrears ladder

Finds overdue rent in Re-Leased, adds each new arrears invoice to the arrears register, and drafts a reminder at each step of the ladder. Every reminder waits for a person to approve the send from the arrears mailbox.

## What runs on its own
Two crons in `index.ts`, scheduled by `workflow.json`. `scan` reads overdue invoices from Re-Leased and adds each new one to
the arrears register. `remind` drafts the reminder for each invoice's current step (day 1, then day 7 by default) and queues
the send. They read and draft only. Every reminder waits for a person to approve it. Nothing in this skill changes that.

## Setting it up for a client
1. Confirm the platform: Re-Leased is the one mapped here. If the client uses Console or PropertyMe, this skill does not cover them yet.
2. If PropertyMe Arrears Automation or the Console Arrears Workflow is on, turn it off for these tenancies. Otherwise tenants get two reminders.
3. Fill `settings.json` from `settings.example.json`: the arrears mailbox, the register workbook, the reminder days, the business name.
4. Check the reminder template with the owner before the first approval.

## When a reminder is waiting for approval
Open the approval in the CRM shell. Before approving, check the tenancy in Re-Leased: a payment plan, a dispute or a collector
means no reminder. Reject it in that case. The cron cannot see that status on its own.

## Not covered
Tenant calls, payment plans, notice to remedy, owner updates, escalation to a collector or tribunal, bond recovery at exit,
Console and PropertyMe. Do these the business's usual way.
