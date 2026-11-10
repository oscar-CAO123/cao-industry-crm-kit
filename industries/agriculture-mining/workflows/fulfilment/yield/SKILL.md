---
name: agriculture-mining-yield
description: Yield and waste for a packing shed or grower, from the shed's yield register in Microsoft 365 Excel. Use when setting up yield tracking for a client, when a lot is missing from the report, when an exception row needs a look, or when an owner asks why the weekly yield report has not gone out.
---

# Yield and waste

Works out yield and waste for each lot from the shed's yield register, flags lots that fall short of target or run over the waste limit, and drafts the weekly yield and waste report. Crons read and draft; the report email waits for a person to approve it.

## What runs on its own
Three crons in `index.ts`, scheduled by `workflow.json`: `intake` reads the yield register every 30 minutes, `yield-check` works out
yield and waste per lot every hour and writes one exception row per lot that falls short, and `owner-report` drafts the week's report
on Sunday 22:00 UTC and queues its email. They read and draft only. The report email is sent only when a person approves it.

## Setting it up for a client
1. Create two Excel tables in the shed's workbook: a register with the columns Date | Lot | Area | Gross kg | Packed kg | Waste kg,
   and an exceptions table (Date | Lot | Yield % | Waste % | Reasons | Status).
2. Fill `settings.json` from `settings.example.json`: the mailbox that sends the report, the owner's email, the two table ids, the
   yield target and the waste limit. Get the drive and item ids from Microsoft Graph for the workbook.
3. Confirm with the owner what yield target and waste limit they want. The example values (85% and 8%) are a starting point only.

## Rows the shed writes
A register row must have a lot code, gross kg above zero, packed and waste kg of zero or more, and packed plus waste no more than gross.
A row that fails any of these is refused and counted in the log, not guessed at. Fix the row in the register and the next intake run
picks it up.

## When a lot shows as an exception
The exceptions table has one row per lot. It stays until the owner changes its status. To clear one that was wrong, correct the lot in
the register and remove the exception row by hand; the workflow store keeps its record so the same lot is not written twice.

## Deciding what to do
The workflow reports what the weights say. Grade and pack-out, reasons for waste, and whether a lot should be sold, held or re-graded are
judgment calls that stay with the owner and the shed.

## Not covered yet
Reading bins and weights straight from FreshTrack, CropX or the Operations Center, weigh-at-intake, grade and pack-out splits, waste by
reason, stock transfers and sales reconciliation. Agworld and innovint have no mapped operations in the kit. Until those exist, the shed
copies its weights into the register and the rest of the job stays with the business.
