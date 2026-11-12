// Three vendor SDK pointers were removed on 10 Nov 2026 after the full audit: each ships a dependency with a known
// advisory that has no fix (Monday: zod memory exhaustion; SendGrid: deepmerge; Webflow: elliptic) and each is already
// on its latest release. Their apps stay reachable through the generated endpoint layer in core/sdk/platforms/.
// The monday browser SDK pointer (monday-sdk-js) was removed on 12 Nov 2026: monday is not needed as an SDK.
// Bringing one back needs a fresh audit that shows the advisory is gone.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const REMOVED = ["mondaydotcomorg-api", "monday-sdk-js", "sendgrid-mail", "webflow"];

test("the removed SDK pointers are gone from the folder and the index", () => {
  const index = JSON.parse(fs.readFileSync(path.join(ROOT, "vendor-sdks/index.json"), "utf8"));
  for (const f of REMOVED) {
    assert.ok(!fs.existsSync(path.join(ROOT, "vendor-sdks", f)), `${f} folder is back`);
    assert.ok(!index.sdks.some((s: { folder: string }) => s.folder === f), `${f} is back in the index`);
  }
});

test("every SDK in the index has its pinned folder, and every folder is in the index", () => {
  const index = JSON.parse(fs.readFileSync(path.join(ROOT, "vendor-sdks/index.json"), "utf8"));
  const listed = index.sdks.map((s: { folder: string }) => s.folder).sort();
  const onDisk = fs.readdirSync(path.join(ROOT, "vendor-sdks"), { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== "node_modules").map((e) => e.name).sort();
  assert.deepEqual(listed, onDisk);
  for (const f of listed) assert.ok(fs.existsSync(path.join(ROOT, "vendor-sdks", f, "package-lock.json")), `${f} has no lockfile`);
});

test("the generated endpoint layer still covers the three apps (SendGrid sits inside the twilio platform)", () => {
  for (const id of ["monday", "twilio", "webflow"]) assert.ok(fs.existsSync(path.join(ROOT, "core/sdk/platforms", id, "platform.json")), `${id} platform is missing`);
  const twilio = JSON.parse(fs.readFileSync(path.join(ROOT, "core/sdk/platforms/twilio/ops.json"), "utf8"));
  assert.ok(twilio.some((o: { server?: string }) => /api\.sendgrid\.com/.test(o.server ?? "")), "SendGrid operations are missing from the twilio platform");
});
