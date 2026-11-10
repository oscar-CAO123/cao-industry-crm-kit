---
name: hospitality-guests-waitlist
description: Guest waitlist kept in a spreadsheet for a hospitality venue. Puts waiting parties in order, quotes a wait, and logs each party that leaves the queue. Use when setting up the waitlist for a client, when a row is marked Check, or when an owner asks why a quoted wait or a guest log entry looks wrong.
---

# Guests and waitlist

Keeps the venue's guest waitlist in its own spreadsheet: puts each waiting party in order and quotes a wait from the minutes per group, logs every seated, no-show or left party once to a guest log, and queues the clearing of those rows for approval. Crons read and draft; a person approves every clear.

## What runs on its own
Two crons in `index.ts`. `queue` runs every 10 minutes. It puts each row marked Waiting in order of the time it was added, writes its position, and quotes a wait of minutes per group ahead in the queue. A row it cannot read is marked Check with a note.

`close` runs daily. It logs each row marked Seated, No show or Left to the Guest log tab, once per party. It then queues the clearing of that row for approval. Nothing reaches a guest, and no row is cleared until a person approves it in the CRM shell.

## Setting it up for a client
1. Create the Waitlist tab with these headers in row 1, columns A to H, in this order: Guest, Party size, Added, Quoted wait (min), Position, Status, Outcome time, Note.
2. Create a Guest log tab with these headers: Date, Guest, Party size, Added, Outcome, Minutes waited.
3. Fill `settings.json` from `settings.example.json`: the spreadsheet id, the two tab names, the timezone, and the minutes per group.
4. Write Added and Outcome time with an offset, for example 2026-12-05T18:00:00+11:00. Status words must match the list above.

## Judgment steps
- Waiting: the host adds the party with its name, size and the time it joined. The queue cron does the rest.
- Ready: the host sets this when a table is free. The guest is told by hand. Nothing is sent.
- Seated, No show or Left: set the status and the outcome time. The close cron logs the party and queues its row for clearing.
- Check: read the Note, fix the row, then set Status back to Waiting.
- A party that wants to move up or down the queue, a VIP, or a table choice: the host decides and edits the row by hand.
- The quoted wait is an estimate from minutes per group. Adjust the setting if the room runs faster or slower.

## Not covered
Guest messages, seating plans, no-show chasing, repeat-guest lookup, marketing consent, Lightspeed, and walk-in or phone intake. See `gaps` in `workflow.json`.
