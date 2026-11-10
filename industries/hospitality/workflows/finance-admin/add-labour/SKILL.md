---
name: hospitality-labour-alerts
description: Labour as a share of sales for each venue, from Deputy, with an alert record while a venue is over its target. Use when setting up labour alerts for a hospitality client, when a venue's alert looks wrong, or when an owner asks why no alert has been raised.
---

# Labour alerts

Works out each venue's labour cost as a share of its sales from the rosters and timesheets in Deputy, and records an alert the moment a venue runs over its labour target. The crons only read and record; a person changes rosters and targets in Deputy.

## What runs on its own
Two crons in `index.ts`: `pull` reads each venue's timesheet cost and sales for today from Deputy every 30 minutes, and `check` works labour out as a share of sales every hour and keeps an alert record open while a venue is over its target. They read and record only. They do not change a roster, a rule or a target, and they send nothing.

## Setting it up for a client
1. Fill `settings.json` from `settings.example.json`: one entry per venue with its Deputy area id and its labour target, plus the venue's UTC offset.
2. Confirm the Deputy environment variables are set for the client (subdomain, region, access token) in the client's secret store. Never write them into settings.
3. Agree the target percentage with the owner for each venue. The workflow does not set it in Deputy.

## When a venue shows waiting-for-data
Sales below `min_sales` (default 200 dollars) mean early in the day, so the share is not worked out yet. A venue with no sales recorded in Deputy stays waiting. Ask the venue to enter the day's sales in Deputy.

## When an alert is open
Read the venue's alert: its labour share, its target and the time it was raised. Look at the rosters and timesheets for that day in Deputy. Adjust shifts there, a person does it. Do not change a target from the crons.

## Not covered yet
Rostering, setting labour targets in Deputy, Looker Studio reports, Xero budgets and payroll, and Employment Hero (not connected in this workflow). See `workflow.json` gaps.
