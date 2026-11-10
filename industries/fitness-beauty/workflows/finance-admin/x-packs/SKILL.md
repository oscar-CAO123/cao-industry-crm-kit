---
name: fitness-beauty-packs-and-gift-cards
description: Tracks packs and gift cards for a gym, studio or salon: what value customers still hold and whether prepaid sales match deferred income. Use when setting up this workflow for a client, when a gift card balance looks wrong, or when the bookkeeper asks why the trial balance does not match prepaid sales.
---

# Packs and gift cards

Tracks packs and gift cards for a gym, studio or salon: how much value customers still hold, and whether prepaid sales match deferred income in the ledger. Crons read and write only their own snapshots. Selling, drawing down and extending class or session packs is not covered: no platform the kit maps holds them.

## What runs on its own
Two crons in `index.ts`, scheduled by `workflow.json`:
- `gift-card-balances` (daily) lists the gift cards still active in Square and their balances, and keeps that day's snapshot.
- `reconcile-deferred` (monthly) keeps the Xero trial balance at the last day of last month.

They only read and write their own snapshots. Nothing is sent, paid, refunded or changed in a customer's account.

## Setting it up for a client
1. Confirm which platforms hold the client's gift cards and books. Only Square and Xero have mapped operations here.
2. Fill `settings.json` from `settings.example.json`. Set `gift_card_state` only if the client wants another state than ACTIVE.
3. Check with the bookkeeper which ledger line holds deferred income for prepaid packs and gift cards.

## The judgment steps the agent does
- When the trial balance is kept, match the deferred income line to the gift card total from the same month. Explain any gap in plain words.
- When a snapshot has skipped cards, read the store entry and say which card ids could not be read and why.

## Not covered
Class and session packs, pack expiry, pack renewal, issuing or redeeming gift cards, refunds and extensions, and any customer
message about a pack. No mapped platform covers these for this job. Fresha, Mindbody and Vagaro are not mapped here.
