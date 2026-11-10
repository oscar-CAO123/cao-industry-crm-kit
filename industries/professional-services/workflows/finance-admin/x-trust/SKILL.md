---
name: professional-services-trust-accounting
description: Trust accounting for a professional services practice on Smokeball. Flags negative matter balances and unallocated trust transactions, and queues disbursements from trust for approval. Use when setting up trust accounting for a client, when a disbursement is parked as needs-check, or when a flag needs a person's decision.
---

# Trust accounting

Trust accounting: reads trust balances and receipts, and queues disbursement requisitions for approval. Crons read and flag; a person approves every payment out of trust.

## What runs on its own
Three crons in `index.ts`. `balances` reads matter balances on each trust account each morning and flags any matter
below the floor. `receipts` reads trust transactions every 30 minutes and flags any with no matter allocated.
`disbursements` checks each recorded disbursement request against the matter's available trust balance and queues a
requisition for approval. None of them post a trust transaction or move money. Every payment out of trust waits for a
person to approve it in the CRM shell.

## Setting it up for a client
1. Fill `settings.json` from `settings.example.json`: the Smokeball trust bank accounts (ids and names), the balance
   floor, and the approver if the firm wants one. Set `SMOKEBALL_ACCESS_TOKEN` and `SMOKEBALL_API_KEY` in the environment.
2. Confirm the account is a trust account in Smokeball, not the office account.
3. Run one `balances` and one `receipts` pass by hand and check the flags against the practice's own trust ledger.

## When a flag or a parked disbursement needs a decision
- A negative matter balance means money went out of trust that was not held for that matter. Work out which entry
  caused it before anything else. The flag stays until a person clears it.
- An unallocated transaction needs a matter, or a note that it belongs to the office. Do this in Smokeball.
- A parked disbursement (`needs-check`) carries the reason in `reason_parked`. Fix the request, or decide not to pay it.
  A request with a short balance is never queued.

## Not covered
Receipts, allocation, trust ledger entries, bank matching, transfers to the office account, principal sign-off and client
statements. These stay with the practice's own process. Xero and MYOB are not mapped: their docs describe no trust account.
