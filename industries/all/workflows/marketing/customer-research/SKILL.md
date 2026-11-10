---
name: customer-research
description: Customer surveys and interviews for a business, from the invite to a summary. Use when setting up customer research for a client, when an invite draft needs changing, or when an owner asks what customers said.
---

# Customer research

Runs customer surveys and interviews and summarises them. Sends a survey invite to each customer the owner chooses, collects the answers, and drafts a summary for the owner. Crons read and draft; every email send waits for a person to approve it.

## What runs on its own
Three crons in `index.ts`, scheduled by `workflow.json`. `responses` reads new answers from the form (or Calendly routing
form) and adds each one to the research log once. `invite` drafts one invite per customer in the audience list and queues
each send for approval. `summarise` drafts one summary to the owner each day, with answer counts. They read and draft only.
Nothing is sent until a person approves it in the CRM shell.

## Setting it up for a client
1. Run the first-run discovery skill to see which tools they use. Fill `settings.json` from `settings.example.json`: the
   survey source and its id, the public survey link, the research log, the owner's address and the audience.
2. Agree the three or four questions with the owner. Build them in the form first, so the invite links to a finished survey.
3. Check the audience list with the owner. Only the people on it get an invite.

## Judgment steps
- Themes: read the free-text answers in the research log and write what the owner needs to know. The summary cron only
  counts identical answers, so it cannot see themes.
- Interviews: book them by hand (Calendly or a calendar invite). Paste the notes into the research log as a row.
- Follow-ups after a survey (thank-you, incentive, the next question): write them with the owner. The workflow does not send them.

## Not covered yet
Interviews run and recorded by the workflow, transcription, follow-up sends, Jotform surveys, and choosing the audience from
the platform. See `workflow.json` gaps.
