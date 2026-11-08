---
name: marketing-ad-campaigns
description: Builds and reviews paid ad campaigns in the business's own Meta ad account. Use when setting up a campaign for a client, when an owner asks why a campaign was not built, or when an owner asks how the last week of ads went.
---

# Ad campaigns

Built from how 40 businesses described running ads on discovery calls. Almost every step was manual: an agency or the
owner set up the campaign, checked it, and switched it on by hand.

## What runs on its own
Three crons in `index.ts`, scheduled by `workflow.json`:
- `plan` (every 30 minutes) checks each planned campaign against the bounds. A plan that passes is ready to build. A plan
  that fails is skipped with the reason.
- `build` (every 15 minutes) moves each ready plan on by one approval. It queues the campaign, then the ad set, then the
  creative, then the ad, each one only after the one before it is approved and done. Each create uses the id the step
  before it returned.
- `review` (daily) reads the last seven days per campaign and keeps the table for the owner.

Nothing is created without a person's approval, and every object is created PAUSED. Nothing is switched on by this workflow.

## Setting it up for a client
1. Fill `settings.json` from `settings.example.json`: the ad account id (`act_` then digits), the Facebook Page id, the
   countries to target, and the most a plan may spend per day in cents.
2. Put the Meta token in the environment as `META_ADS_TOKEN`. Never write it into a file.
3. Confirm the account can create paused campaigns before the first approval.

## Planning a campaign
Write a plan to the `campaigns` namespace with: `id`, `name`, `objective` (`OUTCOME_LEADS` or `OUTCOME_TRAFFIC`),
`daily_budget_minor` (whole cents), `image_url` (an https link Meta can fetch), `link` (an https landing page), `headline`,
`message`, and `status: "planned"`. A lead campaign also needs `lead_gen_form_id`. Age range defaults to 18 to 65.
The plan run refuses a plan that breaks a bound and marks it `skipped` with the reason.

## Judgment the agent does
- Choose the objective, the budget, the audience and the picture. Write the headline and message in the client's voice,
  and check they read like a person wrote them before the plan is marked planned.
- Read `reviews/latest` when the owner asks how the ads are doing, and say what it shows, in plain words.
- When a step is `blocked` or `rejected`, say which step and why, and leave the fix to the owner.

## Not covered
Switching ads on or off, pausing, tracking and pixel setup, special ad categories, picture uploads, lead handling,
TikTok, LinkedIn and Google Ads. See `workflow.json` gaps.
