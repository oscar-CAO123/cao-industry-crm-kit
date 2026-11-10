# Building on the shell

- **A page for a department:** add it to the industry's `template.json` (one page per core function, tabs for its
  pieces), re-apply the template. Views: `board` (stages), `table`, `calendar` (week), `feed` (incoming), `dashboard`.
- **A workflow:** build it in `../industries/<industry>/workflows/<department>/<name>/` with its `workflow.json`,
  `SKILL.md`, settings example, adapters and a fake-network test; list it in the template. Its department page
  shows it and its approvals appear on the Approvals page.
- **A field:** add it to the tab's `fields` in the template. Records keep unknown data out; old records keep theirs.
- **A table or column:** a new `db/NNNN_name.sql` that only adds, plus the matching change in `prisma/schema.prisma`.
- **Run it locally:** your own empty Postgres (`docker-compose.yml`), keys through op-scoped. Never a live database.
- **Test:** `pnpm typecheck`, `pnpm test` (no keys, no database; everything mocked) and from the kit root
  `node --test tests/shell.test.ts`. Checks run at the same time.
- **Ship:** a branch, a pull request listing the files and a rollback note, merge on the owner's go.
