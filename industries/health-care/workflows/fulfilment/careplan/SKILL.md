---
name: careplan-from-intake
description: Care plan from intake for a health-care clinic on Cliniko. Use when a new patient comes in from a referral and the clinic wants a care plan note started and the intake form queued. Crons read and draft; a clinician writes and signs the plan, and a person approves every form sent.
---

# Care plan from intake

## What runs on its own

- **intake** (every 30 minutes): reads patients created in the lookback window and each one's referral source. Reads only.
- **draft** (every 30 minutes): creates a care plan note from the clinic's Cliniko template, saved as a draft (`draft: true`), and queues the intake assessment form for approval. Nothing is sent.
- **forms** (daily): checks each approved intake form and records the ones the patient has completed.

The crons never send anything to a patient. The form create waits in the approval queue until a person approves it.

## Setup

1. Copy `settings.example.json` to the client's settings and replace both template ids with the Cliniko treatment note template and patient form template the clinic uses (`treatment-note-template.listtreatmentnotetemplates`, `patient-form-template.listpatientformtemplates`).
2. Put `CLINIKO_API_KEY` and `CLINIKO_USER_AGENT` in the client's secret store. The shard defaults to `au1` (`CLINIKO_SHARD` overrides it).
3. Deploy with `KIT_ALLOW_WRITES=1` so the draft note can be created.

## Judgment steps the agent does

- Read the draft note in Cliniko and fill in the care plan from the referral's issue and expiry dates.
- Decide whether the referral needs a goals set or a funding check. Cliniko does not hold either.
- Check the intake form content before a person approves it.

## Not covered

- Clinician sign-off, client consent, team allocation and plan review. These are manual in Cliniko.
- Sending the intake form. It is queued for a person; if Cliniko does not email it on creation, the person sends it from Cliniko.
- Splose. Its help centre was read, but the kit has no mapping for it.

See `workflow.json` for the full gap list.
