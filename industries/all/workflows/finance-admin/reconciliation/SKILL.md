Reconciles payments, bank and payouts: reads bank lines and processor payouts, matches each payout to its deposit and each receipt to its invoice, notes the matches, and queues every payment for approval. Crons read and draft; a person approves every ledger write.

# Reconciliation

## Not covered yet
Supplier payments, fee and adjustment postings from Stripe, owner transfers, the accountant hand-off and MYOB. Do these the usual way.
The gaps list in `workflow.json` says which steps and why.
