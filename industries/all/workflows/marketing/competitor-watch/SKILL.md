---
name: marketing-competitor-watch
description: Watches a client's named competitors for new public Facebook posts and for search authority (Semrush backlink scores), and writes a report. Competitor ads and prices are not covered yet. Use when setting up competitor watching for a client, when the owner asks what a competitor posted, or when a Semrush project approval is waiting.
---

# Competitor watch

Built from 2 competitor-watch calls and the platform evidence for Semrush and LinkedIn. The calls do not describe a process, so the steps come from the platform evidence. Most steps are still done by hand: a marketer checks each competitor's ads, prices and posts and writes down what changed.

## What runs on its own
Four crons in `index.ts`, scheduled by `workflow.json`:
- `discover` (weekly) lists domains Semrush finds similar to the client's. These are suggestions only. It also queues, once, an approval to create the Semrush tracking project for the client's domain.
- `watch` (daily) reads the newest public posts on each competitor's Facebook Page. The first run only records what is there; it does not report it as new.
- `authority` (weekly) compares the client's Semrush backlink score and referring domains with each competitor's. It keeps last week's numbers for comparison.
- `report` (daily) writes the report from those stored results. It makes no platform calls.

Nothing sends, posts or changes a live record without a person. The only live act is the Semrush project, and it waits in the approval queue.

## Setting it up for a client
1. Fill `settings.json` from `settings.example.json`: the client's domain (no `https://`), up to nine competitors, each with a domain, a Facebook Page id, or both.
2. Put the keys in the environment: `SEMRUSH_API_KEY` and `META_ADS_TOKEN`. Never write them into a file.
3. Confirm the Meta token can read each competitor's public posts. If it cannot, the report lists that competitor under missing.
4. Approve the Semrush project when it is queued. Check the domain first.

## Judgment the agent does
- Read the `reports` namespace when the owner asks what competitors did, and say what it shows in plain words.
- Look at each new post and decide whether it matters to the client. The job reports the post; it does not judge it.
- Decide whether a suggested competitor belongs on the watchlist. Add it to settings yourself; the job never adds one.
- Work out what, if anything, the client should change in response. That stays with the owner.

## Cost and limits
Semrush's authority comparison costs 40 API units per domain, so it runs weekly. Competitor ads and prices are not covered, nor are LinkedIn posts or alerts. See `workflow.json` gaps for the full list.
