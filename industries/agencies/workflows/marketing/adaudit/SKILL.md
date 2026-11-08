---
name: agencies-daily-ad-audit
description: Daily ad audit for an agency running client ad accounts. Use when setting up the audit for a client, when the audit cron queues a pause for approval, or when an account manager asks why a campaign was flagged.
---

# Daily ad audit

Built from how agency owners described their daily ad audit on discovery calls. The mapped platform for this build is Meta.

## What runs on its own
Two crons in `index.ts`, scheduled by `workflow.json`. `pull` reads yesterday's campaign results for each Meta ad account in settings.
`audit` checks the newest snapshot against the thresholds, stores the findings, and queues a pause for any campaign that spent past the
limit with no results. Nothing changes in an ad account until a person approves the queued pause.

## Setting it up for a client
1. Fill `settings.json` from `settings.example.json`: the agency name, the Meta ad account ids, which action types count as a result,
   the thresholds, and each account's daily budget.
2. Check the thresholds with the account manager before the first run.

## The judgment steps
- Tracking: confirm pixel and conversion events are firing in Events Manager. No mapped read covers this.
- Creative and targeting: review what the flagged campaigns are running and why.
- Priorities and the client note: decide what matters today and write the note by hand.

## Not covered yet
TikTok Ads, Google Ads (no adapter yet), pixel checks and any write other than a campaign pause. See `workflow.json` gaps.
