---
name: automotive-vehicle-listing
description: Lists vehicles for sale from the stock register, with photo checks, listing copy and ownership transfer checklists, all through the business's own mailbox and workbook. Use when a dealer asks to list a vehicle, when the photo cron parks a vehicle as needing photos, or when a listing copy or transfer checklist has not gone out.
---

# Automotive vehicle listing

## What runs on its own

Four crons, all read-and-draft:

- **intake** (every 10 minutes) reads the stock register. A row marked `To list` with a price and a photo folder becomes a vehicle record.
- **photos** (hourly) counts image files in each open vehicle's photo folder. A vehicle is ready at the minimum.
- **draft** (every 15 minutes) acts on ready vehicles that have listing copy. It drafts the copy as an Outlook message to the listing desk, logs a row in the listing register, and queues the send for approval.
- **follow-up** (daily) marks a listing live once its send is approved, and queues an ownership transfer checklist for each sold vehicle.

Nothing sends, publishes or changes a record a customer sees without a person pressing approve. Nothing here publishes to a listing site.

## Setup

1. Copy `settings.example.json` and fill in the client's mailbox, the stock register table, the listing register table, the photo drive, the listing desk address and, if used, the transfer desk address.
2. Set up the stock register with the columns in this order: Stock, Year, Make, Model, Price, Status, PhotoFolderId. The photo folder id is the OneDrive folder for that vehicle.
3. Put `M365_ACCESS_TOKEN` in the environment. Never in a file.

## Judgment steps (the agent does these)

- **Write the listing copy.** Read the vehicle's record, its photos and the owner's notes. Write the copy as plain paragraphs and store it under the vehicle's stock key as `proposals` with `description`. Keep claims to what the owner has confirmed. Do not invent history, features or condition.
- **Mark a vehicle sold.** When a sale is confirmed, store `sold: true` on the proposal. The transfer checklist is queued on the next follow-up run. Buyer details stay out of the proposal and out of every email.
- **Check photos before listing.** Where the photo count is short, the agent can flag the vehicle for a person. Do not write a description for a vehicle that is not ready.

## Not covered

See `workflow.json` `gaps`. The main ones: no dealer system or listing site is mapped (AutoManager, Carsales, NSW Dealer Online had no ops in the kit), publishing is a person's step, ownership transfer forms and the state registry are not built, and inspection, history reports, valuation and price comparison are not built.
