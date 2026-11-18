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
- the click on this page, which signs a two-minute ticket bound to the approval, the decision, who clicked and a digest
  of the headline and the exact acts shown (each act's platform, operation and full inputs are listed on the page,
  with hidden and direction characters written out), or
- a person at a terminal running `node tools/workflow.ts approve ...`, who reads the acts in full (an approval too long to show in full at a terminal is refused there), types `approve` and then
  gives the computer account's password. The question is asked on the terminal itself, not on stdin, so piping an
  answer in does nothing; the password is checked by the operating system (`sudo -k`, which caches nothing and grants
  nothing), so an agent that opens its own pseudo-terminal still cannot approve. Where sudo needs no password, or is
  missing, terminal approval is refused: approve on this page.

Either way the approval runs only the acts that were shown: their digest is checked again when the run starts, so an
act changed in the store afterwards runs nothing. The grant that opens writes names those acts' exact
operation ids, which the SDK's own requests carry, and a request that names no operation is not opened by it; a cron's grant names its
own draft operations. A reject from this page or the command line takes the same lock as an approve. What a gate inside the process cannot stop is code written on purpose
around it, or any code holding a raw key; on a laptop keys arrive only through op-scoped, behind Touch ID.

`KIT_ALLOW_WRITES=1` alone opens nothing: the agent can set a variable as easily as a person. An AI agent never
approves, never answers that prompt and never builds a ticket.
