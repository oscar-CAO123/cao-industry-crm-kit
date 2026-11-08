---
name: professional-services-due-dates
description: Due dates for a professional services practice on Xero. Reads the invoices still owed and the open project deadlines, drafts one internal Xero Projects task per deadline coming up, and queues a chase email for each overdue invoice for approval. Use when setting up due-date tracking for a practice, when a deadline task is missing, or when an overdue invoice needs chasing.
---

# Due dates

Docs-only. Built from the mining run for this job. Xero is the only platform with mapped operations for due dates in the kit. Ignition and Karbon were read but have no operations mapped.

## What runs on its own
Two crons in `index.ts`. `scan` runs each morning at 21:00 UTC. It reads the invoices still owed (AUTHORISED sales invoices) and the open projects with their deadlines, and keeps both in the workflow store. For each project deadline inside the window (14 days by default), it drafts one internal task in Xero Projects named with the deadline. Each deadline gets one task, ever.

`chase` runs each morning at 21:15 UTC. It finds invoices overdue by the set number of days (7 by default) and queues Xero's invoice email for each one. A repeat run queues nothing new. Overdue invoices are chased again at each further step (14 days, 21 days, and so on).

Neither cron emails a client. A queued chase waits in the approval list until a person approves it, and only then does Xero send the invoice email.

## Setting it up for a practice
1. Fill `settings.json` from `settings.example.json`: the business name, the days overdue before a chase (`chase_after_days`), and the deadline window (`deadline_window_days`).
2. Set `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`, `XERO_TENANT_ID` and `XERO_REFRESH_TOKEN` in the environment. Keep the values out of files and logs.
3. Run one `scan` by hand against a Xero demo organisation and check the task names and the invoice list against Xero. Then run one `chase` and check the queued summaries.
4. Check that each contact who owes money has an email address in Xero. A chase to a contact with no email fails at approval.

## When a task or a chase needs a decision
- A task named `Due <date>: <project>` means the project deadline is inside the window. Check the work is on track, then close the task in Xero when the deadline is met.
- A chase in the approvals list shows the invoice number, the amount owed, the days overdue and the contact. Approve it only if the contact is right and the client has not agreed a new date or paid.
- If a client has agreed a new payment date or a new project deadline, do not approve the chase. Change the date in Xero yourself. Moving a deadline is not automated here.

## Not covered
Statutory and tax due dates (BAS, PAYG and ATO lodgments). Asking for an extension. Confirming work is done. Escalating a missed deadline. Assigning work to a person. Xero's own automatic reminders, which cannot be switched on from here. The practice's own compliance calendar keeps those dates. The judgment steps stay with the practice.
