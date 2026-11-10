---
name: construction-plant-equipment
description: Plant and equipment register and workshop parts cost for a construction business, using Trackunit and ServiceM8. Use with the x-plant workflow (construction:x-plant) when an owner asks which machine costs the most in parts, what plant is on the register, or whether a machine is in ServiceM8.
---

# Plant and equipment

Keeps a register of plant and equipment and totals the parts on each workshop job: reads Trackunit and ServiceM8, records the register, and queues the owner's summary of the largest workshop part costs for approval. Crons read and record; nothing is sent, booked or hired out without a person.

## What runs on its own

- **register-watch** (hourly, at 20 past): reads the Trackunit plant register and the ServiceM8 asset list. It keeps each plant
  item and whether ServiceM8 has an asset with the same name. It reads only.
- **cost-watch** (daily, 21:00 UTC): totals the parts on each active workshop job in ServiceM8, keeps the figures, and queues
  an email of the largest ones to the owner. The email waits for a person to approve it. Nothing is sent by the cron.

Nothing here books plant, hires it out, changes a job, or sends anything. Those stay with a person.

## Setup

- Set the keys by name in the secret store: TRACKUNIT_ACCESS_TOKEN and SERVICEM8_API_KEY. Values never go in files or logs.
- Copy `settings.example.json` and set `owner_email`. Set `workshop_category_uuid` to the ServiceM8 job category used for internal
  workshop repairs. Until it is set, cost-watch reads nothing.
- Writes need KIT_ALLOW_WRITES=1 on the deploy. The crons run reads only; the summary email is queued until approved.

## Judgment steps for the agent

- Read the register rows that are not in ServiceM8 and say which plant to check by hand. Names are matched exactly, so two
  machines with the same name will match to one asset.
- Read the top workshop jobs by parts. Say which job looks costly and why, and ask the owner which machine each job belongs to,
  since no confirmed field links a job to a machine.
- Do not decide on servicing, hire-out, disposal or what to charge a hirer. Hand those to the owner.

## Not covered

- Operating hours and meter readings, plant allocation to jobs, hire-in and hire-out, servicing schedules, return off hire, sale
  or write-off. Mapped platform gaps are listed in `workflow.json`.
- MEX CMMS, Procore and Webfleet: their help pages were read, but none has mapped operations in the kit.
