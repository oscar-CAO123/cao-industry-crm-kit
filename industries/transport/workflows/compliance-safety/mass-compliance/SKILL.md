---
name: mass-compliance
description: Heavy vehicle mass compliance and reporting. Keeps the vehicle register complete enough for mass-limit checks and queues a note for approval on each gap. Docs-only; Trackunit adapter.
---

# Heavy vehicle mass compliance and reporting

## What runs on its own
- **register** (every 6 hours): reads the vehicle register from Trackunit. Reads only.
- **mass-check** (30 minutes after each register run): finds vehicles missing a field a vehicle chart needs (type, brand, model, serial number, production year) and queues a note for approval. It never writes to Trackunit by itself.

## Setup
Set `TRACKUNIT_ACCESS_TOKEN` in the environment (there is no token exchange yet). Copy `settings.example.json` and set `business_name` and `required_fields`. Writes need `KIT_ALLOW_WRITES=1` on the deploy, and a note only goes out after approval.

## What the agent does
- Before approving a queued note, read the vehicle's current note in Trackunit. Approving replaces the whole note.
- Work out each vehicle's mass limits and combination from its registration and the NHVR mass limit pages, and record them yourself. The register does not hold them.
- Load planning, access permits and driver briefings are done by a person, using the NHVR Route Planner and Portal.

## Not covered
- Weighing, GVM, GCM and axle group calculation, and load adjustment: no mapped platform.
- NHVR: no mapped operations. Permit applications and accreditation reporting stay manual in the Portal.
- GoCanvas: read operations are mapped, but there is no adapter yet.
- Roadside response and corrective action.
