---
name: agencies-creative-test-reader
description: Reads how live ad creative tests are performing on Meta and queues a pause for any losing ad for approval. Use when setting up creative testing for an agency client, when the review cron has queued a pause and an owner asks why, or when a test has no snapshot yet.
---

# Creative test reader

Reads how live ad creative tests are performing on the ad platform, keeps a snapshot, and queues a pause for any losing ad for a person to approve. Crons read and queue; nothing launches, spends or pauses without approval.

## What runs on its own
Two crons in `index.ts`, scheduled by `workflow.json`: `monitor` reads spend, impressions, clicks and CTR for each ad
and keeps a snapshot, and `review` queues a pause for each active ad that has spent past the threshold with a CTR under
the floor. Both only read or queue. A pause waits for a person to approve it in the CRM shell.

## Setting it up for a client
1. Fill `settings.json` from `settings.example.json`: the ad account id (`act_` plus digits), the reporting period, and the
   thresholds. The starting values are guesses, so agree them with the client before the review cron is relied on.
2. Check the first snapshot by hand in Ads Manager against the numbers the cron reads.

## Judgment steps the agent does
- Test brief, asset gathering, variant production and iteration: write the brief, the hooks and the next round of creative
  with the client. Ad copy and creative are judgment, not cron work.
- Read the queued pauses before approving them. A low CTR on a small spend is noise, so raise `min_spend` rather than approve it.
- Client updates: summarise the snapshot for the client in plain words.

## Not covered
Setting up, launching and scaling tests (creating campaigns, ad sets and ads, budget changes), promoting a winner,
creating new creatives through the API, TikTok Ads, and paging past the first 500 ads. See `workflow.json` gaps.
