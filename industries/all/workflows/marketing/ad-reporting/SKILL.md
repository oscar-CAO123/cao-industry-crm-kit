---
name: marketing-ad-reporting
description: Ad spend, cost per lead and leads from the business's own Meta ad account, with a pause queued for approval on any running ad over the cost-per-lead limit. Use when setting up ad reporting for a client, when the owner asks why an ad was queued for pause, or when the owner asks what the ads cost per lead this week.
---

# Ad reporting

Built from how 49 calls described ad reporting for businesses of all kinds. Most of the work was done by hand: a media buyer or the owner
copied spend and lead numbers into a sheet, then judged which ads to keep or scale.

## What runs on its own
Two crons in `index.ts`, scheduled by `workflow.json`:
- `pull` (daily) reads the last 7 days of ad numbers and the ads running now, and keeps one snapshot.
- `review` (daily, after pull) writes the report from that snapshot and queues a pause for any running ad that has spent at least
  the minimum and has no leads, or costs more per lead than the limit.

Nothing pauses on its own. Each pause waits in the approval queue until a person approves it in the CRM shell.

## Setting it up for a client
1. Fill `settings.json` from `settings.example.json`: the ad account id (`act_` and digits), the currency, the cost-per-lead limit
   and the minimum spend before a pause can be queued.
2. Put the Meta token in the environment as `META_ADS_TOKEN`. Never write it into a file.
3. Confirm the token can read the ad account and manage its ads before the first approval.
4. Agree the cost-per-lead limit with the owner. Leave it unset to get the report with no pauses queued.

## Judgment the agent does
- Read the `reports` namespace when the owner asks how the ads did, and say what it shows in plain words.
- Work out return on ad spend from the business's sales records. The job does not read those.
- Decide which ads to keep, change or scale, and check the brand fit of each creative. The job only pauses on the cost rule.
- Explain any queued pause to the owner before they approve it, and check the ad's numbers in the snapshot.

## Not covered
Budget and bid changes, scaling winners, matching leads to sales, period comparison, TikTok Ads, Google Ads, and the dashboards and
sheets the owner uses. See `workflow.json` gaps.
