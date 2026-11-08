---
name: hospitality-stock
description: Drinks counted by hand in a bar, cellar or venue, checked against the POS system count and posted to the POS as physical counts once a person approves them. Use when setting up drinks stocktakes for a hospitality client, when an owner asks why a count has not posted, or when a count shows a large difference.
---

# Drinks counted by hand

Built from 2 discovery calls with hospitality businesses. Those calls did not describe the steps or the tools in
enough detail, so the steps here follow the platform evidence: Square's inventory API, plus the Eats365 and
Lightspeed docs, which have no mapped API yet.

## What runs on its own
Three crons in `index.ts`, scheduled by `workflow.json`. `snapshot` reads the system stock of each tracked drink at each
active location. `reconcile` compares each new hand count with the current system count and writes the differences.
`post-counts` queues each reconciled count as a physical count for approval. The crons never change the POS. A person
approves each queued count in the CRM shell.

## Setting it up for a client
1. Confirm the client's POS. Only Square has mapped inventory operations so far. For Eats365 or Lightspeed, confirm an API
   operation list before building anything.
2. Put the Square access token in the secret store as `SQUARE_ACCESS_TOKEN`. Never put it in settings. The token needs
   inventory read and write, and merchant profile read.
3. Fill `settings.json` from `settings.example.json`: the Square location ids to count (leave the list empty for every
   active location) and `max_variations`.
4. Turn on inventory tracking in Square for each drink that is counted. The snapshot reads only tracked items.

## Recording a count
The workflow has no adapter for the count sheet yet. Record the owner's count as a count record in the `counts` store
with status `new`: `id` (letters, digits, colon, dot, underscore or hyphen, starting with a letter or digit),
`location_id` (the Square location id), `taken_at` (ISO time of the count), and `lines`, each with `catalog_object_id`,
`name` and `quantity` (whole bottles or fractions up to three decimals). Read the quantities from the owner's sheet.
Do not guess a quantity the sheet does not show.

## When a count shows a difference
`reconcile` writes one variance row per line: the hand count, the system count and the difference. A difference is a
prompt to ask, not a result. Likely causes are a miscount, a spill or breakage, a drink served but not rung up, or a
staff drink not logged. Ask the owner which one before approving. To stop a count from posting, reject its approval in
the CRM shell. Do not approve a count the owner cannot explain.

## Not covered yet
Sales against usage, reorder and par levels, deliveries and supplier invoices, transfers and waste as records of their
own, cost reporting, and the count sheet itself (paper, Excel or form). Do these the venue's usual way, and record the
result so the next count starts from the right number.
