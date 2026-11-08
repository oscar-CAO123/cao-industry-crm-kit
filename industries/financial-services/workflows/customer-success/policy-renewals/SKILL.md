---
name: financial-services-policy-renewals
description: Policy renewals and endorsements with underwriters and clients for a motor vehicle broker, in Outlook and an Excel policy register. Use when setting up renewals for a client, when an endorsement request or underwriter reply needs a look, or when the owner asks why a renewal has not gone out.
---

# Policy renewals and endorsements

Built from two Australian discovery calls about motor vehicle renewals. The pattern: a renewal date comes up, a pre-renewal
email goes to the client, the client's changes go to the underwriter, the underwriter's terms come back, and endorsements
(a vehicle or driver added or removed mid-term) follow the same back-and-forth.

## What runs on its own
Three crons in `index.ts`, scheduled by `workflow.json`. `intake` reads the renewals folder and sorts what arrives.
`draft` finds policies inside the lead window in the register, drafts the pre-renewal email to the client, and drafts
endorsement emails to the underwriter. `follow-up` chases sent emails that have had no reply. They read and draft only.
Every send waits in the approval queue for the broker. Nothing in this skill changes that.

## Setting it up for a client
1. Fill `settings.json` from `settings.example.json`: the broker's mailbox, the folder that receives endorsement requests
   and replies, the underwriter's email, and the policy register.
2. Set up the policy register as an Excel table with these columns, in order: Policy | Client | Email | Renewal date | Details.
   Renewal dates can be `2026-12-01`, `01/12/2026` (day first) or a real Excel date.
3. Use one underwriter per workflow. For a second insurer, copy this folder and set its own settings.

## What the broker does
- Read the items with status needs-review: underwriter replies, unrecognised mail, and register rows that could not be read.
  Answer them the usual way.
- Read the client's answer to a renewal email. Decide the changes, then send the underwriter the endorsement or renewal request.
- Approve each queued send only after reading it. Rejecting one stops it. Follow-ups are queued after 7 and 14 days.

## Judgment the crons do not make
The premium and terms, what the client should be told about a price change, whether a change needs an endorsement,
and any money that must pass between underwriter and insured. These stay with the broker.

## Not covered yet
Writing renewal status back into the register, insurer portals, and HubSpot file notes. Do these the usual way. Each renewal
is remembered in the workflow store, so the next run does not draft the same one twice.
