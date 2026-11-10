---
name: marketing-content-posting
description: Planned social posts to scheduled posts on Instagram and the Facebook Page, in the business's own Meta account. Use when setting up social posting for a client, when a post is skipped and the owner asks why, or when an owner asks what has gone up recently.
---

# Content posting

Creates and schedules social posts: each planned post becomes an unpublished Instagram draft and its publish is queued for approval, and recent posts are read back. Crons read and draft; a person approves every publish.

## What runs on its own
Two crons in `index.ts`, scheduled by `workflow.json`:
- `draft` (every 30 minutes) takes each planned post and creates an unpublished Instagram container for its picture. It then
  queues the live publish for approval. Facebook posts are queued only, never published by the cron.
- `track` (daily) reads recent posts on each configured channel and keeps the list for the owner.

Nothing publishes on its own. A person approves each publish in the CRM shell.

## Setting it up for a client
1. Fill `settings.json` from `settings.example.json`: the channels they post to, the Instagram user id and the Facebook Page id.
2. Put the Meta token in the environment as `META_ADS_TOKEN`. Never write it into a file.
3. Confirm the account can publish to Instagram and to the Page before the first approval.

## Planning a post
Write a post to the `posts` namespace with: `id`, `caption`, `image_url` (an https link Meta can fetch), `channels`
(`instagram`, `facebook`, or both) and `status: "planned"`. Instagram posts need an `image_url`. Facebook can take a text-only
post when there is no picture. The draft run refuses a post whose caption is empty or over 2200 characters, or whose link is
not https, and marks it `skipped` with the reason.

## Judgment the agent does
- Pick the idea, write the caption in the client's voice, and check it reads like a person wrote it before it is planned.
- Choose the picture and make sure its link opens publicly.
- Read the `history` namespace when the owner asks what went up, and say what it shows. It holds ids and counts only.

## Not covered
Scheduled times, reels, carousels, stories, comment replies, per-post insights, LinkedIn, Canva publishing, and the
Hootsuite, Metricool and Vista Social tools. See `workflow.json` gaps.
