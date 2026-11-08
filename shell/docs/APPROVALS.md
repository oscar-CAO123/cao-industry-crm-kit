# Approvals: how the CRM stays in control

Every workflow (`../industries/<industry>/workflows/<department>/<name>/workflow.json`) lists two sets of operations:

- `draft_ops`: reads, and writes that reach nobody outside the business (a draft quote, a draft email, an internal
  log). A cron runs these on its own.
- `live_ops`: anything that reaches a customer, moves money or changes a live record in another system (send, pay,
  mark sent, authorise). A cron can only **queue** these. They run when a person approves them on the Approvals page.

The rule is enforced by the workflow runtime (`core/workflows/runtime.ts`), not by the page: a cron that tries a live
operation fails. An approval holds one to five acts, run in order, stopping at the first failure.

## The click
- Approve: the runner (`workflows/run.ts`) claims the approval under a database lock (two clicks cannot both run it),
  marks each act started before calling it, and keeps the ids each act created.
- Failed: approving again resumes at the first act that did not finish. Nothing done repeats.
- Needs check: an act started but its result never came back. A person checks the app, then chooses "It happened"
  (skip it) or "Run again". Nothing is ever retried automatically.
- Reject: closes it. Every decision is in the audit log with who made it.

Admins and members approve; viewers see. Writes also need `KIT_ALLOW_WRITES=1` on the deploy, checked before a socket opens.
