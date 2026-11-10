---
name: all-regulator-lodgements
description: Logs regulator notices, reports, permits and disputes in a lodgement register and drafts reminders for the owner, through the compliance mailbox in Microsoft 365. Use when setting up regulator tracking for a client, when a regulator notice is not showing in the register, or when an owner asks why a reminder has not come through.
---

# Regulator lodgements

Built to support lodging with regulators such as ASIC, NHVR and QBCC. The crons watch the mailbox and keep the register. A person does the lodging.

## What runs on its own
Three crons in `index.ts`, scheduled by `workflow.json`. `intake` reads regulator notices from the compliance mailbox. `register` writes one row per new notice to the lodgement register and queues an internal note to the owner. `reminders` queues a daily reminder to the owner for each open item due within the window. They read and draft only. Every email to the owner waits for a person to approve it. Nothing is lodged, answered or paid by these crons.

## Setting it up for a client
1. Fill `settings.json` from `settings.example.json`: the compliance mailbox, the owner's email, the search word regulators use, and the register table.
2. Set `notice_rules` with the business's own due windows. The regulator docs give no deadlines, so the owner sets them.
3. Create the register as an Excel table with the columns Date, Key, Notice, From, Due, Status, using the status Open for items still to lodge.

## When a judgment step comes up
The crons do not prepare, check or lodge anything. For each open item the person gathers the records, prepares the report in the regulator's portal, checks it, lodges it, pays any fee, and keeps the confirmation. They answer any regulator query and decide any objection. Then they mark the row Lodged in the register. Do these the way the business already does and keep the register current.

## Not covered yet
Lodgement itself for ASIC, NHVR and QBCC, their forms, fees and objection routes. Each regulator's portal has no mapped operations in the kit. Also not covered: updating a register row from an agent, and any regulator that does not write to the mailbox.
