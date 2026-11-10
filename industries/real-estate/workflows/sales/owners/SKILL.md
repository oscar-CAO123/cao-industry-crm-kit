---
name: real-estate-owners
description: Building an owner contact list from VaultRE's current owners, checking consent before any email, and sending outreach only on approval. Use when setting up owner contacts for a real-estate client, when an owner asks to be removed, or when an owner is missing from the list.
---

# Owner contacts, built from scratch

Builds the agency's owner contact list from VaultRE's current owners, checks each owner's recorded email consent and do-not-call flag, and drafts an outreach email to owners who may be contacted. Crons read and draft; a person approves every email send.

## What runs on its own
Three crons in `index.ts`, scheduled by `workflow.json`:
- `owner-list` adds each current VaultRE owner the workflow has not seen.
- `consent-check` reads each new owner's VaultRE record and GDPR consent, and marks them eligible, no-consent or blocked.
- `outreach` re-checks each eligible owner, drafts an email in the agency mailbox, and queues its send for approval.

They read and draft only. Nothing is sent until a person approves it in the CRM shell. No call is placed, no text is sent, and
nothing is written back to VaultRE.

## Setting it up for a client
1. Fill `settings.json` from `settings.example.json`: the agency mailbox, the business name, the daily limit, and the wording.
2. Confirm the client's VaultRE consent records are kept (GDPR email flag per owner). An owner with no record is never emailed.
3. Read the outreach wording with the client before the first run.

## Judgment the agent makes
- Check each owner's identity or credit file by hand before working them. The kit does not do this.
- Check the do-not-call register by hand before any phone call. The kit places no calls.
- Read every reply. An owner who says stop, or asks to be removed, is set to blocked in the store and taken off the list in VaultRE.
- A draft can appear twice if a run crashes midway. Delete the spare draft in Outlook before sending.

## Not covered
Text (SMS) outreach, identity and credit checks, do-not-call register checks, and phone calls. These need a consent record or a
mapped operation first. See the gaps in `workflow.json`.
