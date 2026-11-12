import test from "node:test";
import assert from "node:assert/strict";
import { vendorRequire } from "../core/sdk/vendor/load.ts";
test("Airtable refuses an SDK that was already loaded without the gate", async () => {
  vendorRequire("airtable")("airtable");
  const { airtable } = await import("../core/sdk/vendor/airtable.ts");
  assert.throws(() => airtable(), /already loaded without the kit gate/);
});
