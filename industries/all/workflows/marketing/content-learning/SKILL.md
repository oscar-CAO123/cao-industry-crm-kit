---
name: marketing-content-learning
description: Scores the business's Meta ads and recent Instagram posts by how they perform, and writes the plan of what is working for the next brief. Use when setting up content learning for a client, when a pause is queued for approval, or when the owner asks what content is working.
---

# Content learning

Scores each Meta ad and recent Instagram post by how it performs, names what is working and what is not, and writes that plan for the next brief. Crons read and draft; a pause on a running ad over the cost-per-lead limit is only queued, and a person approves it.

## What runs on its own
Two crons in `index.ts`, scheduled by `workflow.json`:
- `pull` (daily) reads ad results for the window, the ads running now, and recent Instagram posts, and keeps one snapshot.
- `score` (daily, after pull) scores each ad and post, writes the plan to the store, and queues a pause for any running ad over the
  cost-per-lead limit.

Nothing pauses on its own. Each pause waits in the approval queue until a person approves it in the CRM shell.

## Setting it up for a client
1. Fill `settings.json` from `settings.example.json`: the ad account id, the Instagram account id, the window, and the minimums.
2. Put the Meta token in the environment as `META_ADS_TOKEN`. Never write it into a file.
3. Confirm the token can read the ad account and the Instagram insights before the first run.
4. Agree the cost-per-lead limit with the owner. Leave it unset to get scores with no pauses queued.

## Judgment the agent does
- Read the `scores` namespace when the owner asks what is working, and say it in plain words.
- Name what the winners have in common (format, hook, topic). The job does not read captions, so check the posts themselves.
- Brief the next content from the `plan` section: `make_more` for what to repeat, `fix_or_stop` for what to change.
- Work out whether a winner pays. The job has no sales records.
- Explain any queued pause to the owner before they approve it.

## Not covered
Metricool, Facebook Page post results, Google Ads, LinkedIn, linking content to sales, updating the content calendar, budget and bid
changes, and creating new posts or ads. See `workflow.json` gaps.
