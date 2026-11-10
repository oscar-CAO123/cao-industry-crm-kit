---
name: professional-services-conflict-check
description: Conflict check for a law or professional services practice on Smokeball. Use when setting up conflict checks for a client, when a lead shows name matches, or when a partner asks why a lead has not opened as a matter.
---

# Conflict check

Checks the parties on a new client or matter against the practice's existing contacts before it opens, and queues opening a clear lead as a matter for approval. Crons read and queue; a person approves every change to a live record.

## What runs on its own
Three crons in `index.ts`: `intake` collects new leads from Smokeball, `check` reads the parties on each lead and searches
the contacts for their names, and `open-matter` queues opening each clear lead as a matter. They read and record only.
Opening a lead is a live change and waits for a partner to approve it in the CRM shell.

## Setting it up for a client
1. Confirm the practice runs Smokeball and has a sandbox account. Fill `settings.json` from `settings.example.json`.
2. Confirm which name search the practice wants. The search here is a name match against Smokeball contacts, not
   Smokeball's own conflict engine.

## Judgment steps a person does
- Review every lead with name matches in Smokeball. Decide whether each hit is a real conflict or a false hit.
- Decide on an ethical wall, a client notice, or a decline. None of these is automated.
- Approve the open-matter queue item only after the parties are confirmed.
- Recheck a matter when new parties appear. This is not automated.

## Not covered yet
Actionstep (no mapped operations in the kit), Smokeball's own conflict engine (its docs describe none), recording a partner's
decline in the workflow store, and periodic rechecks.
