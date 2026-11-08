---
name: manufacturing-x-maintenance
description: Maintenance for a manufacturing business: work orders for machine faults and services, lockout checklists, and booking notes to requesters. Use when the owner or planner asks about machine maintenance, breakdown requests or service scheduling in this workflow.
---

# Maintenance (manufacturing)

## What runs on its own
- Every 10 minutes: reads open ServiceM8 work orders (jobs in Work Order status) and matches each to a machine by name.
- Every 15 minutes: adds the lockout and isolation checklist to each new work order, once.
- Every 30 minutes: queues a booking note to the requester for approval. Nothing is sent until a person approves it.
- Daily: reads completed jobs and the parts used on them into the store.

## Setup
Copy `settings.example.json`, set the business name, the two job status names and the lockout steps the business really follows. The `SERVICEM8_API_KEY` environment variable is the only key. It is read by name and never written to a file.

## Judgment the agent does
- Work out which machine a request names when the asset name does not appear in the job text.
- Check meter readings or service intervals against the business's own rules. No mapped platform holds these.
- Turn an unclear fault description into the questions the technician should ask on site.
- Check the lockout steps against the machine before the checklist is trusted.

## Not covered
Technician booking, supplier parts ordering, labour hours, the service-due check and the lockout procedure itself are outside this workflow. See `workflow.json` gaps for the full list and for the platforms that were not mapped (MEX Maintenance, MRPeasy, Odoo).
