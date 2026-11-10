---
name: all-numbers-pack
description: Weekly or monthly numbers and profit pack for a business owner, built from the ledger. Use when setting up the numbers pack for a client, when the pack draft is missing for a period, or when an owner asks why this period's pack has not appeared.
---

# Numbers pack

Weekly or monthly numbers and profit pack for the owner: reads the profit and loss and the bank position from the ledger, stores them, and drafts the pack for the owner to read and comment on. Crons read and draft only; nothing is sent.

## What runs on its own
Three crons in `index.ts`, scheduled by `workflow.json`: `data-pull` reads the profit and loss for the period on the due day,
`cash-check` reads the bank summary daily, and `pack-build` drafts the pack from the stored snapshots on the due day.
They read and draft only. Nothing is sent, paid or changed in the ledger.

## Setting it up for a client
1. Confirm the ledger. This version reads Xero only. Fill `settings.json` from `settings.example.json`: the business name, `ledger` and `cadence` (weekly or monthly).
2. Confirm the Xero sign-in and the tenant for the client's organisation, then run one read by hand to check the report shape.
3. Agree with the owner which lines they read first. The pack shows every line the ledger returns, in the order it returns them.

## When the pack is missing
A pack is only drafted on a due day when the profit and loss snapshot for that period exists. If it is missing, check the `data-pull`
run for that day. A snapshot that is not there means the read failed or the day was not due. Read the error before re-running.

## Judgment the owner or agent does
- Write the commentary. The pack says it is not written yet until someone does.
- Check costs against budget and review job or product profit. No ledger operation for either is mapped yet.

## Not covered yet
MYOB, forecast and cash flow, budget against actual, the owner's sends and other systems (Shopify, Meta Ads, Deputy, Roller and the rest). Do these the business's usual way.
