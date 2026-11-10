---
name: document-intake
description: Collect, name and file incoming client and supplier documents in the business's own Dropbox, and chase missing ones. Use when setting up document intake for a client, when a file is parked in the review folder, when a file shows as failed, or when an owner asks why a document has not been filed.
---

# Document intake

Collects incoming client and supplier documents from the intake folder, renames each to a standard name and files it by its rule in the business's own Dropbox, parks unmatched files for a person, and queues a file request for each missing document on the checklist. Crons read and file inside the business; every request that reaches a client or supplier waits for a person to approve it.

## What runs on its own
Three crons in `index.ts`, scheduled by `workflow.json`:
- `intake` (every 15 minutes) records each new file in the intake folder. It only reads.
- `file` (every 30 minutes) renames each new file to `date_Label_original name` and moves it into the folder its rule names.
  A file that matches no rule goes to the review folder unchanged. A move never overwrites: if the target name is taken,
  Dropbox keeps both files.
- `chase` (daily) queues a file request for each checklist item with nothing recent. A person approves each request before
  any link leaves the business.

Nothing in these crons reaches a client or supplier without approval.

## Setting it up for a client
1. Fill `settings.json` from `settings.example.json`: the intake folder, the review folder, the upload folder for file
   requests, the filing rules (a word in the file name, its label, its folder) and the checklist.
2. Agree the rules with the owner. Each rule is one word. Keep them to words that appear in real file names.
3. Confirm the intake folder is where staff and clients actually send documents, and that the owner's email forwards
   attachments there (email intake is not built yet, so this step is manual for now).

## When a file is in review or failed
- Review: no rule matched. Read the file, then either move it by hand or add a rule and move the file back into intake.
  The next `file` run picks up anything in intake that is marked new.
- Failed: the store records the error. Fix the cause (usually a folder permission or a path), then set that document's
  status back to new so the next run retries it.
- Undo: each filed document keeps its original path and its new path in the store.

## Judgment steps a person does
- Checking that a certificate is still valid and on the right project. The workflow files it; it does not check dates.
- Checking figures on an invoice or claim against a contract or purchase order.
- Deciding whether a file request should go, and to whom. The approver chooses who gets the link.
- Sharing a filed folder with a team member. This stays in Dropbox for now.

## Not covered yet
Email and WhatsApp intake, Dext, Microsoft 365 and OneDrive or SharePoint filing, data extraction into accounts or a
register, record keeping, retention and disposal, and scanning paper. Each is listed in `workflow.json` under `gaps`.
