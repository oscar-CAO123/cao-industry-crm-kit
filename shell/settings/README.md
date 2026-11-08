# Workflow settings

One file per switched-on workflow: `<workflow id with ":" as "-">.json`, copied from that workflow's
`settings.example.json` and filled in for this business (which apps, which mailbox, which accounts).
Settings are not secrets: keys never go here. Keys live in 1Password and reach a run through `scripts/with-secrets.mjs`.
`workflows/run.ts` reads the file for the workflow it runs.
