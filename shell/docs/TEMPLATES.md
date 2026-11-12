# Industry templates

`../industries/<industry>/crm-shell/template.json`, checked against `TemplateSchema` in `lib/shell/kit.ts`:

- `pages`: `{ slug, title, department, tabs: [{ slug, title, view, kind, stages?, fields }] }`. Departments are the
  nine in `lib/shell/departments.ts`. A tab's `kind` names the records it shows.
- `workflows`: built workflows for this industry: `{ id, dir, department, name, status }`.
- `planned_workflows`: planned but not built yet; shown in the preview, never switched on.
- `connectors` and `missing_connectors`: the apps this industry uses, and which the kit covers.

Applying shows every page and workflow it adds and what is already on, writes them in one transaction, records the
list, and can be undone. A template never adds records: a business starts empty. Undo removes the pages and switches
the workflows off; records entered on those pages stay.

Templates define reusable industry pages and the workflows they enable. Review the preview before applying one.
