// Reads the kit repo the shell lives in: industry templates (industries/<industry>/crm-shell/template.json) and
// workflow records (industries/<industry>/workflows/<department>/<name>/workflow.json). Read-only. Every file is
// validated before use, because a template decides what the shell switches on.
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { DEPARTMENT_IDS, FIELD_TYPES, VIEWS } from "./departments";

/** The kit repo root: KIT_ROOT at deploy, else the folder above the shell. */
export function kitRoot(): string {
  const root = path.resolve(process.env.KIT_ROOT || path.join(process.cwd(), ".."));
  if (!fs.existsSync(path.join(root, "industries")) || !fs.existsSync(path.join(root, "core"))) throw new Error("KIT_ROOT does not point at the kit repo");
  return root;
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
const department = z.string().refine((d) => DEPARTMENT_IDS.includes(d), "unknown department");
const field = z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{0,30}$/), label: z.string().min(1).max(60), type: z.enum(FIELD_TYPES), options: z.array(z.string().max(60)).max(30).optional() });
const tab = z.object({ slug: z.string().regex(SLUG), title: z.string().min(1).max(60), view: z.enum(VIEWS), kind: z.string().regex(SLUG), stages: z.array(z.string().min(1).max(40)).max(12).optional(), fields: z.array(field).max(20) });
const page = z.object({ slug: z.string().regex(SLUG), title: z.string().min(1).max(60), department, tabs: z.array(tab).min(1).max(12) });
const workflowRef = z.object({ id: z.string().regex(/^[a-z0-9:-]{1,80}$/), dir: z.string().regex(/^industries\/[a-z-]+\/workflows\/[a-z-]+\/[a-z0-9-]+$/), department, name: z.string().max(200), status: z.string().max(40) });
export const TemplateSchema = z.object({
  industry: z.string().regex(SLUG), name: z.string().min(1).max(60), version: z.number().int().min(1), source: z.string().max(400),
  pages: z.array(page).max(40),
  workflows: z.array(workflowRef).max(150),
  planned_workflows: z.array(z.object({ id: z.string().max(80), name: z.string().max(200), department })).max(150),
  connectors: z.array(z.object({ tool: z.string().max(80), platform: z.string().regex(SLUG), status: z.string().max(40) })).max(40),
  missing_connectors: z.array(z.object({ tool: z.string().max(80) })).max(40),
});
export type Template = z.infer<typeof TemplateSchema>;

export function listIndustries(): string[] {
  const dir = path.join(kitRoot(), "industries");
  return fs.readdirSync(dir).filter((d) => SLUG.test(d) && fs.existsSync(path.join(dir, d, "crm-shell", "template.json"))).sort();
}

export function loadTemplate(industry: string): Template {
  if (!SLUG.test(industry)) throw new Error("bad industry");
  const f = path.join(kitRoot(), "industries", industry, "crm-shell", "template.json");
  const t = TemplateSchema.parse(JSON.parse(fs.readFileSync(f, "utf8")));
  if (t.industry !== industry) throw new Error("template industry does not match its folder");
  for (const w of t.workflows) {
    if (!fs.existsSync(path.join(kitRoot(), w.dir, "workflow.json"))) throw new Error(`template names a workflow that is not in the repo: ${w.dir}`);
  }
  return t;
}

export interface WorkflowInfo { id: string; name: string; summary: string; status: string; department: string; crons: { name: string; entry: string; schedule: string; summary: string }[]; liveOps: string[]; gaps: string[] }

/** The parts of a workflow record the shell shows. Read from the repo, never from the database. */
export function workflowInfo(dir: string): WorkflowInfo {
  if (!/^industries\/[a-z-]+\/workflows\/[a-z-]+\/[a-z0-9-]+$/.test(dir)) throw new Error("not a workflow folder");
  const r = JSON.parse(fs.readFileSync(path.join(kitRoot(), dir, "workflow.json"), "utf8"));
  const liveOps = Object.entries((r.live_ops ?? {}) as Record<string, string[]>).flatMap(([p, ops]) => ops.map((o) => `${p} ${o}`));
  return {
    id: String(r.id), name: String(r.name ?? r.id), summary: String(r.summary ?? ""), status: String(r.status ?? "docs-only"), department: String(r.department ?? ""),
    crons: (r.crons ?? []).map((c: any) => ({ name: String(c.name), entry: String(c.entry ?? c.name), schedule: String(c.schedule), summary: String(c.summary ?? "") })),
    liveOps, gaps: (r.gaps ?? []).map(String).slice(0, 12),
  };
}
