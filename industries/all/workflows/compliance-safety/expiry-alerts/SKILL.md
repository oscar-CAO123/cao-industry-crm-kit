---
name: expiry-alerts
description: Use when a business keeps licences, certificates or document expiry dates in one Excel register and needs each holder reminded before a date lapses. The crons read the register, draft each reminder and a weekly owner digest in Outlook, and queue each reminder send for approval. Nothing is sent without a person.
---

# Expiry alerts

## What runs on its own

- **scan** (daily): reads the register and records each item as expired, due, ok or unknown. Drafts and queues nothing.
- **remind** (daily): for each item inside the reminder window or already lapsed, with a valid holder email, creates an Outlook draft to the holder and queues its send. One reminder per item per expiry date.
- **digest** (weekly, Monday morning Sydney time): creates one owner digest draft listing lapsed and soon-due items, and any item with no valid email.

## Setup

1. Make one Excel table in OneDrive or SharePoint with four columns: Holder, Email, Item, Expiry.
2. Fill `settings.example.json` with the mailbox, the drive, workbook item and table ids, and the owner email. Keep the Graph token in the environment, never in the file.
3. Expiry cells can be ISO dates (2026-11-20), Australian dates (20/11/2026) or Excel date values.

## Judgment the agent does

- Checking a renewed document (its name, its holder, its new expiry date) stays with a person. A person updates the Expiry cell, then the next scan picks it up.
- Reading a holder's reply or a renewal that arrives by email is done by a person.

## Not covered

- Simpro, HammerTech and SiteBook: no adapters yet (see gaps in workflow.json).
- Escalation beyond the owner digest, and booking renewal visits by route.
- Writing renewal dates back to the register.
