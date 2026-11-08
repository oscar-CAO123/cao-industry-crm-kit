---
name: reviews-ask-and-reply
description: Asks customers for reviews after a finished job and drafts replies to the reviews that come in, through Podium or GoHighLevel. Use when setting up review requests for a client, when a completed job has not been asked for a review, or when an owner asks why a review request or a reply has not gone out.
---

# Reviews: ask for them and reply

Built from 12 discovery calls about how businesses ask for reviews and answer them. Most of those calls use Google reviews.

## What runs on its own
Two crons in `index.ts`, scheduled by `workflow.json`. `reviews` reads the business's reviews from Podium and drafts a reply
for each one that needs an answer. `ask` queues a review request for each completed job that has not been asked yet.
Neither cron posts, sends or tags anything. A review request waits in the CRM shell until a person approves it.

## Setting it up for a client
1. Pick the review platform (`review_platform`): Podium or GoHighLevel. Fill `settings.json` from `settings.example.json`.
2. Podium: set `podium.location_uid` to the Podium location the reviews belong to.
3. GoHighLevel: set `gohighlevel.review_workflow_id` to the workflow that sends the review request. Build that workflow in
   GoHighLevel first, with the review request action and the Google review link. Set `asked_tag` if the business uses another tag.
4. Set the reply wording the owner wants, or leave the defaults.
5. Something must write finished jobs into the `completed_jobs` store namespace (see gaps). Each job needs a customer
   phone (E.164, such as +61412345678) or email, and for GoHighLevel a `contact_id`.

## Replies
The `reviews` cron drafts a reply into `reply_drafts`. Read each draft. Drafts flagged for a low or missing rating are
the ones to read most closely. A person posts the reply in the business's own Podium or GoHighLevel inbox. Nothing in this workflow posts it.

## When a review request is not queued
The store shows the reason on the job (`problem`). Usual causes: no phone or email on the job, a phone number without the
country code, or no GoHighLevel contact. Fix the job record and the next run picks it up. A job that already has `ask_id`
is never asked again, even if its approval was rejected. Ask the owner before re-opening it.

## Not covered yet
Posting review replies (both platforms, see gaps), Google Business Profile, reminder chases, escalation of poor reviews,
and a finished-job trigger inside either platform.
