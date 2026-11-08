---
name: agriculture-mining-crop-records
description: Season records for crop, vineyard, grain and livestock farms, kept in AgriWebb. Use when setting up the season record for a client, when the review flags a farm, when a rainfall reading needs entering, or when an owner asks why a reading has not reached AgriWebb.
---

# Crop, vineyard, grain and livestock records

Built from how owners describe recording on discovery calls (one call so far: potato and garlic growing and packing) and
from AgriWebb's official schema. Crop operations are not writable in AgriWebb's API, so this workflow reads the season record
and flags its gaps. It queues rainfall readings for approval.

## What runs on its own
Three crons in `index.ts`, scheduled by `workflow.json`:
- `collect` (every 30 minutes) reads each watched farm's fields, sessions, recent records, animal count and rainfall from AgriWebb into the store.
- `review` (22:00 UTC daily) flags what is missing from the last read: no recent farm record, fields with no crop type or land use, no rainfall reading.
- `queue-records` (every 30 minutes) queues each new rainfall proposal for approval. It refuses any proposal that fails the checks and records why.

They read and draft only. Nothing is written to AgriWebb until a person approves the queued rainfall reading.

## Setting it up for a client
1. Fill `settings.json` from `settings.example.json`: the AgriWebb farm id(s), the stale-record window and the rainfall window.
2. Put `AGRIWEBB_ACCESS_TOKEN` in the deploy's secret store. Nothing else is needed for the reads.
3. Confirm the first `collect` run shows the farm's fields and recent records before relying on the review.

## Entering a rainfall reading
Write a proposal into the store under `proposals`:
`{"kind": "rainfall", "farm_id": "...", "sensor_id": "...", "value": 12.5, "time": <epoch ms>, "mode": "absolute"}`.
The sensor id is the AgriWebb rain gauge (mapFeatures, type RAIN_GAUGE). The value is millimetres. The queue cron checks the
farm, the gauge id, the value (0 to 500 mm) and the time (within the last 400 days, not more than a day ahead).

## When the review flags a farm
- No recent records: check with the owner whether the team is recording in AgriWebb or somewhere else.
- Fields with no crop type or land use: ask the owner for each field's crop or land use, then set it in AgriWebb.
- No rainfall reading: check the gauge is reporting, then enter the readings as proposals.

## Not covered yet
Crop operations (sprays, fertiliser, cultivation, pruning, harvest), bin scans, soil and sensor data, the Agworld, innovint,
FreshTrack and CropX records, and livestock movements. The gaps list in `workflow.json` says which platforms are not in the kit.
