---
name: health-care-service-agreements
description: Service agreements for a health-care practice on Cliniko. Use when setting this up for a client, when a patient has no agreement form, or when an owner asks why an agreement was expired.
---

# Service agreements

Built from Cliniko's official API and help-centre pages. No discovery calls describe this workflow yet, so the steps rest on the docs.

## What runs on its own
Three crons in `index.ts`, scheduled by `workflow.json`. `intake` queues one agreement form per active patient case, once per patient and template. Once a person approves it, the form is created unsent in the patient record. `chase` queues an expiry for any agreement still unsigned after `expire_after_days`. `file-record` logs each completed agreement once to the internal register. Nothing is sent by a cron. Creating a form and expiring one both change what the patient sees, so both wait for approval in the CRM shell.

## Setting it up for a client
1. Build the agreement as a patient form template in Cliniko, with the privacy policy section and a signature question. Put its id in `settings.json` as `cliniko.agreement_template_id`.
2. Confirm with the owner that every active patient case needs an agreement. The trigger is the active case, not Cliniko's own form-on-booking setting.
3. Set `expire_after_days`.

## What a person does
- Approve or reject each queued form creation in the CRM shell. A rejected one is not queued again.
- Send each created form from the patient record in Cliniko by email, SMS, QR code or link. The API cannot send it.
- Send the reminder by hand. Approve or reject each queued expiry in the CRM shell.
- Turn on the PDF-copy email in Cliniko only if the owner wants one. The cron leaves it off.

## Not covered yet
Rates and price guides, plan manager or funder sending, renewal dates, end-of-agreement handling, and Halaxy. See `gaps` in `workflow.json`.
