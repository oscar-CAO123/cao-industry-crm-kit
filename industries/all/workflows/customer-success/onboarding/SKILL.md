---
name: all-onboarding
description: Onboarding a new client into the business's own systems: a HubSpot contact record, a Google Tasks checklist, HubSpot team invitations, and a welcome email. Use when setting this up for a client, when a client is missing from the list, or when an owner asks why a welcome or invitation has not gone out.
---

# Onboarding

Onboards a new client: a HubSpot contact record, a checklist of onboarding steps in Google Tasks, team invitations in HubSpot, and a welcome email. Crons read and draft; a person approves every invitation and every email.

## What runs on its own
Three crons in `index.ts`, scheduled by `workflow.json`:
- `setup` (every 30 minutes) creates a HubSpot contact record and a Google Tasks checklist for each new client, reads the payment
  setup, and queues HubSpot team invitations for approval.
- `welcome` (hourly) drafts the welcome email in Gmail for each client that is set up, and queues its send for approval.
- `progress` (daily) reads each checklist and drafts a short internal note to the owner when the open count changes.

The crons read and draft only. An invitation emails the invitee, and a welcome email goes to the client. Both wait for a person
to approve them in the CRM shell. Nothing in this skill changes that.

## Setting it up for a client
1. Fill `settings.json` from `settings.example.json`: the business name, the owner's address for progress notes, the checklist
   steps in order, and the client list.
2. For each client, add the name, the company, the client's email and the people to invite. The HubSpot role id and team id
   come from the client's own HubSpot account, and they set each invitee's access.
3. Check the welcome email wording with the owner before the first run.

## When a client is missing or stuck
- A client not on the list is not onboarded. Add the client to `settings.json`. A signed deal does not add one automatically.
- A client with no email gets a contact record and a checklist, but no welcome email. Add the email to continue.
- A client whose invitation is not in the approval queue has a bad role or team id, or a bad email. The run stops with the reason.

## Judgment steps the owner does
Contract signing, collecting the client's details, payment set-up, training sessions and connecting the client's email, calendar
or phone. Record each one done on the checklist in Google Tasks. The `progress` cron counts them.

## Not covered
Deal and quote intake, contract signing, invoices and payments, Typeform intake, training scheduling, channel connections,
bulk data import, and the common tools that have no mapped onboarding steps (Microsoft 365, GoHighLevel, Xero, Slack,
Deputy, Monday.com, ELMO, Procore, AgentBox, Fill Out). Do these the business's usual way.
