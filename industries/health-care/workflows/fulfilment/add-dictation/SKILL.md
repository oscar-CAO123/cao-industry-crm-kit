---
name: health-care-add-dictation
description: Dictated or transcribed clinical visit notes to a draft treatment note in Cliniko, with the lock queued for a clinician to approve. Use when setting up session notes for a practice, when a session is parked as needs-check, or when a clinician asks why a note has not locked.
---

# Session notes from dictation

Built from how health-care businesses described their notes on discovery calls, and from Cliniko's help centre.
The kit can write a draft treatment note into Cliniko and lock it once a person approves. It cannot record or transcribe the
visit. That part is done by the practice's dictation or scribe tool.

## What runs on its own
Three crons in `index.ts`, scheduled by `workflow.json`. `draft` writes each ready session to Cliniko as a draft note.
`check` reads drafts back, so a note locked by hand in Cliniko is marked signed, and follows queued locks to their outcome.
`sign` queues the lock for each session a clinician has marked reviewed. No cron locks a note. The lock waits in the approval
queue until a person approves it in the CRM shell.

## Setting it up for a practice
1. Fill `settings.json` from `settings.example.json`. Set `default_template_id` to the Cliniko treatment note template the
   practice uses (a number, as a string). Cliniko templates are built by an administrator in Cliniko.
2. Confirm the Cliniko shard (`CLINIKO_SHARD`, default `au1`) and the API key are set as environment variables. Keys are never written into files.
3. Agree with the clinician which template section each dictated answer belongs in.

## Getting a session in
The agent skill, or the CRM shell, writes one session record into the `sessions` store:
`{id, title, patient_id, attendee_id?, booking_id?, template_id?, sections, status: "transcript-ready", created}`.
`sections` is the note split into the template's sections and questions, each with `name`, `description`, and `questions`
of `{name, answer}`. Patient content is health information. Never print it or paste it into a summary.

## The judgment steps the agent does
- Split the dictation or transcript into the template's sections and questions. Keep the clinician's words. Do not add findings.
- If the patient, visit or template is unclear, leave the session at `transcript-ready` and say what is missing.
- After the clinician has checked the draft in Cliniko, mark the session `reviewed` in the CRM shell. The `sign` cron queues the lock from that.

## When a session is parked as needs-check
- "draft not created": the input was refused (a bad patient, attendee, booking or template id) or the platform errored. Check Cliniko
  for a note with this session's title before retrying, so a second draft is not made. Fix the id, then set the session back to `transcript-ready`.
- "draft started but not recorded": the run stopped after the write began. Look in Cliniko first. If the note exists, set the
  session's `note_id` and status `drafted`. If it does not, set status `transcript-ready`.
- "the lock was failed, rejected or needs-check": a person decides. Nothing retries a lock on its own.

## Not covered
Letters and referrals, billing item numbers, recalls and follow-up tasks, and any dictation or transcription service.
Lyrebird Health and ZedMed are not built here: their pages are marketing copy and the kit has no operations for them.
