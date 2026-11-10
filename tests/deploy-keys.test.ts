// Every deploy names the keys of every app the workflow's settings use, not only the quoting workflow's fields.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { secretNames } from "../tools/deploy.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const wfOf = (dir: string) => JSON.parse(fs.readFileSync(path.join(ROOT, dir, "workflow.json"), "utf8"));

test("a settings section such as sitebook brings its key into the deploy", () => {
  const dir = "industries/all/workflows/compliance-safety/safety-forms";
  const settings = JSON.parse(fs.readFileSync(path.join(ROOT, dir, "settings.example.json"), "utf8"));
  assert.ok(secretNames(settings, wfOf(dir)).includes("SITEBOOK_API_KEY"));
});

test("only apps the workflow itself uses: a stray name in settings brings in no key", () => {
  const dir = "industries/all/workflows/compliance-safety/safety-forms";
  const keys = secretNames({ sitebook: {}, note: "xero" }, wfOf(dir));
  assert.ok(keys.includes("SITEBOOK_API_KEY"));
  assert.ok(!keys.some((k) => k.startsWith("XERO_")), "xero is not one of this workflow's apps");
});

test("quoting keeps the keys it had", () => {
  const dir = "industries/construction/workflows/sales/quoting";
  const settings = JSON.parse(fs.readFileSync(path.join(ROOT, dir, "settings.example.json"), "utf8"));
  const keys = secretNames(settings, wfOf(dir));
  assert.ok(keys.some((k) => k.startsWith("SERVICEM8")), keys.join(","));
});
