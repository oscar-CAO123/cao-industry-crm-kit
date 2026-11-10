---
name: referral-partners
description: Leads that partners refer into the business's pipeline, with a receipt and stage updates sent back to each referring partner after a person approves. Use when setting up referral sharing for a client, when a partner asks why they have not heard back, or when a referred lead is missing from the queue.
---

# Referral partners

Takes leads that partners refer into the business's pipeline, keeps each referring partner in the partner list, and queues a receipt and stage updates for that partner. Crons read and draft; a person approves every tag or contact change that reaches a partner.

## What runs on its own
Three crons in `index.ts`, scheduled by `workflow.json`. `intake` records referred leads. `acknowledge` queues one receipt per new referral. `progress` queues a stage tag when a referred deal reaches a mapped stage. They read and queue only. Nothing reaches a partner until a person approves the queued item in the CRM shell.

## Setting it up for a client
1. In Pipedrive, make a lead label for referrals and a lead custom field for the referring partner's email. Fill `settings.json` from `settings.example.json` with the label UUID, the field key and the stage tags.
2. In ActiveCampaign, build the partner automation yourself: trigger on the acknowledged tag and on each stage tag, then send the email the business wants. This workflow applies tags only.
3. Map each Pipedrive stage that partners should hear about to a tag in `stage_tags`.
4. Test one referral end to end on a test contact before turning the crons on.

## Judgment steps the business does
- Qualifying the referred lead and agreeing terms with the partner: in the business's usual way, recorded in Pipedrive.
- Referral fees and thank-you rewards: paid outside this workflow.
- AML and consent checks on referred clients: the business's own process.

## Not covered yet
See `gaps` in `workflow.json`: Mailchimp and the referral portal are not built, sharing lead detail with a partner and per-partner review are not built, and the partner emails are not written here.
