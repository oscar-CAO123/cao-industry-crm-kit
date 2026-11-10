---
name: documents
description: Produce letters, reports and documents from records. Copies the Google Doc template for each record marked ready, fills its fields, checks for unfilled placeholders, logs the row, and queues the share to the client for approval. Use when setting up document production for a client, when a document is not being made, or when an owner asks why a share has not gone out.
---

# Documents from records

Produces letters, reports and documents from records: each record marked ready is copied from its Google Doc template, filled from the record, checked for unfilled fields and logged. The client gets the document only after a person approves the share. Crons read and draft; a person approves every share.

## What runs on its own
Three crons in `index.ts`, scheduled by `workflow.json`. `intake` reads the records tab and takes each row marked ready.
`draft` copies the matching template into the output folder, fills the named fields from the record, and checks the
copy for placeholders it could not fill. It also logs one row per document. `queue` holds any draft with open comments
or no valid client email, and queues the share for approval otherwise. The crons read, draft and queue. Nothing is
shared with a client without an approval in the CRM shell.

## Setting it up for a client
1. Make one Google Doc template per kind of document. Mark each field with a double-braced header from the records tab,
   for example `{{Client name}}`. Keep a plain layout: text in paragraphs, no tables or images that need filling.
2. Fill `settings.json` from `settings.example.json`: the spreadsheet, the records range, the four column names, the log
   range, the output folder and the template id for each kind.
3. Agree with the owner which record status means ready. Only rows with that status are picked up.

## Judgment steps the agent does
- Write a figure-based report or commentary that the template cannot hold. Put it into the draft before the share is
  approved, and say so in the approval summary.
- Read a draft with open comments before anyone approves the share. The queue cron holds it, but a comment added later
  is not seen until the next run.
- Check the draft's figures against the record before approval. The cron fills text; it does not check the numbers.

## Not covered yet
Microsoft 365, record sources other than a Google Sheet, PandaDoc, Canva, Drive approvals, eSignature, PDF attachments and
write-back to the records tab. See `gaps` in `workflow.json`. The Google Workspace adapter is tested offline only.
