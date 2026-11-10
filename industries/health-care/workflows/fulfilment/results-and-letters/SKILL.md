---
name: health-care-results-and-letters
description: Clinic results to a GP reply letter and a results-review recall, in Cliniko. Use when setting up results and letters for a practice, when a result is parked as needs-check, or when a clinician asks why a letter or recall has not appeared.
---

# Action results, send referrals and reply letters to GPs

Takes a result the clinic has sent back, drafts the reply letter to the GP as a draft treatment note in Cliniko, and queues a results-review recall for a person to approve. Crons read and draft; a person approves every recall, and sends every letter from the practice's own system.

## What runs on its own
Two crons in `index.ts`, scheduled by `workflow.json`. `draft` writes each ready GP letter to Cliniko as a draft treatment
note on the patient. `recall` queues a results-review recall for each drafted result, due after `review_after_days`. Neither
cron sends anything. The recall waits in the approval queue until a person approves it, because Cliniko texts the patient from it.

## Setting it up for a practice
1. Fill `settings.json` from `settings.example.json`. Set `result_review_recall_type_id` to the Cliniko recall type the practice
   uses for result reviews (a number, as a string). Recall types are set up by an administrator in Cliniko.
2. Optionally set `default_template_id` to the treatment note template the practice uses for letters.
3. Confirm `CLINIKO_API_KEY`, `CLINIKO_USER_AGENT` and `CLINIKO_SHARD` (default `au1`) are set as environment variables. Keys are never written into files.

## Getting a result in
The agent, or the CRM shell, writes one result record into the `results` store:
`{id, patient_id, title, filed, letter, status: "letter-ready", created}`. `filed` is the date the result was filed
against the patient. Patient content is health information. Never print it or paste it into a summary.

## The judgment steps the agent does
- Read the filed result and write the letter to the GP. Keep the clinician's words. Say what the GP or medical team needs
  (the findings they asked for, any action the clinician has named). Do not add findings or interpret results.
- If the patient, the result or the GP request is unclear, leave the result out of the store and say what is missing.
- After the draft note appears in Cliniko, the clinician checks it, and the practice sends the letter from its own system.

## When a result is parked as needs-check
- "draft not created": the input was refused (a bad patient or template id) or the platform errored. Check Cliniko for a note
  titled "Letter to GP: result review" for this patient before retrying, so a second letter is not made. Fix the id, then set
  the result back to `letter-ready`.
- "draft started but not recorded": the run stopped after the write began. Look in Cliniko first. If the note exists, set its
  `note_id` and status `drafted`. If it does not, set status `letter-ready`.
- "recall not queued": the patient id, recall type or filed date is not valid. Fix the field, then set status `drafted`.
- "the recall was failed, rejected or needs-check": a person decides. Nothing retries a recall on its own.

## Not covered
Sending letters to GPs, referrals (Cliniko has no create or send operation in the kit), results triage and clinician sign-off,
Genie, ZedMed and Jane App. Do these the practice's usual way. Record the letter as a result in the store so the draft note
and the recall still run here.
