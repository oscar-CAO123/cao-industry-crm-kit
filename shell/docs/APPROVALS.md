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

## A person, never the agent
The runtime accepts an approval only with proof that a person made it (`core/workflows/approval-proof.ts`):
- the click on this page, which signs a two-minute ticket bound to the approval, the decision and who clicked, or
- a person at a terminal running `node tools/workflow.ts approve ...` and typing `approve` when it asks. The question
  is asked on the terminal itself, not on stdin, so piping an answer in does nothing. A program that opens its own
  pseudo-terminal could still answer, so this stops an agent using the kit's commands, not one deliberately working
  around them. The hard limit is the keys: on a laptop they arrive only through op-scoped, behind Touch ID.

`KIT_ALLOW_WRITES=1` alone opens nothing: the agent can set a variable as easily as a person. An AI agent never
approves, never answers that prompt and never builds a ticket.
