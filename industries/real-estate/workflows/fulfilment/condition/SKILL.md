---
name: real-estate-condition-reports
description: Condition reports for a property management business, starting from the property and contact lists in AgentBox. Use when setting up condition reports for a client, or when an owner asks why a report is slow or has the wrong property or contact.
---

# Condition reports

Built from how real-estate businesses described condition reports on discovery calls (3 calls read, 2 describe their process).
Staff inspect on site, take photos and notes, then record the report in the business's software by hand.

## What runs on its own
Two crons in `index.ts`, scheduled by `workflow.json`: `properties` reads the property list every 30 minutes, and `contacts`
reads the contact list hourly. Both read only. Nothing is written to AgentBox, and nothing is sent.

## Setting it up for a client
1. Confirm the business uses AgentBox. Fill `settings.json` from `settings.example.json`.
2. Set `REAPIT_ACCESS_TOKEN` in the environment the crons run in. Never put it in a tracked file.
3. Check the first run lists the properties and contacts the owner expects. The crons read the first page only.

## What the person still does
- Inspects the property on site, and takes the photos and notes.
- Writes the report and checks it against the last one.
- Signs it off and sends it. Meter and key readings, disputes and repairs are done by the person, outside this workflow.

## Not covered yet
PropertyMe, rex, Inspection Express, Inspection Manager and Property Tree have no kit adapter here. Creating or uploading
a report in AgentBox is not built, because its document endpoints do not have confirmed fields in the vendor docs. See the
`gaps` list in `workflow.json`.
