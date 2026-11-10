---
name: all-missed-call-textback
description: Text back missed calls and log them, for any business that takes calls on a JustCall number. Records each missed call, queues one text back to the caller for approval, and adds an internal note on the caller's GoHighLevel contact. Use when setting this up for a client, when an owner asks why a missed caller was not texted, or when a cron alert looks wrong.
---

# Missed-call text back

Reads the missed calls on the business's JustCall number, queues one text back to each caller for approval, and logs each missed call as an internal note on the caller's GoHighLevel contact. The crons read, draft and queue; a person approves every text.

## What runs on its own
Three crons in `index.ts`, scheduled by `workflow.json`:
- `intake` (every 10 minutes) reads missed incoming calls on the JustCall number and records each one once.
- `textback` (every 10 minutes) queues one text back to each recorded caller. Nothing is sent.
- `log` (every 15 minutes) finds or creates the caller's GoHighLevel contact by phone number and adds one internal note.

Only the text to the caller is live. It waits in the approval queue until a person approves it.

## Setting it up for a client
1. Fill `settings.json` from `settings.example.json`: the JustCall number (E.164), the GoHighLevel location, and the text back wording.
2. Agree the wording with the owner. Use `{business}` only.
3. Run one approved text on a JustCall sandbox number before the first live approval. Check the sandbox call rings out without voicemail and still shows in the log.

## Judgment the team does
- Approve, edit or reject each queued text in the CRM shell.
- Ring back the missed callers from the JustCall dialer or the Missed Call Analytics widget.
- Read and answer replies in the JustCall SMS inbox.

## Not covered yet
Caller replies, a missed-call list or end-of-day report (JustCall shows this in product), lead capture from a text, routing a caller to a person, and any GoHighLevel-only business. Twilio is not built (see `gaps` in `workflow.json`).
