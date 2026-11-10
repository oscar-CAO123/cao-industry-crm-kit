---
name: hospitality-comp-watch
description: Paid sales from Square, every discount on each sale checked against the agreed terms, flags for comps and discounts outside them, and a daily count per venue. Use when setting up comp and discount watching for a hospitality client, when a flag looks wrong, or when an owner asks why revenue reads low.
---

# Comp and discount watch

Reads each venue's paid sales from Square, checks every discount on them, and flags comps and discounts outside the agreed terms, with a daily count per venue. The crons only read and record; nothing in Square is changed.

## What runs on its own
Two crons in `index.ts`. `watch` reads each venue's new paid sales from Square every 30 minutes and checks each sale's discounts: a discount not on the allowed list, a percentage over the threshold, or a 100 percent comp is flagged. `report` counts yesterday's sales, discounted sales, flags and discount dollars per venue, once a day. Both read and record only. Nothing in Square is changed and nothing is sent.

## Setting it up for a client
1. Fill `settings.json` from `settings.example.json`: one entry per venue with its Square location id, the venue's UTC offset, the discount names the business accepts, and the percentage threshold (default 10).
2. Set `SQUARE_ACCESS_TOKEN` in the client's secret store. Never write it into settings.
3. Agree the allowed discount names and the threshold with the owner. The workflow does not set discounts in Square.

## When a sale is flagged
Read the flag: its reasons, its discounts, its dollars and the team member on the payment. Look at the sale in Square. A discount on the allowed list at or under the threshold never flags. Whether the sale was right is a person's call, made in Square.

## When the daily count looks wrong
A venue with no sales in the store for the day has either no paid sales in Square or a location id that is wrong. Check the location id first. The first run looks back 24 hours only.

## Not covered yet
Roller (not in the kit), Lightspeed and BePoz, comp approval before a discount is given, Square's discount passcode, staff meals, stock and waste, and shift review. See `workflow.json` gaps.
