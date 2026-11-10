---
name: contracts-esign
description: Agreements sent for e-signature through DocuSign, with the signed status tracked back to the record. Use when setting up contract signing for a business, when an agreement sits at needs-check, or when an owner asks why a contract has not gone out or been signed.
---

# Contracts for e-signature

Takes a prepared agreement, builds it as a DocuSign envelope kept in draft, queues the send for a person to approve, and tracks the signatures until the envelope is complete. Filing the signed copy into the business's own records is not built yet. Crons read and draft; a person approves every send.

## What runs on its own
Three crons in `index.ts`, scheduled by `workflow.json`:
- `prepare` (every 15 minutes) checks each new agreement record, then saves it in DocuSign as a draft envelope.
  Nothing is emailed.
- `dispatch` (twice an hour) queues each drafted envelope's send for approval.
- `status` (hourly) marks approved sends as sent and reads signature progress back from DocuSign.

The crons read and draft only. Sending an envelope emails the signers, so every send waits for a person to approve it
in the CRM shell.

## Setting it up for a client
1. Fill `settings.json` from `settings.example.json`: the business name, and the subject prefix on signing emails.
2. Connect DocuSign with the `DOCUSIGN_*` keys, and have the user the integration acts as grant consent once.
3. Agree which agreements the business sends, who signs them and in what order.

## Preparing an agreement
The agreement record holds the title, the signers in signing order (name and email), and the PDF as base64.
Check the PDF against the source before it is written: the signer details come from the business, not from a guess.
A record that fails a check (no signer email, not a PDF, over 10 MB) is parked at needs-check with the reason.
Fix the record and set it back to new.

## When an agreement is at needs-check or the send was rejected
Read the reason on the record. A rejected send leaves the envelope as a draft in DocuSign, and nothing reissues it on its own.
Ask the owner whether to send it again before changing the record.

## Not covered yet
Signing field placement, filing the signed copy, the register, reminders to signers and the request that starts an agreement.
Do these the business's usual way. See `workflow.json` gaps.
