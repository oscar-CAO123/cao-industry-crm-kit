---
name: policy-answers
description: Answers customer policy questions from Zendesk tickets. Crons find open tickets, match them to help centre articles and queue a reply for a person to approve. Use for the financial-services policy-answers workflow.
---

# Policy answers

## What runs on its own

- `intake` (every 10 minutes): reads open Zendesk tickets, optionally limited to one group.
- `draft` (every 15 minutes): matches each new question to a help centre article. A match becomes a queued reply. No match parks the ticket as needs-answer.
- `follow-up` (daily): closes answers whose tickets are solved, and queues a chaser when a sent reply has no answer after 3 and then 7 days.

Nothing is sent by a cron. Every reply and chaser waits in the approval queue.

## Setup

- Environment: `ZENDESK_SUBDOMAIN`, `ZENDESK_EMAIL`, `ZENDESK_API_TOKEN`. Keys by name only.
- Settings: copy `settings.example.json`. Set the help centre locale and, if needed, a `group_id`.

## Judgment the agent does

- Before a queued reply is approved, check its wording against the policy document. The cron quotes the article, and the article can be out of date for this customer's product.
- For a question no article covers, read the policy system and the file notes, then answer by hand or ask the insurer.
- Escalate to the claims team or a specialist when the answer depends on a ruling.

## Not covered

- Policy administration systems, insurer rulings, broker chasers, and routing changes. See `gaps` in `workflow.json`.
