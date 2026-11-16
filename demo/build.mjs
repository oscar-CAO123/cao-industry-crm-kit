#!/usr/bin/env node
// Builds the static demo of the CRM shell into demo/dist. It reads only the kit's own files: every industry's
// crm-shell/template.json and the workflow.json each template names. The output is plain files (HTML, CSS, JS and one
// data script) with no server code; the sample records are made up in the browser from a fixed seed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

/** Departments in the order the shell's navigation shows them (shell/lib/shell/departments.ts). */
export const DEPARTMENTS = [
  { id: "sales", title: "Sales", line: "Enquiries, quotes, pipeline and follow-up." },
  { id: "marketing", title: "Marketing", line: "Content, ads, reviews and landing pages." },
  { id: "customer-service", title: "Customer service", line: "Calls, inboxes, complaints and status updates." },
  { id: "customer-success", title: "Customer success", line: "Onboarding, portals, check-ins and win-back." },
  { id: "fulfilment", title: "Fulfilment", line: "Jobs, scheduling, stock, orders and documents." },
  { id: "finance-admin", title: "Finance and admin", line: "Invoices, bills, reconciliation and the numbers." },
  { id: "people", title: "People", line: "Hiring, rosters, records and training." },
  { id: "compliance-safety", title: "Compliance and safety", line: "Safety forms, checks, expiries and lodgements." },
  { id: "owner", title: "Owner", line: "The numbers, meetings, knowledge and systems health." },
];

const VIEWS = new Set(["board", "table", "calendar", "feed", "dashboard"]);
// Ids and keys become object keys in the page; refuse anything that could reach an object's prototype.
const SAFE_KEY = /^[a-z0-9][a-z0-9:_-]*$/i;
const safe = (value, what) => { if (typeof value !== "string" || !SAFE_KEY.test(value) || ["constructor", "prototype"].includes(value)) throw new Error(`unsafe ${what}: ${JSON.stringify(value)}`); return value; };
const FIELD_TYPES = new Set(["text", "textarea", "date", "money", "number"]);

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

/** Reads one workflow record and keeps only what the demo shows. */
function workflowOf(ref) {
  const dir = path.resolve(root, ref.dir);
  if (!dir.startsWith(root + path.sep)) throw new Error(`workflow dir outside the kit: ${ref.dir}`);
  const w = readJson(path.join(dir, "workflow.json"));
  return {
    id: safe(ref.id, "workflow id"),
    name: w.name ?? ref.name,
    department: w.department ?? ref.department,
    status: w.status ?? ref.status,
    shared: ref.dir.startsWith("industries/all/"),
    summary: w.summary ?? "",
    crons: (w.crons ?? []).map((c) => ({ name: c.name, schedule: c.schedule, summary: c.summary ?? "" })),
    apps: Object.keys(w.draft_ops ?? {}),
    gaps: Array.isArray(w.gaps) ? w.gaps.length : 0,
  };
}

/** One industry template, checked and trimmed to what the demo draws. */
export function industryOf(id) {
  const t = readJson(path.join(root, "industries", id, "crm-shell", "template.json"));
  if (!Array.isArray(t.pages)) throw new Error(`${id}: the template has no pages`);
  if (typeof t.name !== "string" || !t.name) throw new Error(`${id}: the template has no name`);
  const pages = t.pages.map((p) => {
    if (!DEPARTMENTS.some((d) => d.id === p.department)) throw new Error(`${id}/${p.slug}: unknown department ${p.department}`);
    if (!Array.isArray(p.tabs) || p.tabs.length === 0) throw new Error(`${id}/${p.slug}: a page needs at least one tab`);
    return {
      slug: p.slug, title: p.title, department: p.department,
      tabs: p.tabs.map((tab) => {
        if (!VIEWS.has(tab.view)) throw new Error(`${id}/${p.slug}/${tab.slug}: unknown view ${tab.view}`);
        if (typeof tab.slug !== "string" || !tab.slug) throw new Error(`${id}/${p.slug}: a tab needs a slug`);
        if (tab.kind != null && typeof tab.kind !== "string") throw new Error(`${id}/${p.slug}/${tab.slug}: kind must be text`);
        if (tab.stages != null && Array.isArray(tab.stages) && tab.stages.length === 0) throw new Error(`${id}/${p.slug}/${tab.slug}: a board needs at least one stage`);
        for (const f of tab.fields ?? []) if (!FIELD_TYPES.has(f.type)) throw new Error(`${id}/${p.slug}/${tab.slug}: unknown field type ${f.type}`);
        if (tab.stages != null && (!Array.isArray(tab.stages) || tab.stages.some((x) => typeof x !== "string"))) throw new Error(`${id}/${p.slug}/${tab.slug}: stages must be a list of names`);
        return { slug: tab.slug, title: tab.title, view: tab.view, kind: tab.kind, stages: tab.stages ?? null, fields: (tab.fields ?? []).map((f) => ({ key: safe(f.key, "field key"), label: f.label, type: f.type })) };
      }),
    };
  });
  if (pages.length === 0) throw new Error(`${id}: the template has no pages`);
  return {
    id, name: t.name, pages,
    workflows: t.workflows.map(workflowOf),
    connectors: t.connectors.map((c) => ({ tool: c.tool, status: c.status })),
    missing: t.missing_connectors.map((c) => c.tool),
  };
}

export function industryIds() {
  return fs.readdirSync(path.join(root, "industries"), { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(root, "industries", d.name, "crm-shell", "template.json")))
    .map((d) => d.name).sort();
}

/** Every workflow is stored once (the shared ones appear in all 13 templates); an industry lists the ids it uses. */
export function buildData() {
  const workflows = {};
  const industries = industryIds().map(industryOf).map((ind) => {
    for (const w of ind.workflows) workflows[w.id] = w;
    return { ...ind, workflows: ind.workflows.map((w) => w.id) };
  });
  return { departments: DEPARTMENTS, workflows, industries };
}

export function build(out = path.join(here, "dist")) {
  const data = buildData();
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  for (const f of ["index.html", "app.js", "styles.css"]) fs.copyFileSync(path.join(here, "src", f), path.join(out, f));
  // A script file, not JSON, so the page can load it with a plain <script src> under a strict policy.
  fs.writeFileSync(path.join(out, "data.js"), `window.KIT_DEMO_DATA = ${JSON.stringify(data)};\n`);
  return { out, industries: data.industries.length, pages: data.industries.reduce((n, i) => n + i.pages.length, 0), workflows: data.industries.reduce((n, i) => n + i.workflows.length, 0) };
}

if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  // Always demo/dist: the build clears its output folder, so it never takes a path from the command line.
  const r = build();
  console.log(`demo built: ${r.industries} industries, ${r.pages} pages, ${r.workflows} workflows -> ${path.relative(process.cwd(), r.out) || "."}`);
}
