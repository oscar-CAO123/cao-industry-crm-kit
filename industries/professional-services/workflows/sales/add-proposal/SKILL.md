---
name: professional-services-proposal
description: Scoped enquiries to a draft proposal and engagement letter in HubSpot, published only after approval. Use when setting up proposals for a professional services firm, when a proposal is stuck at scoped or drafted, or when an owner asks why a proposal has not gone to the client.
---

# Proposal and engagement letter

Built from how 4 Australian professional services firms (legal, environmental monitoring, consulting) describe writing a proposal.

## What runs on its own
Three crons in `index.ts`: `draft` creates a draft quote in HubSpot for each scoped proposal, `status` reads each quote's status back, and `publish` queues publishing for approval. Crons never publish a quote.

## Setting it up for a client
1. Fill `settings.json` from `settings.example.json`. Check every HubSpot property name, status value and the association type id in the client's live HubSpot account first. They are not in the vendor spec.
2. Confirm the HubSpot token is set as `HUBSPOT_ACCESS_TOKEN`.

## The judgment steps (the agent does these)
Read the enquiry, qualify it, ask the questions that pin down the real need, and decide the scope and fee. Write the result into the proposals store as a `scoped` proposal with the HubSpot contact id, a title, the scope and the fee ex GST. The crons take it from there.

## What is not covered
Intake of enquiries, sending the proposal by email, the signing envelope, follow-ups, Podio, Canva and ChatGPT. See `gaps` in `workflow.json`.
