---
name: real-estate-bond-lodgement
description: Keeps a rental bond register from VaultRE and queues a reminder to claim or release a receipted bond once its tenancy ends. Lodging with a state bond authority is not automated. Use when a property manager asks about bonds held in the property system.
---

# Lodge and claim rental bonds (real estate, finance and admin)

## What runs on its own
- `register` (hourly): reads tenancies from VaultRE and drafts one row per live tenancy in the bond register workbook. A row shows the receipted amount, or NOT RECEIPTED.
- `release-check` (daily): for each receipted bond whose tenancy has ended, drafts a reminder in the bonds mailbox and queues its send to the team. Nothing is sent until a person approves it.

## Setup
- VaultRE: `VAULTRE_ACCESS_TOKEN` and `VAULTRE_API_KEY`, read from the environment only.
- Microsoft 365: `M365_ACCESS_TOKEN`, and the bonds mailbox set in settings.
- Copy `settings.example.json` and fill in the mailbox, the team address and the register workbook ids.
- Docs-only until a VaultRE sandbox and a Microsoft 365 developer tenant prove the calls.

## Judgment steps the person does
- Lodge the bond with the state bond authority (NSW Rental Bonds Online, VIC RTBA or another) when the register shows it is missing.
- Claim or release the bond on the reminder, then record the outcome in the property system.
- Handle top-ups, transfers, exit inspections and disputes.

## Not covered
- Lodgement, claims and releases with any state authority: no mapped platform can do them.
- Console (Reapit PM) and PropertyMe: no adapter. Re-Leased is mapped but has no bond field, so it has no adapter.
- Reconciliation against authority statements, top-ups, transfers and trust allocation.
- A register row is written once; a later receipt does not update it.
