---
name: seo-visibility
description: Search and AI search visibility for a business's website, through Ahrefs. Use when setting this up for a client, when a report is missing or empty, when a retired keyword needs removing from Rank Tracker, or when an owner asks why rankings or AI visibility moved.
---

# Grow search and AI search visibility

Built from how 19 businesses described their search visibility work on discovery calls: goal setting, keyword research,
site audit, content, backlinks, rankings, AI search and reporting. Most of that work was done by hand, or by an outside agency.

## What runs on its own
Four crons in `index.ts`, scheduled by `workflow.json`:
- `rankings` (daily): Rank Tracker positions and Search Console keywords for the target domain.
- `keywords` (weekly): Keywords Explorer volumes for the seed keywords, and the tracked list.
- `backlinks` (weekly): broken backlinks pointing at 404 pages.
- `ai-visibility` (weekly): Brand Radar share of voice across the chosen AI assistants.

They read and save a dated report in the store. The one write, removing a retired keyword from Rank Tracker, is only
queued. It runs when a person approves it.

## Setting it up for a client
1. Fill `settings.json` from `settings.example.json`: the target domain, the Rank Tracker project number, the country,
   the device, the seed keywords, and the Brand Radar report id.
2. Agree the seed keywords and the words the owner wants to stop tracking with the owner. Put the stop list in
   `retire_keywords`. Nothing is removed unless it is on that list.
3. Create the Brand Radar report in the Ahrefs app first. Its id goes in `brand_radar.report_id`.

## Judgment the agent does
- Choose the target terms and which pages to write or update, from the keyword and Search Console reports.
- Read the broken backlinks and decide which page to restore, which to redirect, and which to leave.
- Read the AI share of voice and decide what to change on the site.
- Write the owner update from the saved reports. Name the next change, and say what result it should show.

## Not covered yet
Google Business Profile, reviews and local listings. Site audit crawls. Publishing page copy or blog posts. Semrush.
Do these the business's usual way, and record the result in the tracker.
