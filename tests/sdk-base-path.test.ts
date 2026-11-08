// A base path that sits in both the server and the op path is joined once. Plans only: no network, no keys.
import test from "node:test";
import assert from "node:assert/strict";
import { plan } from "../core/sdk/call.ts";

const cases: [string, string, string][] = [
  ["productive", "activities-index", "https://api.productive.io/api/v2/activities"],
];

test("Productive, Cin7 and Supermetrics URLs carry their base path once", async () => {
  for (const [id, op, url] of cases) assert.equal((await plan(id, op)).url.split("?")[0], url);
  const cin7 = await plan("cin7", (await import("../core/sdk/platforms/cin7/ops.json", { with: { type: "json" } })).default
    .find((o: { method: string; params: { required: boolean }[] }) => o.method === "GET" && !o.params.some((p) => p.required)).id);
  assert.match(cin7.url, /^https:\/\/api\.cin7\.com\/api\/v1\//);
  assert.ok(!cin7.url.includes("/api/api/"));
  const sm = (await import("../core/sdk/platforms/supermetrics/ops.json", { with: { type: "json" } })).default
    .filter((o: { server: string; path: string }) => o.path.startsWith("/enterprise/v2/"));
  assert.ok(sm.length > 0);
  for (const o of sm.filter((o: { params: { required: boolean }[] }) => !o.params.some((p) => p.required))) {
    const u = (await plan("supermetrics", o.id)).url;
    assert.ok(!u.includes("/enterprise/v2/enterprise/v2"), u);
  }
});

test("an ordinary platform keeps its full path", async () => {
  const ops = (await import("../core/sdk/platforms/xero/ops.json", { with: { type: "json" } })).default as { id: string; method: string; path: string; server: string; params: { required: boolean }[] }[];
  const o = ops.find((x) => x.method === "GET" && x.server.endsWith("/api.xro/2.0") && !x.params.some((p) => p.required))!;
  assert.equal((await plan("xero", o.id)).url.split("?")[0], `${o.server}${o.path}`);
});
