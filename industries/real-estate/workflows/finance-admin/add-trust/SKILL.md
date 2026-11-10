---
name: real-estate-add-trust
description: Trust account reconciliation support for a real estate agency, reading trust accounts and sale trust ledgers from VaultRE and writing a trust register in Microsoft 365. Use when setting up trust reconciliation for a client, when an exceptions email is waiting for approval, or when the principal asks why an entry was flagged.
---

# Trust reconciliation

Reads the agency's trust accounts and each configured sale's trust ledger from VaultRE, adds new ledger entries to the trust register, and drafts one email to the principal listing entries that are missing a receipt number, contact or trust account. Bank matching, the three-way check, owner payments, sign-off and lodgement stay with a person.

## What runs on its own
Two crons in `index.ts`, scheduled by `workflow.json`. `accounts` reads the trust accounts and adds a register row when one is
added or dropped. `ledger` reads each configured sale's trust ledger, adds new entries to the register, and drafts one email to
the principal listing entries with no receipt number, no contact or no trust account. That email is queued for approval.
Nothing is sent without a person approving it.

## Setting it up for a client
1. Confirm the platform: VaultRE is the one mapped here. Console, MantisProperty and PropertyMe are not mapped, so this skill does not cover them yet.
2. Fill `settings.json` from `settings.example.json`: the finance mailbox, the principal's address, the register workbook, and the sale lives to watch (property id and sale life id from VaultRE).
3. Check with the principal which trust account is used for sales and which for property management before the first run.

## When an exceptions email is waiting for approval
Open the approval in the CRM shell. Check each listed entry in VaultRE and in the bank. Fix the entry in VaultRE if it is a keying error. Reject the approval if the entries are already resolved.

## Not covered
Bank feed import, matching bank items to the ledger, the three-way balance check, resolving differences, owner disbursements, the principal's sign-off, the lodgement of the trust account report, and any mapped write to VaultRE.
