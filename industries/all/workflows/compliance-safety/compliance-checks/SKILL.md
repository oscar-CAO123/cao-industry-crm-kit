---
name: all-compliance-checks
description: Reads the ID, AML and regulatory check state of client matters in First AML and queues a case note for a compliance person to approve. Use when setting up compliance checks for a client, when open screening or verification items are not showing up, or when a compliance person asks why a note has not been added.
---

# Compliance checks

Built from how Australian accounting practices, law firms and a real estate agency described AML and ID checks on discovery
calls. Six of the 43 worklist calls were read. The rest of the evidence is not in this record, so treat the steps as a starting point.

## What runs on its own
Two crons in `index.ts`, scheduled by `workflow.json`. `case-watch` reads cases updated since its last run and records each
person's and entity's check state: clear, waiting, or open. `open-items` queues one case note per set of open screening or
verification results, for a compliance person to approve. Neither cron clears a check, changes a case status, or lodges a report.

## Setting it up for a client
1. Fill `settings.json` from `settings.example.json`. Set `first_aml.organization_id` if the client has more than one organisation in First AML.
2. Confirm the client's First AML access token is in the deploy environment as `FIRST_AML_ACCESS_TOKEN`. The sign-in is not built yet.
3. Agree with the compliance person which results count as open. The default is every fail, consider, possible match or match.

## When an open item looks wrong
Open items come from First AML's own results. Check the case in First AML first. A person decides each result there, and the
note only points them at it. Case names and client details are not copied into the store, only IDs and check names.

## What a person decides
Every note waits in the approvals list. Approve it only when the note is accurate. Approving adds the note to the case in First AML.
Anything about a check result, a risk rating, an escalation or a report to AUSTRAC is the business's own decision.

## Not covered yet
Matter intake from Smokeball, beneficial owner identification, licence checks, enhanced due diligence, risk assessments, second-reviewer
approval, remediation, ongoing monitoring and regulator reports. Do these the business's usual way. See `gaps` in `workflow.json`.
