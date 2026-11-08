---
name: construction-x-rfis
description: RFIs and drawings for a construction business. Turns a site question about the drawings into an RFI in Fieldwire, opens it to the designer on approval, and reads the answer back. Use when a foreman or supervisor finds something the drawings do not answer.
---

# RFIs and drawings (construction)

## What runs on its own
- `intake` (every 15 minutes) reads the RFIs in each watched Fieldwire project that changed since the last run.
- `draft` (every 30 minutes) turns each new question into an RFI draft in Fieldwire, sets its question text, and queues the open to the designer. Nothing is sent by the crons.

## Setup
Set `fieldwire.api_version` (the date from Fieldwire's versioning docs), `fieldwire.projects` (project UUIDs), and optionally `fieldwire.designer_user_id` and `fieldwire.default_due_days` in the workflow settings. The bearer token is supplied directly as `FIELDWIRE_ACCESS_TOKEN`.

## Judgment steps (the agent does these)
1. Read the question from the site: what the foreman found, where, and which drawing or spec it touches.
2. Read the drawings and specifications for that point. Note the sheet, the detail and any conflict between them.
3. Write one question row to the `questions` collection: the project, a short RFI name, the question with the drawing references, and the assignee if the question names one. Leave `status` as `new`.
4. Leave the open to the designer to the approval queue. A person approves it in the CRM.

## Not covered
- Chasing overdue RFIs, cost or time impact, and variation dockets.
- Bluebeam and Procore adapters (see the record's gaps).
- Anything that emails, changes an RFI's status for a customer, or pays, without a person approving it.
