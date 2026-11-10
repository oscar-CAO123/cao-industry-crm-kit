---
name: agriculture-mining-cost-of-production
description: Cost of production for a grower or livestock producer, read from their Xero books and checked against budget. Use when setting this up for a client, when an owner asks what a crop, head or tonne costs, or when the budget comparison looks wrong.
---

# Cost of production

Works out what a grower or livestock producer spends to produce a crop, head or tonne, from the books, and checks it against budget. Crons read and draft into the workflow's own store; nothing leaves the business.

## What runs on its own
Two crons in `index.ts`, scheduled by `workflow.json`:
- `actuals` (daily) reads the chart of accounts and the profit and loss report for the season, then drafts a cost summary with cost per unit when a volume is set.
- `budget-compare` (Mondays) reads one Xero budget and drafts actual against budget for each cost account.

They read the ledger and write only to the workflow's own store. Nothing is queued, sent or booked.

## Setting it up for a client
1. Confirm the client's books are in Xero. Figured, traction-ag and other farm systems are not built (see gaps in `workflow.json`).
2. Fill `settings.json` from `settings.example.json`: the season start date, the Xero account types that count as cost, and the budget id if they have one.
3. Set `volume` (unit and quantity, for example hectares or head) if the owner wants cost per unit. Xero does not hold production volume.
4. Agree with the owner which accounts are cost of production. The default is the Xero account types DIRECTCOSTS, EXPENSE and OVERHEADS.

## Judgment steps the agent does
- Decide whether an account belongs in cost of production when the account type does not settle it.
- Explain a variance from budget. The compare sums every budget balance against actuals to date, so early in a season it looks large.
- Scenario and what-if modelling, break-even, accountant review and tax treatment, lender or buyer reports, and any decision on crops, stock or selling time.

## Not covered
Costs by block or paddock (Xero tracking categories), supplier bills coded to a crop, overhead allocation, price and margin per unit, and budget pro-rating by period. Each is listed in `gaps` in `workflow.json`.
