---
name: transport-fleet-service-planner
description: Fleet service planning for a transport business on Trackunit. Use when setting up the fleet planner for a client, when the status or plan cron reports a vehicle it cannot read, or when an owner asks why a service has not been booked.
---

# Fleet service planner

Built from 2 transport discovery calls and the vendor docs for MTData, Trackunit and WEBFLEET. The calls did not describe
the steps, so this build is docs-only. Trackunit is the only platform with mapped operations.

## What runs on its own
Two crons in `index.ts`, scheduled by `workflow.json`. `status` reads each vehicle's planned services and open device
issues every two hours. `plan` re-reads due services hourly and queues one workshop booking per due service for approval.
Neither cron books anything. Every booking waits for a person to approve it in the CRM shell.

## Setting it up for a client
1. Confirm the client runs Trackunit and get the access token. Token exchange is not built, so the token is supplied by hand.
2. Fill `settings.json` from `settings.example.json`: the Trackunit asset id for each vehicle, and the measurement system.
3. Check one vehicle by hand in the Trackunit portal before the first `plan` run.

## When a vehicle is due but not booked
The plan cron queues a booking only for services Trackunit marks OVERDUE or UPCOMING. If a vehicle shows nothing, read its
planned services in the portal. If a fault has no planned service, the workshop books it by hand.

## Not covered yet
Active CAN faults (they need a machine id, not the asset id), parts ordering, cost approval, return to service and follow-up.
MTData (Talon, Workshop Software) and WEBFLEET have no mapped operations, so their steps stay manual.
