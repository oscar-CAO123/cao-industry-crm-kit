// Vendor SDK pilot (Stripe, Square, Xero): the vendors' own SDKs run behind the kit's gate.
// Every request goes to a fake network, and every raw way out of the process is trapped, so a test
// fails if an SDK reaches the network any way other than through the gate.
import test, { before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { spawnSync } from "node:child_process";
import { setTransport, WriteBlocked } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { callOperation, sendPrepared } from "../core/sdk/call.ts";
import { PLACEHOLDER_KEY } from "../core/sdk/vendor/gate.ts";
import { stripe } from "../core/sdk/vendor/stripe.ts";
import { square } from "../core/sdk/vendor/square.ts";
import { xeroApis } from "../core/sdk/vendor/xero.ts";

type Hit = { method: string; url: string; headers: Record<string, string>; body?: string };
let hits: Hit[] = [];
const bypass: string[] = [];
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "kit-vendor-home-"));

function fakeNetwork(status = 200, payload: unknown = { ok: true }) {
  hits = [];
  setTransport({
    sleep: async () => {},
    log: () => {},
    fetch: (async (url: any, init: any) => {
      // Real fetch refuses a GET with a body; so does this fake.
      if ((init?.method ?? "GET") === "GET" && init?.body !== undefined) throw new TypeError("Request with GET/HEAD method cannot have body");
      const body = init?.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : init?.body;
      const u = new URL(String(url));
      if (u.pathname === "/connect/token") return Response.json({ access_token: "xero-at", refresh_token: "r2", expires_in: 1800 });
      hits.push({ method: init?.method ?? "GET", url: String(url), headers: init?.headers ?? {}, body });
      return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
    }) as any,
  });
}

const ENV = {
  STRIPE_SECRET_KEY: "sk-ours", SQUARE_ACCESS_TOKEN: "sq-ours", XERO_CLIENT_ID: "x", XERO_CLIENT_SECRET: "y",
  XERO_TENANT_ID: "tenant-ours", XERO_REFRESH_TOKEN: "r1",
};

before(() => {
  const trap = (name: string) => () => { bypass.push(name); throw new Error(`network bypass: ${name}`); };
  for (const [mod, fns] of [[http, ["request", "get"]], [https, ["request", "get"]], [net, ["connect", "createConnection"]], [tls, ["connect"]]] as const) {
    for (const f of fns) (mod as any)[f] = trap(`${f}`);
  }
  (globalThis as any).fetch = trap("global fetch");
  process.env.HOME = HOME;
  delete process.env.XDG_CONFIG_HOME;
});

beforeEach(() => {
  fakeNetwork();
  Object.assign(process.env, ENV);
  delete process.env.KIT_ALLOW_WRITES;
  setTokenStore(new MemoryTokenStore());
});

const only = (): Hit => { assert.equal(hits.length, 1, `expected one request, saw ${hits.length}`); return hits[0]; };
const header = (h: Hit, name: string) => Object.entries(h.headers).find(([k]) => k.toLowerCase() === name)?.[1];
const same = async (sdk: () => Promise<unknown>, ours: () => Promise<unknown>) => {
  await sdk(); const a = only(); hits = [];
  await ours(); const b = only(); hits = [];
  assert.equal(a.method, b.method);
  assert.equal(a.url, b.url);
  assert.equal(header(a, "authorization"), header(b, "authorization"));
  return [a, b];
};

test("reads through each SDK match our own layer exactly (method, URL, key)", async () => {
  fakeNetwork(200, { object: "list", data: [], has_more: false, url: "/v1/customers" });
  await same(() => stripe().customers.list({ limit: 3, email: "a@b.co" }), () => callOperation("stripe", "openapi_spec3.GetCustomers", { params: { limit: 3, email: "a@b.co" } }));
  fakeNetwork(200, { id: "cus_1", object: "customer" });
  await same(() => stripe().customers.retrieve("cus_1"), () => callOperation("stripe", "openapi_spec3.GetCustomersCustomer", { params: { customer: "cus_1" } }));
  fakeNetwork(200, {});
  await same(() => square().customers.list({ limit: 2 }), () => callOperation("square", "api.ListCustomers", { params: { limit: 2 } }));
  await same(() => square().customers.get({ customerId: "C1" }), () => callOperation("square", "api.RetrieveCustomer", { params: { customer_id: "C1" } }));
  const [x] = await same(() => xeroApis().accounting.getContacts("tenant-from-caller", undefined, 'Name=="A"', undefined, undefined, 1), () => callOperation("xero", "accounting.getContacts", { params: { where: 'Name=="A"', page: 1 } }));
  assert.equal(header(x, "xero-tenant-id"), "tenant-ours", "the tenant is always the client's own, whatever the caller passes");
  assert.equal(x.body, undefined, "a GET never carries a body");
});

test("writes are blocked before the network for all three SDKs", async () => {
  await assert.rejects(stripe().customers.create({ email: "a@b.co" }), (e: any) => e.detail instanceof WriteBlocked);
  await assert.rejects(square().customers.create({ givenName: "A" }), (e: any) => e.cause instanceof WriteBlocked);
  await assert.rejects(xeroApis().accounting.createContacts("t", { contacts: [{ name: "A" }] } as any), (e: any) => String(e).includes("write blocked"));
  assert.equal(hits.length, 0);
});

test("allowed writes: Square, Xero AND Stripe send the same body through their SDK as through our own layer", async () => {
  process.env.KIT_ALLOW_WRITES = "1";
  const [a, b] = await same(() => square().customers.create({ givenName: "A", emailAddress: "a@b.co" }), () => callOperation("square", "api.CreateCustomer", { body: { given_name: "A", email_address: "a@b.co" } }));
  assert.deepEqual(JSON.parse(a.body!), JSON.parse(String(b.body)));
  const [c, d] = await same(() => xeroApis().accounting.createContacts("t", { contacts: [{ name: "A" }] } as any), () => callOperation("xero", "accounting.createContacts", { body: { Contacts: [{ Name: "A" }] } }));
  assert.deepEqual(JSON.parse(c.body!), JSON.parse(String(d.body)));
  fakeNetwork(200, { id: "cus_1", object: "customer" });
  const body = { email: "a@b.co", metadata: { k: "v" }, expand: ["default_source", "tax"] };
  const [s, ours] = await same(() => stripe().customers.create(body), () => callOperation("stripe", "openapi_spec3.PostCustomers", { body }));
  // Stripe v1 takes form encoding only; our layer now encodes exactly as stripe-node does (brackets may be %-encoded).
  for (const h of [s, ours]) assert.match(String(header(h, "content-type")), /x-www-form-urlencoded/);
  assert.deepEqual([...new URLSearchParams(String(ours.body))], [...new URLSearchParams(String(s.body))]);
  assert.deepEqual([...new URLSearchParams(String(ours.body))], [["email", "a@b.co"], ["metadata[k]", "v"], ["expand[0]", "default_source"], ["expand[1]", "tax"]]);
});

test("the SDK never holds the key, and its machine telemetry never leaves", async () => {
  process.env.KIT_ALLOW_WRITES = "1";
  fakeNetwork(200, { id: "cus_1", object: "customer" });
  await stripe().customers.create({ email: "a@b.co" });
  await square().customers.list({});
  await xeroApis().accounting.getContacts("t");
  assert.equal(hits.length, 3);
  for (const h of hits) {
    assert.ok(!JSON.stringify(h).includes(PLACEHOLDER_KEY), "placeholder key reached the network");
    for (const k of Object.keys(h.headers)) assert.doesNotMatch(k, /^(user-agent|x-stripe-client-user-agent|x-stripe-client-telemetry|x-fern-runtime|x-fern-runtime-version)$/i);
  }
  assert.deepEqual(fs.readdirSync(HOME), [], "an SDK wrote to the home folder");
});

test("a request to an endpoint we have not mapped is refused before the network", async () => {
  await assert.rejects(stripe().rawRequest("GET", "/v1/not_a_real_thing"), (e: any) => /not a mapped endpoint/.test(e.detail?.message ?? ""));
  await assert.rejects(sendPrepared("square", { method: "GET", url: "https://connect.squareup.com/v2/not-real", headers: {} }), /not a mapped endpoint/);
  assert.equal(hits.length, 0);
});

test("an id that decodes to a slash, backslash or dot segment is refused (encoded path tricks)", async () => {
  await assert.rejects(xeroApis().accounting.getContact("t", "x/../../admin"), (e: any) => String(e).includes("path value is not allowed"));
  await assert.rejects(xeroApis().accounting.getContact("t", "a/b"), (e: any) => String(e).includes("path value is not allowed"));
  await assert.rejects(stripe().customers.retrieve("..\\x"), (e: any) => /path value is not allowed/.test(e.detail?.message ?? ""));
  // A bare ".." is folded away by the URL parser, so the request no longer matches any endpoint.
  await assert.rejects(square().customers.get({ customerId: ".." }), (e: any) => /path value is not allowed|not a mapped endpoint/.test(String(e.cause?.message ?? e.message)));
  assert.equal(hits.length, 0);
});

test("an SDK cannot switch account or override the method through headers", async () => {
  await assert.rejects(stripe().customers.list({}, { stripeAccount: "acct_other" }), (e: any) => /Stripe-Account is not allowed/i.test(e.detail?.message ?? ""));
  await assert.rejects(stripe().customers.list({}, { headers: { "Stripe-Context": "ctx_other" } } as any), (e: any) => /Stripe-Context is not allowed/i.test(e.detail?.message ?? ""));
  await assert.rejects(sendPrepared("square", { method: "GET", url: "https://connect.squareup.com/v2/customers", headers: { "X-HTTP-Method-Override": "DELETE" } }), /not allowed from a vendor SDK/);
  assert.equal(hits.length, 0);
});

test("vendor error bodies never reach the SDK; it sees the status and our message", async () => {
  fakeNetwork(404, { secret: "client data" });
  await assert.rejects(stripe().customers.retrieve("cus_1"), (e: any) => e.statusCode === 404 && !JSON.stringify(e.raw ?? {}).includes("client data"));
  await assert.rejects(square().customers.get({ customerId: "C1" }), (e: any) => e.statusCode === 404 && !JSON.stringify(e.body ?? {}).includes("client data"));
  await assert.rejects(xeroApis().accounting.getContact("t", "c1"), (e: any) => String(e).includes('"statusCode":404') && !String(e).includes("client data"));
});

test("no SDK opened a socket or used global fetch outside the gate", () => {
  assert.deepEqual(bypass, []);
});

test("loaded under Claude Code, the Stripe SDK prints no plugin hint and the agent's variables come back", () => {
  const code = `const m = await import(${JSON.stringify(new URL("../core/sdk/vendor/stripe.ts", import.meta.url).href)}); m.stripe(); process.stdout.write(String(process.env.CLAUDECODE));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, CLAUDECODE: "1", HOME }, encoding: "utf8" });
  assert.equal(r.status, 0, "child failed to load the Stripe wrapper");
  assert.ok(!`${r.stdout}${r.stderr}`.includes("claude-code-hint"), "the Stripe SDK printed its plugin hint");
  assert.equal(r.stdout, "1");
});

test("an installed SDK that no longer matches its audited pin is refused, never loaded (security review, 8 Nov)", async () => {
  const { vendorRequire } = await import("../core/sdk/vendor/load.ts");
  const f = new URL("../vendor-sdks/stripe/node_modules/.package-lock.json", import.meta.url);
  const original = fs.readFileSync(f, "utf8");
  try {
    const d = JSON.parse(original);
    d.packages["node_modules/stripe"].integrity = "sha512-tampered";
    fs.writeFileSync(f, JSON.stringify(d));
    assert.throws(() => vendorRequire("stripe"), /does not match the audited pin/);
  } finally { fs.writeFileSync(f, original); }
  assert.doesNotThrow(() => vendorRequire("stripe"));
});

test("the kit carries no SDK code: each SDK is a pinned pointer to its audited build, install scripts off", () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.dependencies, undefined, "the kit itself depends on no vendor SDK");
  const audited: Record<string, [string, string]> = {
    stripe: ["stripe", "sha512-fVUfMSfTPoukfoV//MUKAx2+YxyKmYaYtnAL9VkfnHfaPNQylFdWZMD+zgUFerI8rjbaiER8Vzj2XEUQ2AhAsQ=="],
    xero: ["xero-node", "sha512-X2mIbs/iDVBje3+Tl1K1KqfZXTD6+51f+VQtif8SlJU3Pv6fz2RweN/ZrsC8vpyAPu/KBsKefjevv2PwUsZwMw=="],
    square: ["square", "sha512-kxjA2w1ttzVPPojuwRnco0zIPBEfXOz7zaNsIy0YD1hmtryz92v1jGtw5VNoWb4H/hw9O0crsWnLFjZlJUUQYA=="],
  };
  for (const [app, [name, sha]] of Object.entries(audited)) {
    const dir = new URL(`../vendor-sdks/${app}/`, import.meta.url);
    const lock = JSON.parse(fs.readFileSync(new URL("package-lock.json", dir), "utf8")).packages;
    assert.equal(lock[`node_modules/${name}`].integrity, sha, `${app} is not the audited build`);
    for (const [p, v] of Object.entries<any>(lock)) {
      if (!p) continue;
      assert.ok(!v.hasInstallScript, `${app}: ${p} has an install script`);
      assert.match(v.resolved, /^https:\/\/registry\.npmjs\.org\//, `${app}: ${p} is not from the npm registry`);
      assert.match(v.integrity, /^sha512-/, `${app}: ${p} has no sha512`);
    }
    assert.match(fs.readFileSync(new URL(".npmrc", dir), "utf8"), /^ignore-scripts=true$/m);
  }
});
