---
name: construction-env-certificates
description: Solar and electrical paperwork for construction businesses. Tracks jobs that need network connection applications or environmental certificates (STCs, VEECs, LGCs), checks each job for its evidence, and queues customer chases for approval. Use when a solar or electrical business owner asks about lodging connection applications or creating certificate claims.
---

# Solar and electrical paperwork

## What runs on its own
- **register** (every 30 minutes): finds active ServiceM8 jobs whose text names solar, battery, inverter, export limit, network connection, STCs, VEECs or LGCs, and tracks them in the store.
- **evidence** (daily): checks each tracked job's attachments for installation photos, the electrical safety certificate, serial numbers and the commissioning record, and records what is still missing.
- **chase** (daily): for jobs still missing evidence, queues one email to the customer's primary contact. A person approves it. Nothing is sent by the cron.

## Setup
Copy `settings.example.json`, set the business name, and check the keywords and evidence terms match how the business names its jobs and files. ServiceM8 credentials come from the environment only.

## Judgment steps (the agent does these, not the crons)
- Work out which certificate applies (STC, VEEC or LGC) from the job's system size, state and install date.
- Draft the network connection application content (system size, inverter, export limit) from the job notes. Lodging happens in the distributor's own portal, by hand.
- Check installer accreditation on the public register and with Solar Accreditation Australia, by hand.
- Create the certificate claim in the REC Registry or the Victorian scheme, by hand. Confirm the upload steps on a live account first.

## Not covered
- Lodging network applications and waiting for distributor approval.
- Creating and lodging certificate claims (REC Registry, VEEC, LGC).
- Any platform beyond ServiceM8 in the kit. See `workflow.json` gaps.
