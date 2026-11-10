---
name: professional-services-add-bas
description: BAS first pass for an accounting practice's client in Xero. Use when setting up BAS prep for a client, when code-lines has nothing to queue, or when the accountant asks what must be checked before the BAS goes in.
---

# BAS first pass

Prepares the BAS first pass for an accounting practice's client in Xero: reads the period's bank transactions, queues the agreed coding for approval, and lists what the accountant must check by hand before the return. Crons read and queue; an accountant approves every change and lodges the BAS.

## What runs on its own
Three crons in `index.ts`, scheduled by `workflow.json`:
- `pull-period` reads the period's authorised bank transactions and tax rates from Xero.
- `code-lines` queues a coding change for each single-line, unreconciled transaction that an agreed rule matches.
- `exceptions` lists what the accountant must check by hand.

They read and queue only. A coding change edits the books, so it waits in the approval queue until an accountant approves it.
Nothing lodges, nothing sends, and no BAS is filed by these crons.

## Setting it up for a client
1. Fill `settings.json` from `settings.example.json`: the business name, the first day of the BAS period, and the coding rules.
2. Agree the coding rules with the accountant. The example codes (408, 400) are placeholders. Every rule is a match word,
   an account code and a Xero tax type, and a rule with no agreed code is not added.
3. Confirm the period start is the first day of the quarter being prepared.

## When code-lines has queued nothing
Check first that pull-period has run for this period. Then check that the transactions are single-line, unreconciled and
authorised, and that a rule's match word appears in the contact, reference or description. Multi-line transactions never get
a queued coding change; the exceptions list shows them for the accountant.

## Judgment the accountant does
- Choose the account for a payment that no rule covers, and whether a line is GST-free or input-taxed.
- Review each queued coding change in the approval queue before approving it.
- Prepare the BAS from the reviewed lines, sign it off, and lodge it with the ATO.

## Not covered yet
MYOB (only its GST tax-code operations are mapped), document contents (the cron flags missing documents but does not read them),
the BAS form itself, reconciliation changes, and lodgement. See `workflow.json` gaps.
