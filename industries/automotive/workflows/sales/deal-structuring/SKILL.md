---
name: automotive-deal-structuring
description: Structures vehicle deals and finance with lenders inside the CRM. Use when a dealer or broker asks to work out which lenders to send a vehicle finance deal to, to check a credit application is ready, or to chase a lender that has not decided.
---

# Automotive deal structuring

## What runs on its own

Three crons, all read-and-draft:

- **intake** (every 10 minutes) reads deals in the CRM intake stage and records new ones.
- **draft** (every 15 minutes) acts only on deals whose proposal is marked `credit_ready`. It drafts one Outlook pack per lender, notes the deal in the CRM, logs a register row, and queues each lender send for approval. The approval also moves the deal to the lender-submitted stage.
- **follow-up** (daily) marks a deal submitted once its send is approved, and queues a chase when a lender has not decided after the days set in settings.

Nothing sends, moves a deal or changes a record a customer sees without a person pressing approve.

## Setup

1. Copy `settings.example.json` and fill in the Pipedrive pipeline and stage ids, the client's own mailbox, the register table, and each lender's submission address.
2. Put `PIPEDRIVE_API_TOKEN` and `M365_ACCESS_TOKEN` in the environment. Never in a file.

## Judgment steps (the agent does these)

- **Check the credit application.** Read the deal and confirm the application is complete and consent is on file. Only then write a proposal.
- **Write the proposal.** Store it under the deal id with `lenders` (ids from settings, in the order to submit), `amount_financed`, `term_months`, an optional `note`, and `credit_ready: true`. Use `credit_ready: false` while anything is missing. Do not compute rates or payments as fact: state them as estimates the dealer confirms.
- **Record a decision.** When a lender answers, store `decided` on the deal with the date. The chase stops from then on.

## Not covered

See `workflow.json` `gaps`. The main ones: no dealer-system platform is mapped (AutoManager, Autosoft and Mercury had no ops in the kit), lender decisions do not return by API, compliance checks, credit pulls, settlement, delivery and accounting are not built.
