// Discovery helpers: the checklist reads the kit's own workflows; the plan ranks what was found. No network.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { checklist, checklistMarkdown, plan, planMarkdown, workflowsFor } from "../tools/discovery.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");

test("the checklist covers the core workflows and the industry's own, by department", () => {
  const all = workflowsFor("construction");
  assert.ok(all.some((w) => w.id === "construction/sales/quoting"));
  assert.ok(all.some((w) => w.scope === "all"));
  assert.ok(all.every((w) => w.department && w.name));
  assert.throws(() => workflowsFor("../etc"), /bad industry/);
});

test("their own apps decide can-wire or needs-connector; unknown tools are listed, not guessed", () => {
  const c = checklist({ business: "Example", industry: "construction", tools: ["Xero", "ServiceM8", "Some Local App"] });
  const q = c.workflows.find((w) => w.id === "construction/sales/quoting")!;
  assert.equal(q.ready, "can-wire");
  assert.ok(q.usable.includes("servicem8"));
  assert.deepEqual(c.tools_not_in_kit, ["Some Local App"]);
  assert.match(checklistMarkdown(c), /## sales/);
});

test("the plan puts quick wins first, values hours in their numbers, and spreads work over 13 weeks", () => {
  const d = JSON.parse(fs.readFileSync(path.join(ROOT, "core/skills/first-run-discovery/discovery.example.json"), "utf8"));
  const p = plan(d);
  assert.equal(p.in_90_days[0].status, "can-wire");
  assert.equal(p.in_90_days.find((i) => i.id === "construction/sales/quoting")!.value, 10 * 55 * 48);
  assert.ok(!p.in_90_days.some((i) => i.id === "all/people/rostering"), "a workflow that does not apply is left out");
  assert.ok(p.in_90_days.some((i) => i.kind === "build"));
  assert.match(planMarkdown(p), /90-day plan: Example Plumbing/);
});

test("bad numbers are refused instead of planned", () => {
  assert.throws(() => plan({ workflows: [{ workflow: "x", applies: true, status: "can-wire", hours_per_week: "lots" }] }), /bad numbers/);
});
