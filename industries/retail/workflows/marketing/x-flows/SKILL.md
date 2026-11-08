---
name: retail-email-flows
description: Email flows for a retail or D2C business run in Klaviyo. Use when setting up the flow crons for a client, when the review cron opens a sprint on a weak flow, or when an owner asks why a replacement flow has not gone live.
---

# Email flows

Built from how retail owners described running their email flows on discovery calls (2 of 5 read calls go into it).
The owner reviews the emails due out, checks the numbers by hand against benchmarks each day, and works out which flow to
fix next on a 30 to 90 day sprint. One call puts the full rewrite at about 90 days at two emails a week.

## What runs on its own
Three crons in `index.ts`, scheduled by `workflow.json`:
- `performance` (daily) reads every flow and its results into the scorecard.
- `review` (weekly) opens one sprint on the weakest live flow that is under target and has no sprint yet.
- `go-live` (daily) queues the switch to live for each draft flow the owner has marked ready.

They read and record. Nothing goes live, is sent or changes for customers until a person approves it in the CRM shell.

## Setting it up for a client
1. Fill `settings.json` from `settings.example.json`: the conversion metric the Klaviyo flows page uses (its id), the
   timeframe, the target conversion rate, and the minimum recipients before a flow is judged.
2. Put `KLAVIYO_API_KEY` in the environment and set `KIT_ALLOW_WRITES=1` on the deploy. The results query is a POST the
   spec marks as a write, so the performance cron is blocked without it.
3. Agree the target with the owner before the first review runs.

## Working a sprint
When `review` opens a sprint, the sprint record names the live flow under target and its action ids. Then:
- Build the replacement in Klaviyo as a draft, with the copy, design and trigger the owner approves.
- When the owner says it is ready, mark the draft's flow id as ready in the store (the `ready` namespace, keyed by that id).
- `go-live` queues the switch for approval. The owner approves it in the CRM shell.

## Judgment steps the agent does
- Write the replacement copy and subject lines in the client's brand voice. Read the client's context docs first.
- Choose the trigger and the conditions, and decide whether the replacement replaces the weak flow or adds to it.
- Decide whether a weak flow is rewritten or stopped. Do not edit a live flow's messages through this workflow.

## Not covered yet
Writing messages into Klaviyo, test sends, segment building, list hygiene, data sync, and Mailchimp or Shopify
flows. A client on either of those gets the Klaviyo parts of this only where Klaviyo is also in use.
