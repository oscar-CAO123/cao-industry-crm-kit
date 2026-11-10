---
name: transport-fuel-tax-credits
description: Fuel tax credit claim worksheet for a transport business, from Xero fuel bills and the MYOB fuel tax credit account. Use when setting up the claim for a client, when the claim cron reports needs-usage, or when an owner asks why the BAS fuel tax credit is off.
---

# Fuel tax credits

Works out the fuel tax credit a transport business can claim for a BAS period from its fuel purchases and its off-road use. Crons read the fuel bills and the fuel tax credit account and draft a claim worksheet; a person records off-road litres and the ATO rate, and the claim is lodged by hand in the BAS.

## What runs on its own
Three crons in `index.ts`, scheduled by `workflow.json`: `purchases` keeps the fuel bills in the BAS period from Xero,
`ledger` keeps the fuel tax credit account balance from MYOB, and `claim` drafts the claim worksheet for the period.
They read and draft only. Nothing is written to Xero or MYOB, and nothing is lodged.

## Setting it up for a client
1. Fill `settings.json` from `settings.example.json`: the BAS period dates, and the MYOB account name for the fuel tax credit.
2. Confirm the client is registered for GST and for fuel tax credits with the ATO before the first claim.
3. Confirm the fuel bills in Xero are coded to a fuel account, so the keyword match finds them.

## Each period
1. Record the off-road litres for the period and the ATO rate per litre in the usage record (store key `usage`, the period key `<period_start>_<period_end>`). Take the litres from the business's logbook or telematics export and say where they came from in `source`.
2. The `claim` cron then marks the worksheet `ready-for-review` with the eligible amount (litres times rate).
3. A person checks the worksheet against the fuel tax credit account, then enters the amount in the BAS fields by hand. MYOB links them in BASlink. Xero has no fuel tax credit field in the docs read.

## When the worksheet says needs-usage or invalid-usage
- `needs-usage`: no usage record for the period. Record the litres and the rate (step 1).
- `invalid-usage`: the litres or the rate is out of range. Re-check the export and the rate table.

## Not covered yet
Usage capture from telematics (Trackunit's fuel series are mapped as writes in the kit, WEBFLEET is not mapped), the on and off-road split, rate lookup, posting a journal in MYOB, reconciliation, and year-end checks. See `workflow.json` gaps.
