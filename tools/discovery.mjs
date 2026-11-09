#!/usr/bin/env node
// Discovery helpers for a placed hire's first weeks. No network, no keys: reads the kit's own workflow records.
//   node tools/discovery.mjs checklist stack.json        what to walk through with the owner and team, by department
//   node tools/discovery.mjs plan discovery.json         rank what was found into a 90-day plan (plan.json, plan.md)
// stack.json: { "business", "industry", "tools": ["Xero", ...] } (same file tools/coverage.mjs reads)
// discovery.json: see core/skills/first-run-discovery/discovery.example.json
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SLUG = /^[a-z0-9-]{1,40}$/;
const key = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const WEEKS_PER_YEAR = 48;

function readJson(p) { return JSON.parse(fs.readFileSync(p, "utf8")); }

/** Every app the kit maps, by its id and its display name. */
export function platformNames() {
  const dir = path.join(ROOT, "core/sdk/platforms");
  const out = new Map();
  for (const id of fs.readdirSync(dir)) {
    const f = path.join(dir, id, "platform.json");
    if (!fs.existsSync(f)) continue;
    const p = readJson(f);
    out.set(key(id), id); if (p.name) out.set(key(p.name), id);
  }
  return out;
}

/** The workflows that apply to an industry: the core ones plus the industry's own, grouped by department. */
export function workflowsFor(industry) {
  if (!SLUG.test(industry)) throw new Error(`bad industry ${industry}`);
  const rows = [];
  for (const scope of ["all", industry]) {
    const base = path.join(ROOT, "industries", scope, "workflows");
    if (!fs.existsSync(base)) continue;
    for (const dept of fs.readdirSync(base)) {
      const ddir = path.join(base, dept);
      if (!fs.statSync(ddir).isDirectory()) continue;
      for (const id of fs.readdirSync(ddir)) {
        const f = path.join(ddir, id, "workflow.json");
        if (!fs.existsSync(f)) continue;
        const w = readJson(f);
        const apps = [...new Set([...Object.keys(w.draft_ops ?? {}), ...Object.keys(w.live_ops ?? {})])].sort();
        const ways = Object.entries(w.families ?? {}).map(([name, x]) => ({ name, steps: x?.steps ?? [] }));
        rows.push({ id: `${scope}/${dept}/${id}`, name: w.name, department: dept, scope, summary: w.summary ?? "", ways, apps, status: w.status ?? "docs-only" });
      }
    }
  }
  return rows.sort((a, b) => a.department.localeCompare(b.department) || a.name.localeCompare(b.name));
}

/** The checklist: each workflow with the business's own apps it can use, and what the owner and team are asked. */
export function checklist(stack) {
  const names = platformNames();
  const theirs = new Set((stack.tools ?? []).map((t) => names.get(key(t))).filter(Boolean));
  const unmapped = (stack.tools ?? []).filter((t) => !names.get(key(t)));
  const rows = workflowsFor(stack.industry).map((w) => {
    const usable = w.apps.filter((a) => theirs.has(a));
    const ready = w.apps.length === 0 ? "no-app" : usable.length ? "can-wire" : "needs-connector";
    return { ...w, usable, ready };
  });
  return { business: stack.business ?? "", industry: stack.industry, tools_not_in_kit: unmapped, workflows: rows };
}

export function checklistMarkdown(c) {
  const out = [`# Discovery checklist: ${c.business || c.industry}`, "",
    "Walk each department with the person who does the work. For every workflow: do they do this, which way, how often,",
    "how long it takes and who does it, what goes wrong. Write the answers into discovery.json. Read the tools only; change nothing.", ""];
  if (c.tools_not_in_kit.length) out.push(`Tools the kit has no connector for yet: ${c.tools_not_in_kit.join(", ")}.`, "");
  let dept = "";
  for (const w of c.workflows) {
    if (w.department !== dept) { dept = w.department; out.push(`## ${dept}`, ""); }
    const ways = w.ways.map((x) => `${x.name} (${x.steps.join(", ")})`).join("; ");
    const apps = w.usable.length ? `their ${w.usable.join(", ")}` : w.apps.length ? `needs one of: ${w.apps.join(", ")}` : "no app needed";
    out.push(`- **${w.name}** \`${w.id}\`: ${w.summary}`.slice(0, 400), `  - Ways it is done: ${ways || "not recorded"}`, `  - Apps: ${apps}`);
  }
  return out.join("\n") + "\n";
}

/** Rank what discovery found into a 90-day plan. Value = hours saved a week x hourly cost x 48 weeks. */
export function plan(d) {
  const cost = (x) => Number(x.hourly_cost ?? d.default_hourly_cost ?? 0);
  const items = [];
  for (const x of d.workflows ?? []) {
    if (!x.applies) continue;
    const effort = x.status === "can-wire" ? 1 : x.status === "needs-connector" ? 3 : 2;
    items.push({ kind: "workflow", id: x.workflow, name: x.name ?? x.workflow, status: x.status, effort_days: Number(x.effort_days ?? effort),
      value: Math.round(Number(x.hours_per_week ?? 0) * cost(x) * WEEKS_PER_YEAR), notes: x.notes ?? "" });
  }
  for (const b of d.builds ?? []) {
    items.push({ kind: "build", id: b.name, name: b.name, status: "build", effort_days: Number(b.effort_days ?? 5),
      value: Math.round(Number(b.hours_per_week ?? 0) * cost(b) * WEEKS_PER_YEAR), notes: b.notes ?? "" });
  }
  for (const i of items) if (!Number.isFinite(i.value) || !Number.isFinite(i.effort_days) || i.effort_days <= 0) throw new Error(`bad numbers for ${i.id}`);
  const order = { "can-wire": 0, "needs-connector": 1, build: 2, other: 3 };
  items.sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3) || b.value / b.effort_days - a.value / a.effort_days);
  const capacity = Number(d.days_per_week ?? 4);
  let day = 0;
  for (const i of items) { i.start_week = Math.floor(day / capacity) + 1; day += i.effort_days; i.end_week = Math.ceil(day / capacity); }
  return { business: d.business ?? "", total_value: items.reduce((s, i) => s + i.value, 0),
    in_90_days: items.filter((i) => i.end_week <= 13), later: items.filter((i) => i.end_week > 13) };
}

export function planMarkdown(p) {
  const money = (n) => `$${n.toLocaleString("en-AU")}`;
  const line = (i) => `| ${i.start_week}-${i.end_week} | ${i.name} | ${i.status} | ${money(i.value)} | ${i.notes}`.slice(0, 300) + " |";
  return [`# 90-day plan: ${p.business}`, "", `Value of everything found: ${money(p.total_value)} a year in hours saved.`, "",
    "| Weeks | What | Status | Value a year | Notes |", "|---|---|---|---|---|", ...p.in_90_days.map(line), "",
    p.later.length ? "## After 90 days" : "", ...p.later.map((i) => `- ${i.name} (${money(i.value)} a year)`), ""].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, file] = process.argv.slice(2);
  if (!["checklist", "plan"].includes(cmd) || !file) { console.error("Usage: node tools/discovery.mjs checklist stack.json | plan discovery.json"); process.exit(2); }
  const dir = path.dirname(path.resolve(file));
  if (cmd === "checklist") {
    const c = checklist(readJson(file));
    fs.writeFileSync(path.join(dir, "discovery-checklist.json"), JSON.stringify(c, null, 1));
    fs.writeFileSync(path.join(dir, "discovery-checklist.md"), checklistMarkdown(c));
    console.log(`${c.workflows.length} workflows; ${c.workflows.filter((w) => w.ready === "can-wire").length} can use their apps; checklist written beside ${path.basename(file)}`);
  } else {
    const p = plan(readJson(file));
    fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify(p, null, 1));
    fs.writeFileSync(path.join(dir, "plan.md"), planMarkdown(p));
    console.log(`${p.in_90_days.length} items in 90 days, ${p.later.length} later; plan.md written`);
  }
}
