---
name: construction-takeoff
description: Tender notices to a bid register, plan markups to takeoff rows, and a daily tender digest for a construction business, in Outlook, Excel and Bluebeam. Use when setting up the tender reader for a client, when a tender has no takeoff rows yet, or when the owner asks why a tender has not been picked up.
---

# The tender reader

Reads tender notices from the Outlook folder, logs each one in the bid register, turns the plan's Bluebeam markups into takeoff rows in Excel, and drafts one tender digest for approval. Crons read and draft; a person approves every send.

## What runs on its own
Three crons in `index.ts`, scheduled by `workflow.json`:
- `intake` logs each new tender notice from the Outlook folder as a row in the bid register.
- `takeoff` finds the tender's plan PDF in the Bluebeam project, starts Bluebeam's markup list, and writes one takeoff row per
  markup once Bluebeam returns them.
- `digest` drafts a daily tender digest to the estimator and queues its send for approval.

They read, log and draft only. The digest email is sent only when a person approves it. Nothing in this skill changes that.

## Setting it up for a client
1. Fill `settings.json` from `settings.example.json`: the tender mailbox and folder, the search word, the estimator's address,
   the bid register and takeoff tables in Excel, and the Bluebeam project id.
2. Ask the owner which subject line their tender notices use. The tender number must start with a digit (for example
   "Tender 4471"). The number is how a notice is matched to its plan file.
3. Check that the plan files for live tenders are in the Bluebeam project before the first takeoff run.

## When a tender has no takeoff rows
- No plan file yet: the tender stays `logged`. Add the plans to the Bluebeam project; the next hourly run picks them up.
- Markup list still running: it stays `markup-running`. Wait for the next runs.
- `needs-check`: Bluebeam did not return markups after the set number of polls. Open the job in Bluebeam, confirm the markups
  are there, and check the takeoff sheet by hand.

## The judgment steps (a person does these)
- Go or no-go: read the notice and decide whether the work fits the business's size and timing.
- Scope and quantities: check every takeoff row against the drawing. Markup rows carry the type, page, label and comment only.
  The measured quantity is not in the rows yet.
- Build-estimate and submit: the rates, the trade and supplier quotes, and the tender document are the business's own work.

## Not covered yet
PlanSwift, EstimateOne, Buildxact and TenderLata: no mapped operations for takeoff in the kit, so owners keep their usual
route and record the result as takeoff rows by hand. Tender portals and addenda downloads are a person's job. Trade and
supplier pricing and the Word tender document are judgment steps. The full list is in `workflow.json` under `gaps`.
