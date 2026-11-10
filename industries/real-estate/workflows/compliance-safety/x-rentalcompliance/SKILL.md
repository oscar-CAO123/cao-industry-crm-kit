---
name: rental-compliance
description: Keeps rental compliance on track for a residential property manager on VaultRE. Crons read open maintenance and tasks, draft internal follow-up tasks for stalled jobs, and queue contractor bookings for approval. Use when the owner or the operator asks about rental compliance, safety certificates, smoke alarm checks or expiry tracking for a residential portfolio.
---

# Rental compliance

## What runs on its own

- **watch** (every 30 minutes) reads open maintenance jobs, open tasks and current tenants from VaultRE and keeps a snapshot. It writes nothing.
- **draft** (hourly) drafts one internal follow-up task for each open maintenance job older than `stale_days`. It runs once per job.
- **booking** (daily, 22:00 UTC) queues each new contractor booking request for approval. A person approves it before VaultRE creates the job.

Nothing sends a tenant, owner or contractor message on its own.

## Setup

1. Copy `settings.example.json` to the business's settings file and set `user_id` to the VaultRE user who should receive follow-up tasks.
2. Set `VAULTRE_ACCESS_TOKEN` and `VAULTRE_API_KEY` in the environment. Never put them in a tracked file.
3. Set `KIT_ALLOW_WRITES=1` only on the deploy that should create tasks and queue approvals.

## Judgment the agent does

- Read the safety certificate or smoke alarm record the business has on file, and say whether it is in order. The crons do not judge this.
- Turn a tenant's or staff member's report into a booking request (property, lease life, tenancy, requester, what needs doing) and record it in the `bookings` collection with status `new`. Nothing in the kit does this yet.
- Decide whether an open maintenance job is a compliance job before anyone acts on it.

## Not covered

Lease-start checklists, smoke alarm booking cycles, certificate expiry dates, entry and routine inspections, tenant notices, breach escalation and owner compliance reports. See `workflow.json` `gaps` for the full list and the reason for each.
