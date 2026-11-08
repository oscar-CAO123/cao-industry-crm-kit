// Agent SDK tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import fs from "node:fs";
import assert from "node:assert/strict";
import { setTransport, WriteBlocked } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { listPlatforms, load, search, describe, plan, callOperation, checkDocument, type Op } from "../core/sdk/call.ts";
import { encodeForm } from "../core/lib/form.ts";

type Hit = { url: string; method: string; headers: Record<string, string>; body?: string };
let hits: Hit[] = [];
let logs: string[] = [];

function fakeNetwork() {
  hits = []; logs = [];
  setTransport({
    fetch: (async (url: any, init: any) => {
      const h: Hit = { url: String(url), method: init?.method ?? "GET", headers: init?.headers ?? {}, body: init?.body };
      hits.push(h);
      const u = new URL(h.url);
      let json: unknown = { ok: true };
      if (/token$/.test(u.pathname)) json = { access_token: "tok-test", refresh_token: "r2", expires_in: 3600 };
      if (u.pathname.endsWith("/userinfo")) json = { accounts: [{ account_id: "acct-1", base_uri: "https://au.docusign.net" }] };
      if (u.pathname === "/rest-services/loginInfo") json = { oauthUrl: "https://auth-apac.bullhornstaffing.com/oauth", restUrl: "https://rest-apac.bullhornstaffing.com/rest-services" };
      if (u.hostname.endsWith("bullhornstaffing.com") && u.pathname === "/rest-services/login") json = { BhRestToken: "bh-session-1", restUrl: "https://rest42.bullhornstaffing.com/rest-services/corp9/" };
      return new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
    }) as any,
    sleep: async () => {},
    log: (l: string) => { logs.push(l); },
  });
}

const ENV: Record<string, string> = {
  HUBSPOT_ACCESS_TOKEN: "hs-test", FIREFLIES_API_KEY: "ff-test", MONDAY_API_TOKEN: "mo-test", TELEGRAM_BOT_TOKEN: "123456:ABCdef_test",
  ZENDESK_SUBDOMAIN: "acme", ZENDESK_EMAIL: "ops-at-acme", ZENDESK_API_TOKEN: "zd-test", DEPUTY_SUBDOMAIN: "acme", DEPUTY_REGION: "au",
  DEPUTY_ACCESS_TOKEN: "dp-test", SHOPIFY_SHOP: "acme", SHOPIFY_ACCESS_TOKEN: "sh-test", WORDPRESS_SITE: "example.org", WORDPRESS_USER: "u",
  WORDPRESS_APP_PASSWORD: "p", XERO_CLIENT_ID: "x", XERO_CLIENT_SECRET: "y", XERO_TENANT_ID: "t", XERO_REFRESH_TOKEN: "r1",
  ZOOM_ACCOUNT_ID: "a", ZOOM_CLIENT_ID: "b", ZOOM_CLIENT_SECRET: "c", GOOGLE_MAILBOX: "ops-mailbox", GOOGLE_CLIENT_ID: "g", GOOGLE_CLIENT_SECRET: "h",
  GOOGLE_ADS_DEVELOPER_TOKEN: "dev", DOCUSIGN_INTEGRATION_KEY: "ik", DOCUSIGN_USER_ID: "u1", DOCUSIGN_ACCOUNT_ID: "acct-1",
  AIRCALL_API_ID: "a", AIRCALL_API_TOKEN: "b", CALENDLY_API_TOKEN: "c", META_ADS_TOKEN: "m", WHATSAPP_ACCESS_TOKEN: "w", M365_ACCESS_TOKEN: "ms",
  GHL_ACCESS_TOKEN: "gh", SLACK_BOT_TOKEN: "sl", SLACK_USER_TOKEN: "slu", ASANA_ACCESS_TOKEN: "as", KLAVIYO_API_KEY: "kl", SERVICEM8_API_KEY: "s8",
  SMOKEBALL_ACCESS_TOKEN: "sb", SMOKEBALL_API_KEY: "sbk", CANVA_ACCESS_TOKEN: "cv", FERGUS_ACCESS_TOKEN: "fg", BLUEBEAM_ACCESS_TOKEN: "bb",
  BLUEBEAM_CLIENT_ID: "bc", CLINIKO_API_KEY: "ck", CLINIKO_USER_AGENT: "Kit test", DROPBOX_ACCESS_TOKEN: "db", REAPIT_ACCESS_TOKEN: "rp",
  BUILDXACT_ACCESS_TOKEN: "bx", BUILDXACT_SUBSCRIPTION_KEY: "bxk", UNLEASHED_API_ID: "uid-1", UNLEASHED_API_KEY: "ukey-1", UNLEASHED_CLIENT_TYPE: "acme/kit", BULLHORN_CLIENT_ID: "bh-id", BULLHORN_CLIENT_SECRET: "bh-secret", BULLHORN_USERNAME: "api.user", BULLHORN_REFRESH_TOKEN: "bh-r1", AROFLO_SECRET_KEY: "asecret", AROFLO_UENCODED: "u=1", AROFLO_PENCODED: "p&2", AROFLO_ORGENCODED: "o 3",
};

// Every key and host variable a platform declares gets a fake value, so new platforms need no hand-written entry here.
const AUTO_ENV: Record<string, string> = {};
for (const id of listPlatforms()) {
  const pl = load(id).platform;
  // Only what the platform signs in with (never its documentation list, which names optional files like a service account).
  const authEnvs = [pl.auth, ...[...load(id).ops.values()].map((o: any) => o.auth).filter(Boolean)];
  for (const m of JSON.stringify(authEnvs).matchAll(/\b([A-Z][A-Z0-9]*_[A-Z0-9_]+)\b/g)) AUTO_ENV[m[1]] ??= `t-${m[1].toLowerCase()}`;
  for (const v of Object.values(pl.serverVars) as any[]) AUTO_ENV[v.env] = v.example ?? v.default ?? "acme";
  for (const pin of Object.values(pl.pinned ?? {}) as any[]) if (pin.env) AUTO_ENV[pin.env] ??= `t-${pin.env.toLowerCase()}`;
}

beforeEach(async () => {
  fakeNetwork();
  for (const [k, v] of Object.entries({ ...AUTO_ENV, ...ENV })) process.env[k] = v;
  delete process.env.KIT_ALLOW_WRITES;
  const store = new MemoryTokenStore();
  await store.set("google.refresh_token.ops-mailbox", "gr");
  setTokenStore(store);
  // DocuSign signs a JWT with a real RSA key, so give it a throwaway one.
  const { generateKeyPairSync } = await import("node:crypto");
  process.env.DOCUSIGN_PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
});

const firstOp = (id: string, f: (o: Op) => boolean) => [...load(id).ops.values()].find(f)!;

test("every generated platform loads and has unique operation ids", () => {
  const ids = listPlatforms();
  assert.equal(ids.length, JSON.parse(fs.readFileSync(new URL("../core/sdk/platforms/index.json", import.meta.url), "utf8")).platforms.filter((x: any) => x.ops).length);
  let total = 0;
  for (const id of ids) {
    const { platform, ops } = load(id);
    assert.equal(ops.size, platform.counts.operations, id);
    total += ops.size;
  }
  assert.equal(total, JSON.parse(fs.readFileSync(new URL("../core/sdk/platforms/index.json", import.meta.url), "utf8")).platforms.reduce((a: number, x: any) => a + x.ops, 0));
});

test("search and describe find endpoints by plain words", () => {
  const r = search("xero", "invoices");
  assert.ok(r.some((o) => o.id === "accounting.getInvoices"));
  assert.equal(describe("xero", "accounting.getInvoices").method, "GET");
  assert.throws(() => describe("xero", "nope"), /no operation/);
});

test("a read goes to the platform's own host with the key in a header", async () => {
  const o = firstOp("hubspot", (x) => x.kind === "read" && !x.params.some((p) => p.required));
  await callOperation("hubspot", o.id);
  assert.equal(hits.length, 1);
  assert.equal(new URL(hits[0].url).hostname, "api.hubapi.com");
  assert.equal(hits[0].headers.Authorization, "Bearer hs-test");
  assert.ok(!hits[0].url.includes("hs-test"));
});

test("a write is blocked before any network call unless KIT_ALLOW_WRITES=1", async () => {
  const o = firstOp("hubspot", (x) => x.kind === "write" && !x.params.some((p) => p.required && p.in === "path"));
  await assert.rejects(() => callOperation("hubspot", o.id, { body: {} }), WriteBlocked);
  assert.equal(hits.length, 0);
  process.env.KIT_ALLOW_WRITES = "1";
  await callOperation("hubspot", o.id, { body: {} });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].method, o.method);
});

test("unknown params, missing required params and path tricks fail before the network", async () => {
  const o = firstOp("xero", (x) => x.kind === "read" && x.params.some((p) => p.in === "path" && p.required));
  const pathParam = o.params.find((p) => p.in === "path" && p.required)!.name;
  await assert.rejects(() => callOperation("xero", o.id, { params: { notAParam: 1 } }), /unknown param/);
  await assert.rejects(() => callOperation("xero", o.id, {}), /missing required/);
  await assert.rejects(() => callOperation("xero", o.id, { params: { [pathParam]: "../../Organisation" } }), /not allowed/);
  assert.equal(hits.length, 0);
  const p = await plan("xero", o.id, { params: { [pathParam]: "a/b?c=d" } });
  assert.ok(p.url.includes("a%2Fb%3Fc%3Dd"));
});

test("a header param can never carry a key", async () => {
  const withHeader = [...load("klaviyo").ops.values()].find((x) => x.params.some((p) => p.in === "header"));
  if (withHeader) {
    const h = withHeader.params.find((p) => p.in === "header")!;
    const p = await plan("klaviyo", withHeader.id, { params: Object.fromEntries(withHeader.params.filter((x) => x.required || x === h).map((x) => [x.name, "v"])) });
    assert.equal(p.headers.Authorization, "[from KLAVIYO_API_KEY]");
  }
  await assert.rejects(() => plan("hubspot", firstOp("hubspot", () => true).id, { params: { Authorization: "Bearer stolen" } }), /unknown param/);
});

test("GraphQL: a query is a read, a mutation is blocked, and a read cannot smuggle a mutation", async () => {
  const q = firstOp("fireflies", (x) => x.method === "QUERY" && !x.params.some((p) => p.required));
  await callOperation("fireflies", q.id, { select: "id" });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].method, "POST");
  assert.match(JSON.parse(hits[0].body!).query, /^query Kit/);
  const m = firstOp("fireflies", (x) => x.method === "MUTATION");
  await assert.rejects(() => callOperation("fireflies", m.id, {}), WriteBlocked);
  await assert.rejects(() => callOperation("fireflies", q.id, { select: "id } } mutation X { deleteTranscript(id: 1) { id" }), /select may only list fields/);
  assert.throws(() => checkDocument("query A { me { id } } mutation B { x }", "query"), /exactly one operation/);
  assert.throws(() => checkDocument("mutation { productDelete(id: 1) { id } }", "query"), /is a mutation/);
  assert.doesNotThrow(() => checkDocument("query { shop { name } }", "query", "shop"));
});

test("Telegram's key sits in the path: a plan never shows it and logs redact it", async () => {
  const o = firstOp("telegram", (x) => x.id === "getMe");
  const p = await plan("telegram", o.id);
  assert.ok(!p.url.includes("ABCdef_test"));
  for (const k of Object.keys(ENV)) delete process.env[k];
  const blind = await plan("hubspot", firstOp("hubspot", (x) => x.kind === "read" && !x.params.some((q) => q.required)).id);
  assert.equal(blind.headers.Authorization, "[from HUBSPOT_ACCESS_TOKEN]"); // a preview reads no secret
  for (const [k, v] of Object.entries(ENV)) process.env[k] = v;
  await callOperation("telegram", o.id);
  assert.ok(hits[0].url.includes("/bot123456:ABCdef_test/getMe"));
  assert.ok(logs.every((l) => !l.includes("ABCdef_test")));
});

test("server variables must match their pattern, and site hosts come only from the secret store", async () => {
  const z = firstOp("zendesk", (x) => x.kind === "read" && !x.params.some((p) => p.required));
  process.env.ZENDESK_SUBDOMAIN = "evil.com/x";
  await assert.rejects(() => callOperation("zendesk", z.id), /unexpected value/);
  process.env.ZENDESK_SUBDOMAIN = "acme";
  await callOperation("zendesk", z.id);
  assert.equal(new URL(hits[0].url).hostname, "acme.zendesk.com");
  const w = firstOp("wordpress", (x) => x.kind === "read" && !x.params.some((p) => p.required));
  delete process.env.WORDPRESS_SITE;
  await assert.rejects(() => callOperation("wordpress", w.id, { server: { site: "attacker.example" } }), /set WORDPRESS_SITE/);
});

test("platforms with unbuilt sign-in refuse to call", async () => {
  // AroFlo, Unleashed and Bullhorn are built now (8 Nov); SiteMinder's per-product sign-in is not yet.
  const a = firstOp("siteminder", (x) => x.kind === "read");
  await assert.rejects(() => callOperation("siteminder", a.id), /not wired yet/);
  assert.equal(hits.length, 0);
});

// The sweep: every endpoint of every platform through the real call path, on the fake network.
function dummy(t: string): unknown {
  const s = t.toLowerCase();
  if (/^(integer|int|number|float|double)|^int!|^float!/.test(s)) return 1;
  if (/^bool/.test(s)) return true;
  if (/^(array|\[)/.test(s)) return [];
  return "v1";
}

test("sweep: every read reaches only its own host with a complete URL; every write is blocked first", async () => {
  let reads = 0, writes = 0, refused = 0;
  const problems: string[] = [];
  for (const id of listPlatforms()) {
    const { platform, ops } = load(id);
    const hostOk = (h: string) => (platform.hostFromEnv && Object.values(platform.serverVars).some((v: any) => h === process.env[v.env])) || platform.hosts.includes(h) || platform.hostPatterns.some((p) => new RegExp(`^(?:${p})$`).test(h)) || /(^|\.)docusign\.net$/.test(h) && id === "docusign";
    for (const o of ops.values()) {
      const sample = (p: { pattern?: string; type: string; reserved?: boolean }) => p.reserved && p.pattern
        ? p.pattern.replace(/^\^|\$$/g, "").replace(/\[\^\/\]\+/g, "x1").replace(/\.\*|\.\+/g, "x1").replace(/\\/g, "")
        : p.in === "path" ? "v1" : dummy(p.type);  // a path part is one plain segment
      const params = Object.fromEntries(o.params.filter((p) => p.required && !(platform.pinned ?? {})[p.name]).map((p) => [p.name, sample(p)]));
      const input = platform.status === "index-only" ? { document: `${o.method === "MUTATION" ? "mutation" : "query"} { ${o.path} { __typename } }` } : { params, body: o.body && o.method !== "GET" ? {} : undefined };
      hits = [];
      try {
        await callOperation(id, o.id, input);
        if (o.kind === "write") { problems.push(`${id} ${o.id}: write was not blocked`); continue; }
        const AUTH_HOSTS = new Set(["identity.xero.com", "zoom.us", "oauth2.googleapis.com", "account.docusign.com", "account-d.docusign.com"]);
        // Bullhorn's sign-in runs on its data-centre hosts: loginInfo, the OAuth token and the session login.
        const AUTH_PATH = /^\/rest-services\/(loginInfo|login)$|^\/oauth\/token$/;
        const api = hits.filter((h) => { const u = new URL(h.url); return !AUTH_HOSTS.has(u.hostname) && !(u.hostname.endsWith(".bullhornstaffing.com") && AUTH_PATH.test(u.pathname)); });
        if (api.length !== 1) { problems.push(`${id} ${o.id}: ${api.length} api calls`); continue; }
        const u = new URL(api[0].url);
        if (!hostOk(u.hostname)) problems.push(`${id} ${o.id}: host ${u.hostname}`);
        if (/[{}%]/.test(u.hostname) || /[{}]/.test(decodeURIComponent(api[0].url.split("/")[2] ?? ""))) problems.push(`${id} ${o.id}: unfilled host ${u.hostname}`);
        if (/[{}]/.test(decodeURIComponent(u.pathname))) problems.push(`${id} ${o.id}: unfilled path ${u.pathname}`);
        reads++;
      } catch (e: any) {
        if (e instanceof WriteBlocked && o.kind === "write") { if (hits.length) problems.push(`${id} ${o.id}: write touched the network`); writes++; continue; }
        if (/not wired yet|not supported|no envelope builder|signer is not built/.test(e.message) && (platform.auth.type === "unsupported" || (o as any).auth?.type === "unsupported" || o.authUnsupported)) { refused++; continue; }
        if (/no sign-in scope is mapped/.test(e.message) && id === "google-workspace") { refused++; continue; }
        problems.push(`${id} ${o.id}: ${e.message.slice(0, 120)}`);
      }
    }
  }
  if (problems.length) console.log("SWEEP-PROBLEMS\n" + problems.join("\n"));
  assert.deepEqual(problems.slice(0, 25), [], `${problems.length} problems`);
  assert.equal(reads + writes + refused, [...listPlatforms()].reduce((a, id) => a + load(id).ops.size, 0));
});

// Review pass 1 findings: each trigger replayed exactly.
test("review 1: a read document cannot smuggle a mutation with a comma or a # inside a string", async () => {
  const q = firstOp("shopify", (x) => x.method === "QUERY" && x.kind === "read");
  for (const doc of [
    `query Q { ${q.path} { __typename } },mutation M { productDelete(input: {id: "1"}) { id } }`,
    `query Q { ${q.path}(x: "#") { __typename } } mutation M { productDelete(input: {id: "1"}) { id } }`,
    `query Q { ${q.path}(x: """ # """) { __typename } }\nmutation M { productDelete(input: {id: "1"}) { id } }`,
    `{ ${q.path} { __typename } } mutation { productDelete(input: {id: "1"}) { id } }`,
  ]) {
    await assert.rejects(() => callOperation("shopify", q.id, { document: doc }), /exactly one operation|unexpected/);
  }
  assert.equal(hits.length, 0);
  await callOperation("shopify", q.id, { document: `query Q($a: String = "x # y") { ${q.path} { __typename } }` });
  assert.equal(hits.length, 1);
});

test("review 1: the Google mailbox is pinned to the secret store", async () => {
  const o = firstOp("google-workspace", (x) => x.kind === "read" && !x.params.some((p) => p.required));
  await assert.rejects(() => callOperation("google-workspace", o.id, { as: "someone-else" }), /mailbox not allowed/);
  assert.equal(hits.length, 0);
  process.env.GOOGLE_ALLOWED_MAILBOXES = "second-box";
  const store = new MemoryTokenStore();
  await store.set("google.refresh_token.second-box", "gr2");
  setTokenStore(store);
  await callOperation("google-workspace", o.id, { as: "second-box" });
  delete process.env.GOOGLE_ALLOWED_MAILBOXES;
});

test("review 1: an email mailbox works with the file token store", async () => {
  const { FileTokenStore } = await import("../core/lib/secrets.ts");
  const { refreshKey } = await import("../core/connectors/google-workspace/auth.ts");
  const os = await import("node:os"); const fs = await import("node:fs"); const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kit-tokens-"));
  const store = new FileTokenStore(dir);
  await store.set(refreshKey("Ops.Team@example.com"), "gr3");
  assert.equal(await store.get(refreshKey("ops.team@example.com")), "gr3");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("review 1: a GET takes no body, so unmapped values cannot reach its query", async () => {
  const o = firstOp("hubspot", (x) => x.method === "GET" && !x.params.some((p) => p.required));
  await assert.rejects(() => plan("hubspot", o.id, { body: { notMapped: "x" } }), /a GET takes no body/);
});

// Review pass 2 findings: each trigger replayed exactly.
test("review 2: a caller cannot move the client's key to another tenant", async () => {
  const z = firstOp("zendesk", (x) => x.kind === "read" && !x.params.some((p) => p.required));
  await callOperation("zendesk", z.id, { server: { subdomain: "attacker-tenant" } });
  assert.equal(new URL(hits[0].url).hostname, "acme.zendesk.com");
  const s = firstOp("shopify", (x) => x.method === "QUERY" && x.kind === "read");
  await callOperation("shopify", s.id, { server: { shop: "attacker-shop" }, document: `query { ${s.path} { __typename } }` });
  assert.equal(new URL(hits[1].url).hostname, "acme.myshopify.com");
  const d = firstOp("deputy", (x) => x.kind === "read" && !x.params.some((p) => p.required));
  await callOperation("deputy", d.id, { server: { subdomain: "attacker", install: "attacker" } });
  assert.match(new URL(hits[2].url).hostname, /^acme\.au\.deputy\.com$/);
});

test("review 2: Slack and Telegram actions listed as GET are writes, and token endpoints are gated", async () => {
  for (const [pid, opId] of [["slack", "auth_revoke"], ["slack", "views_publish"], ["telegram", "getManagedBotToken"], ["telegram", "getUpdates"]] as const) {
    const o = load(pid).ops.get(opId);
    if (!o) continue;
    assert.equal(o.kind, "write", `${pid} ${opId}`);
    await assert.rejects(() => callOperation(pid, opId, { params: Object.fromEntries(o.params.filter((p) => p.required).map((p) => [p.name, "v1"])) }), WriteBlocked);
  }
  assert.equal(hits.length, 0);
  const vp = load("slack").ops.get("views_publish");
  if (vp) assert.ok(!vp.params.some((p) => p.name.toLowerCase() === "token"));
});

// Review pass 3 findings: each trigger replayed exactly.
test("review 3: endpoints that return secrets or change state are gated even when the vendor lists them as GET", async () => {
  const cases: [string, (o: Op) => boolean][] = [
    ["zoom", (o) => /private_key/.test(o.path)],
    ["docusign", (o) => o.id === "esignature.ConnectHMAC_GetConnectSecret"],
    ["google-workspace", (o) => o.id === "admin.directory.verificationCodes.list"],
    ["microsoft-365", (o) => /GetDeviceLocalCredentials/.test(o.id)],
    // A GET whose own name and summary are an action (Zenoti cancels a payment on a GET). HubSpot's GET
    // unsubscribe-all used to be here, but HubSpot's own spec calls it a status read; its POST unsubscribes.
    ["zenoti", (o) => /\/Cancel$/.test(o.path) && o.method === "GET"],
    ["deputy", (o) => /AuthorizationCode/.test(o.id)],
    ["deputy", (o) => /PublishShiftV2Controller_resume/.test(o.id)],
  ];
  for (const [pid, f] of cases) {
    const o = [...load(pid).ops.values()].find(f);
    assert.ok(o, `${pid}: case not found`);
    assert.equal(o!.kind, "write", `${pid} ${o!.id}`);
    await assert.rejects(() => callOperation(pid, o!.id, { params: Object.fromEntries(o!.params.filter((p) => p.required && p.name !== "accountId" && p.name !== "userId").map((p) => [p.name, "v1"])) }), WriteBlocked);
  }
  assert.equal(hits.length, 0);
});

test("a GET is a read unless its own name or the vendor's summary is an action: words naming the resource do not gate it (8 Nov fix)", () => {
  const find = (pid: string, f: (o: Op) => boolean) => { const o = [...load(pid).ops.values()].find(f); assert.ok(o, `${pid}: case not found`); return o!; };
  // Reads the old any-word rule mislabelled as writes; each vendor's spec calls them retrievals.
  for (const [pid, f] of [
    ["hubspot", (o: Op) => o.method === "GET" && /\/v4\/statuses\/\{subscriberIdString\}\/unsubscribe-all$/.test(o.path)],
    ["microsoft-365", (o: Op) => o.method === "GET" && o.path === "/solutions/backupRestore/sharePointRestoreSessions"],
    ["meta-ads", (o: Op) => o.id === "AdSet.get.ads"],
    ["klaviyo", (o: Op) => o.id === "get_bulk_update_categories_jobs"],
  ] as [string, (o: Op) => boolean][]) assert.equal(find(pid, f).kind, "read", pid);
  // Every GET still labelled a write says why.
  for (const pid of listPlatforms()) for (const o of load(pid).ops.values()) {
    if (o.method === "GET" && o.kind === "write") assert.ok(o.override, `${pid} ${o.id}: GET labelled write with no reason`);
  }
});

test("bodies go in the encoding the vendor's spec requires: form for Stripe and Twilio (Twilio repeats keys for lists), multipart refused clearly", async () => {
  // The encoder matches the vendors' own SDKs.
  assert.deepEqual(encodeForm({ a: 1, b: { c: true }, l: ["x", "y"], n: null, u: undefined }), [["a", "1"], ["b[c]", "true"], ["l[0]", "x"], ["l[1]", "y"], ["n", ""]]);
  assert.deepEqual(encodeForm({ l: ["x", "y"] }, "repeat"), [["l", "x"], ["l", "y"]]);
  assert.equal(load("twilio").platform.formArrays, "repeat");
  // Every endpoint whose vendor spec accepts only form encoding is marked so (Stripe v1 has no JSON bodies).
  for (const o of load("stripe").ops.values()) {
    if (o.method === "GET" || !o.body) continue;
    // v1 writes are form only; v2 writes are JSON; the v1 file uploads are multipart.
    if (o.path.startsWith("/v1/")) assert.ok(o.bodyType === "form" || o.bodyType === "multipart", `stripe ${o.id} ${o.path}: ${o.bodyType}`);
    if (o.path.startsWith("/v2/")) assert.equal(o.bodyType, undefined, `stripe ${o.id}`);
  }
  process.env.KIT_ALLOW_WRITES = "1";
  const msg = describe("twilio", "api_v2010.CreateMessage");
  assert.equal(msg.bodyType, "form");
  const params = Object.fromEntries(msg.params.filter((p) => p.required && p.in === "path").map((p) => [p.name, process.env.TWILIO_ACCOUNT_SID ?? "AC00000000000000000000000000000000"]));
  await callOperation("twilio", msg.id, { params, body: { To: "+61400000000", Body: "hi", StatusCallbackEvent: ["initiated", "ringing"] } });
  const h = hits[hits.length - 1];
  assert.match(String(Object.entries(h.headers).find(([k]) => k.toLowerCase() === "content-type")?.[1]), /x-www-form-urlencoded/);
  assert.deepEqual([...new URLSearchParams(String(h.body))].filter(([k]) => k === "StatusCallbackEvent"), [["StatusCallbackEvent", "initiated"], ["StatusCallbackEvent", "ringing"]]);
  // An upload-only endpoint is refused with a clear reason, never sent as JSON.
  const up = [...load("zoom").ops.values()].find((o) => o.bodyType === "multipart")!;
  const before = hits.length;
  await assert.rejects(() => callOperation("zoom", up.id, { params: Object.fromEntries(up.params.filter((p) => p.required).map((p) => [p.name, "v1"])) }), /multipart upload/);
  assert.equal(hits.length, before);
  delete process.env.KIT_ALLOW_WRITES;
});

test("review 3: Gmail userId and DocuSign accountId are pinned to the client's own", async () => {
  const g = [...load("google-workspace").ops.values()].find((o) => o.id === "gmail.users.messages.list")!;
  await assert.rejects(() => callOperation("google-workspace", g.id, { params: { userId: "someone-else" } }), /must be the client's own/);
  await callOperation("google-workspace", g.id);
  assert.ok(hits.some((h) => h.url.includes("/users/me/messages")));
  const d = firstOp("docusign", (o) => o.kind === "read" && o.params.some((p) => p.name === "accountId") && o.params.filter((p) => p.required).length === 1);
  await assert.rejects(() => callOperation("docusign", d.id, { params: { accountId: "other-account-guid" } }), /must be the client's own/);
  hits = [];
  await callOperation("docusign", d.id);
  assert.ok(hits.some((h) => h.url.includes("/accounts/acct-1")));
});

test("DocuSign API families reach their production hosts, and the sign-in asks for each endpoint's scopes (8 Nov)", async () => {
  const { clearTokenCache } = await import("../core/connectors/docusign/client.ts");
  clearTokenCache();
  const scopesAsked = () => hits.filter((h) => h.url.endsWith("/oauth/token")).map((h) => {
    const jwt = new URLSearchParams(String(h.body)).get("assertion") ?? "";
    return JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString()).scope as string;
  });
  hits = [];
  await callOperation("docusign", "rooms.Accounts_GetAccountInformation");
  assert.ok(hits.some((h) => h.url.startsWith("https://rooms.docusign.com/restapi/v2/accounts/acct-1")), "Rooms goes to its production host");
  assert.deepEqual(scopesAsked().at(-1)!.split(" ").sort(), ["dtr.company.read", "dtr.documents.read", "dtr.profile.read", "dtr.rooms.read", "impersonation", "signature"]);
  hits = [];
  await callOperation("docusign", "click.ServiceInformation_GetServiceInformation");
  assert.ok(hits.some((h) => h.url === "https://au.docusign.net/clickapi/service_information"), "Click runs on the account's own server");
  assert.ok(scopesAsked().at(-1)!.split(" ").includes("click.manage"));
  // No DocuSign family is left refused or without a production host.
  for (const o of load("docusign").ops.values()) {
    assert.equal(o.authUnsupported, undefined, o.id);
    assert.doesNotMatch(o.server, /demo|api-d\.|apps-d\./, o.id);
  }
});

test("Cloudbeds Group Profile reaches api.cloudbeds.com; Guest Profiles stays refused until Cloudbeds names its host (8 Nov)", async () => {
  const g = [...load("cloudbeds").ops.values()].find((o) => o.method === "GET" && o.path === "/group-profile/v1/profiles")!;
  hits = [];
  await callOperation("cloudbeds", g.id, { params: Object.fromEntries(g.params.filter((p) => p.required).map((p) => [p.name, "org-1"])) });
  assert.ok(hits.some((h) => h.url.startsWith("https://api.cloudbeds.com/group-profile/v1/profiles")));
  const guest = [...load("cloudbeds").ops.values()].find((o) => o.server === "/guest-profiles/v1")!;
  await assert.rejects(() => callOperation("cloudbeds", guest.id), /relative server/);
  assert.ok(load("bluebeam").platform.gaps.some((x) => /Australian Studio host/.test(x)));
});

test("Unleashed signs each request: base64 HMAC-SHA256 of the exact query string with the API key (8 Nov)", async () => {
  const { createHmac } = await import("node:crypto");
  const ops = [...load("unleashed").ops.values()];
  // Unleashed's inputs are mapped from its reference tables (8 Nov): use a read with an optional query input.
  const withQuery = ops.find((o) => o.method === "GET" && o.kind === "read" && !o.params.some((p) => p.required) && o.params.some((p) => p.in === "query"))!;
  const q = withQuery.params.find((p) => p.in === "query")!.name;
  for (const params of [{}, { [q]: "ACME 1" }]) {
    hits = [];
    await callOperation("unleashed", withQuery.id, { params });
    const h = hits[0];
    const query = new URL(h.url).search.replace(/^\?/, "");
    assert.equal(h.headers["api-auth-signature"], createHmac("sha256", "ukey-1").update(query).digest("base64"), "signature over the exact query sent");
    assert.equal(h.headers["api-auth-id"], "uid-1");
    assert.equal(h.headers["client-type"], "acme/kit");
    assert.equal(h.headers["Content-Type"], "application/json");
    assert.equal(h.headers.Authorization, undefined, "Unleashed takes no Authorization header");
  }
  assert.equal(load("unleashed").platform.auth.type, "custom");
});

test("AroFlo: each example is a zoned call, signed with hex HMAC-SHA512 over AroFlo's payload, exact strings (8 Nov)", async () => {
  const { createHmac } = await import("node:crypto");
  const ops = [...load("aroflo").ops.values()];
  assert.equal(ops.filter((o) => o.path !== "/" || !(o.fixedQuery || o.fixedForm)).length, 0, "every example has its zone");
  const check = (h: any, method: string, varString: string) => {
    const auth = h.headers.Authorization;
    assert.equal(auth, "uencoded=u%3D1&pencoded=p%262&orgEncoded=o%203");
    const payload = [method, "", "text/json", auth, h.headers.afdatetimeutc, varString].join("+");
    assert.equal(h.headers.Authentication, `HMAC ${createHmac("sha512", "asecret").update(payload).digest("hex")}`);
    assert.equal(h.headers.Accept, "text/json");
  };
  const get = ops.find((o) => o.method === "GET" && o.fixedQuery?.zone === "tasks")!;
  hits = [];
  await callOperation("aroflo", get.id, { params: { where: ["and|status|=|not started", "and|priority|=|high"], page: 1 } });
  assert.equal(hits[0].url, "https://api.aroflo.com/?zone=tasks&page=1&where=and%7Cstatus%7C%3D%7Cnot%20started&where=and%7Cpriority%7C%3D%7Chigh");
  check(hits[0], "GET", new URL(hits[0].url).search.slice(1));
  const post = ops.find((o) => o.method === "POST")!;
  process.env.KIT_ALLOW_WRITES = "1";
  hits = [];
  try { await callOperation("aroflo", post.id, { params: { postxml: "<x a='1'>&</x>" } }); } finally { delete process.env.KIT_ALLOW_WRITES; }
  assert.equal(hits[0].body, `zone=${encodeURIComponent(post.fixedForm!.zone)}&postxml=${encodeURIComponent("<x a='1'>&</x>")}`);
  assert.equal(hits[0].headers["Content-Type"], "application/x-www-form-urlencoded");
  check(hits[0], "POST", String(hits[0].body));
});

test("Bullhorn: data centre, refresh token in a form body, one session login, calls on the session URL, retry once on 401 (8 Nov)", async () => {
  const b = await import("../core/connectors/bullhorn/client.ts");
  b.clearForTests();
  // Bullhorn's reference documents entitlements per entity (GET /entitlements/{entity}), mapped 8 Nov from its request lines.
  const op = [...load("bullhorn").ops.values()].find((o) => o.method === "GET" && o.kind === "read" && o.path === "/entitlements/{id}")!;
  hits = [];
  await callOperation("bullhorn", op.id, { params: { id: "Candidate" } });
  await callOperation("bullhorn", op.id, { params: { id: "Candidate" } });
  const urls = hits.map((h) => h.url);
  assert.ok(urls[0].startsWith("https://rest.bullhornstaffing.com/rest-services/loginInfo?username=api.user"));
  const token = hits.find((h) => h.url === "https://auth-apac.bullhornstaffing.com/oauth/token")!;
  assert.ok(token, "token exchange on the data centre's OAuth host");
  assert.match(String(token.body), /grant_type=refresh_token/);
  assert.match(String(token.body), /client_secret=bh-secret/);
  assert.ok(!urls.some((u) => u.includes("client_secret") || u.includes("refresh_token")), "secrets never in a URL");
  assert.equal(urls.filter((u) => u.startsWith("https://rest-apac.bullhornstaffing.com/rest-services/login?")).length, 1, "one login for two calls");
  const calls = hits.filter((h) => h.url.startsWith("https://rest42.bullhornstaffing.com/rest-services/corp9/entitlements"));
  assert.equal(calls.length, 2);
  for (const c of calls) assert.equal(c.headers.BhRestToken, "bh-session-1");
  assert.ok(!urls.filter((u) => !u.includes("/rest-services/login?")).some((u) => /access_token=/.test(u)), "the access token appears only on the login call");
  assert.ok(hits.filter((h) => h.url.includes("/rest-services/login?")).every((h) => h.method === "POST"), "login is a POST (Getting Started)");
  // An expired session answers 401: the kit refreshes, logs in once more and retries the call once.
  const real = hits;
  let failed = false;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url));
      real.push({ url: String(url), method: init?.method ?? "GET", headers: init?.headers ?? {}, body: init?.body });
      if (u.pathname.endsWith("/entitlements/Candidate") && !failed) { failed = true; return new Response("{}", { status: 401 }); }
      if (u.pathname === "/oauth/token") return Response.json({ access_token: "at-2", refresh_token: "r3" });
      if (u.pathname === "/rest-services/login") return Response.json({ BhRestToken: "bh-session-2", restUrl: "https://rest42.bullhornstaffing.com/rest-services/corp9/" });
      return Response.json({ ok: true });
    }) as any,
  });
  hits.length = 0;
  await callOperation("bullhorn", op.id, { params: { id: "Candidate" } });
  const after = hits.filter((h) => h.url.includes("/entitlements"));
  assert.equal(after.length, 2, "one failed call and one retry");
  assert.equal(after[1].headers.BhRestToken, "bh-session-2", "the retry uses the new session");
  assert.equal(hits.filter((h) => h.url.includes("/rest-services/login?")).length, 1, "exactly one new login");
});

test("security review fixes (8 Nov): action GETs gated, GraphQL queries read, AroFlo body refused, more key names refused, redirect hops checked", async () => {
  const find = (pid: string, f: (o: Op) => boolean) => [...load(pid).ops.values()].find(f)!;
  assert.equal(find("calendesk", (o) => o.path === "/newsletter/resend/{email}").kind, "write", "Resend verification email sends mail");
  assert.equal(find("productive", (o) => o.path === "/api/v2/signups/xero_finalize").kind, "write", "Finalize a signup");
  assert.equal(find("monday", (o) => o.method === "QUERY" && o.path === "trigger_events").kind, "read", "a GraphQL query cannot change data");
  assert.equal(find("apollo", (o) => o.method === "GET" && o.path === "/duplicate_contacts/merge_jobs/{id}").kind, "read", "[BETA] View ... is a read");
  const post = find("aroflo", (o) => o.method === "POST");
  process.env.KIT_ALLOW_WRITES = "1";
  try { await assert.rejects(() => callOperation("aroflo", post.id, { params: { postxml: "<x/>" }, body: { zone: "x" } }), /not a body/); }
  finally { delete process.env.KIT_ALLOW_WRITES; }
  const { checkUrl, call: gateCall } = await import("../core/lib/http.ts");
  const spec = { app: "t", hosts: ["api.example.com"] };
  for (const q of ["signature=a", "sig=a", "auth=a", "authorization=a", "jwt=a", "credential=a"]) assert.throws(() => checkUrl(spec, new URL(`https://api.example.com/x?${q}`)), /key in the query/);
  setTransport({ sleep: async () => {}, log: () => {}, fetch: (async () => new Response("", { status: 302, headers: { location: "https://api.example.com:8443/file" } })) as any });
  await assert.rejects(() => gateCall(spec, { url: "https://api.example.com/download", followDownloadRedirects: true, binary: true }), /non-standard port/);
});

test("review 3: the WordPress host is exactly the one in the secret store", async () => {
  const w = firstOp("wordpress", (x) => x.kind === "read" && !x.params.some((p) => p.required));
  await callOperation("wordpress", w.id);
  assert.equal(new URL(hits[0].url).hostname, "example.org");
  assert.deepEqual(load("wordpress").platform.hostPatterns, []);
});

test("Dropbox reads go out as read-only POSTs; Slack SDK-only methods take inputs but never keys", async () => {
  const lf = load("dropbox").ops.get("files.list_folder") ?? firstOp("dropbox", (o) => /list_folder$/.test(o.path));
  assert.equal(lf.kind, "read");
  await callOperation("dropbox", lf.id, { body: { path: "" } });
  assert.equal(hits.at(-1)!.method, "POST");
  const sb = [...load("slack").ops.values()].find((o) => o.paramsUnmapped && o.kind === "read");
  if (sb) {
    await callOperation("slack", sb.id, { params: { limit: 5 } });
    assert.ok(hits.at(-1)!.url.includes("limit=5"));
    await assert.rejects(() => callOperation("slack", sb.id, { params: { token: "x" } }), /not allowed/);
  }
});

// Review pass 4 findings and the read-only POST rule.
test("review 4: unmapped inputs can never carry key-shaped names; signed links are gated; reviewed POST reads stay narrow", async () => {
  const sb = [...load("slack").ops.values()].find((o) => o.paramsUnmapped && o.kind === "read");
  if (sb) for (const k of ["refresh_token", "private_key", "authorization", "x_token", "session_token", "client_secret", "api_key"]) {
    await assert.rejects(() => callOperation("slack", sb.id, { params: { [k]: "X" } }), /not allowed/);
  }
  assert.equal(hits.length, 0);
  const gl = load("dropbox").ops.get("files.get_temporary_link") ?? [...load("dropbox").ops.values()].find((o) => /get_temporary_link$/.test(o.path));
  assert.equal(gl?.kind, "write");
  for (const o of [...load("hubspot").ops.values()].filter((x) => /signed-url/.test(x.path))) assert.equal(o.kind, "write", o.id);
  for (const id of listPlatforms()) for (const o of load(id).ops.values()) {
    if (o.readPost) assert.match(o.path, /(\/search$|\/batch\/read$|\/query$|\/_search$|\/search\/|\/query_)/i, `${id} ${o.id}`);
  }
});

// Review pass 5 findings: each trigger replayed exactly.
test("review 5: a resource-name input must match the vendor's pattern, so it cannot reach another endpoint", async () => {
  const o = load("google-workspace").ops.get("admin.customers.chrome.printers.get")!;
  for (const name of ["users/target-user/verificationCodes", "users/target-user/tokens", "tokens/abc"]) {
    await assert.rejects(() => callOperation("google-workspace", o.id, { params: { name } }), /does not match its pattern/);
  }
  assert.equal(hits.length, 0);
});

test("review 5: pins hold on SDK-only endpoints, and the Gmail user is the signed-in mailbox", async () => {
  const li = [...load("docusign").ops.values()].find((x) => x.paramsUnmapped && x.kind === "read" && !x.params.some((p) => p.required && p.name !== "accountId"));
  if (li) await assert.rejects(() => plan("docusign", li.id, { params: { accountId: "other-account-guid" } }), /must be the client's own/);
  process.env.GOOGLE_ALLOWED_MAILBOXES = "second-box";
  await assert.rejects(() => plan("google-workspace", "gmail.users.messages.list", { as: "second-box", params: { userId: "ops-mailbox" } }), /must be the client's own/);
  delete process.env.GOOGLE_ALLOWED_MAILBOXES;
});

test("review 5: more key-shaped names are refused, and refresh tokens never ride in a URL", async () => {
  const sb = [...load("slack").ops.values()].find((o) => o.paramsUnmapped && o.kind === "read");
  if (sb) for (const k of ["pwd", "code", "sig", "refresh"]) await assert.rejects(() => plan("slack", sb.id, { params: { [k]: "x" } }), /not allowed/);
  const { checkUrl } = await import("../core/lib/http.ts");
  assert.throws(() => checkUrl({ app: "t", hosts: ["api.hubapi.com"] }, new URL("https://api.hubapi.com/oauth/v1/token?refresh_token=rt")), /key in the query/);
});

test("coverage: Zendesk files without a server reach the account host, and assessment gates survive an api prefix", async () => {
  for (const api of ["help_center", "voice", "collaboration_api"]) {
    const z = firstOp("zendesk", (x) => x.api === api && x.kind === "read");
    hits = [];
    await callOperation("zendesk", z.id, { params: Object.fromEntries(z.params.filter((p) => p.required).map((p) => [p.name, "1"])) });
    assert.equal(new URL(hits[0].url).hostname, "acme.zendesk.com");
  }
  const zops = load("zendesk").ops;
  for (const id of ["core.ListTargets", "core.ShowTarget", "core.RenewCurrentSession", "core.ShowCurrentUser", "core.ListSupportAddresses", "core.ShowSupportAddress"])
    assert.equal(zops.get(id)?.kind, "write", id);
  assert.equal(load("slack").ops.get("slackLists_download_get")?.override?.startsWith("gated:"), true);
});

test("coverage: no platform's host allowlist accepts an outside domain, and Zoom's key-decrypt route is refused", async () => {
  for (const id of listPlatforms()) {
    for (const h of [...load(id).platform.hosts, ...load(id).platform.hostPatterns]) assert.ok(!/[{}]/.test(h.replace(/\{\d+(,\d*)?\}/g, "")), `${id}: host rule holds a variable: ${h}`);
    for (const pat of load(id).platform.hostPatterns) for (const h of ["attacker.example", "evil.com", "zoom.us.evil.com"])
      assert.ok(!new RegExp(`^(?:${pat})$`).test(h), `${id}: ${pat} accepts ${h}`);
  }
  process.env.ZOOM_KEY_CONNECTOR_HOST = "kc.client.example";
  const cmk = "customer-managed-keys-hybrid.hybrid-cmk-archival-decrypt";
  await assert.rejects(() => callOperation("zoom", cmk), /write blocked/);
  process.env.KIT_ALLOW_WRITES = "1";
  try { await assert.rejects(() => callOperation("zoom", cmk), /never called/); }
  finally { delete process.env.KIT_ALLOW_WRITES; delete process.env.ZOOM_KEY_CONNECTOR_HOST; }
  assert.equal(hits.length, 0);
});

test("coverage: Slack user-only methods sign in with the user token, config methods refuse, Smokeball follows region, Klaviyo never asks for push tokens", async () => {
  const sl = load("slack").ops;
  await callOperation("slack", "search_messages", { params: { query: "x" } });
  assert.equal(hits[0].headers.Authorization, "Bearer slu");
  await callOperation("slack", "conversations_list");
  assert.equal(hits[1].headers.Authorization, "Bearer sl");
  const cfg = [...sl.values()].find((o) => o.authUnsupported?.includes("configuration"))!;
  process.env.KIT_ALLOW_WRITES = "1";
  try { await assert.rejects(() => callOperation("slack", cfg.id), /not wired yet/); } finally { delete process.env.KIT_ALLOW_WRITES; }
  assert.equal(hits.length, 2);
  const sb = firstOp("smokeball", (x) => x.kind === "read" && !x.params.some((p) => p.required));
  await callOperation("smokeball", sb.id);
  assert.equal(new URL(hits[2].url).hostname, "api.smokeball.com.au");
  process.env.SMOKEBALL_REGION_TLD = "co.uk";
  await callOperation("smokeball", sb.id);
  assert.equal(new URL(hits[3].url).hostname, "api.smokeball.co.uk");
  process.env.SMOKEBALL_REGION_TLD = "evil.com";
  await assert.rejects(() => callOperation("smokeball", sb.id), /unexpected value/);
  delete process.env.SMOKEBALL_REGION_TLD;
  const kp = [...load("klaviyo").ops.values()].find((o) => o.path === "/api/profiles" && o.method === "GET")!;
  await assert.rejects(() => plan("klaviyo", kp.id, { params: { revision: "2026-10-15", include: "lists,push-tokens" } }), /refused by the kit/);
  await assert.rejects(() => plan("klaviyo", kp.id, { params: { revision: "2026-10-15", "fields[push-token]": "token" } }), /unknown param/);
  await plan("klaviyo", kp.id, { params: { revision: "2026-10-15", include: "lists" } });
  const bx = load("buildxact").ops.get("oauth.token")!;
  assert.equal(bx.server, "https://login.buildxact.com");
});

test("wave 3: template sign-in, per-endpoint sign-in, refused hosts, regional and tenant hosts", async () => {
  // Trello: both values in one header, never in the URL
  const tr = firstOp("trello", (x) => x.kind === "read" && !x.params.some((p) => p.required));
  await callOperation("trello", tr.id);
  const th = hits[0];
  assert.match(th.headers.Authorization, /^OAuth oauth_consumer_key="t-trello_api_key", oauth_token="t-trello_token"$/);
  assert.ok(!th.url.includes("t-trello"));
  // Twilio uses its account sign-in; SendGrid endpoints inside it use SendGrid's key
  const tw = firstOp("twilio", (x) => x.kind === "read" && x.server.startsWith("https://api.twilio.com") && !x.params.some((p) => p.required));
  const sg = firstOp("twilio", (x) => x.kind === "read" && x.server.startsWith("https://api.sendgrid.com") && !x.params.some((p) => p.required));
  hits = [];
  await callOperation("twilio", tw.id);
  await callOperation("twilio", sg.id);
  assert.match(hits[0].headers.Authorization, /^Basic /);
  assert.equal(hits[1].headers.Authorization, "Bearer t-sendgrid_api_key");
  // Mandrill (key in the body) and a server with no stated host are refused before any network call.
  // (Cloudbeds Group Profile's localhost:8700 is now its real host, per Cloudbeds' own reference; Guest Profiles has no host.)
  const mandrill = firstOp("mailchimp", (x) => x.server.startsWith("https://mandrillapp.com"));
  const local = firstOp("cloudbeds", (x) => x.server === "/guest-profiles/v1");
  process.env.KIT_ALLOW_WRITES = "1";
  hits = [];
  try {
    await assert.rejects(() => callOperation("mailchimp", mandrill.id, { body: {} }), /not wired yet/);
    await assert.rejects(() => callOperation("cloudbeds", local.id, { params: Object.fromEntries(local.params.filter((p) => p.required).map((p) => [p.name, "v1"])) }), /relative server/);
  } finally { delete process.env.KIT_ALLOW_WRITES; }
  assert.equal(hits.length, 0);
  // Clio defaults to its Australian host; Mailchimp goes to the client's data centre
  const cl = firstOp("clio", (x) => x.kind === "read" && x.server.includes("app.clio.com") && !x.params.some((p) => p.required));
  delete process.env.CLIO_REGION;
  await callOperation("clio", cl.id);
  assert.equal(new URL(hits[0].url).hostname, "au.app.clio.com");
  const mc = firstOp("mailchimp", (x) => x.kind === "read" && x.server.includes("api.mailchimp.com") && !x.params.some((p) => p.required));
  await callOperation("mailchimp", mc.id);
  assert.equal(new URL(hits[1].url).hostname, "us1.api.mailchimp.com");
  // WooCommerce's host comes only from the secret store
  const wc = firstOp("woocommerce", (x) => x.kind === "read" && !x.params.some((p) => p.required));
  hits = [];
  await callOperation("woocommerce", wc.id, { server: { site: "attacker.example" } });  // a caller's host is ignored
  assert.equal(new URL(hits[0].url).hostname, "shop.example.org");
  delete process.env.WOOCOMMERCE_SITE;
  await assert.rejects(() => callOperation("woocommerce", wc.id));
});

test("wave 3: a declared path part named like a record (keyId) is allowed, one named exactly like a key is refused", async () => {
  const mk = [...load("make").ops.values()].find((o) => o.paramsUnmapped && o.kind === "read" && o.params.some((p) => p.in === "path" && /key/i.test(p.name)));
  if (mk) {
    await callOperation("make", mk.id, { params: Object.fromEntries(mk.params.filter((p) => p.required).map((p) => [p.name, "v1"])) });
    assert.equal(hits.length, 1);
  }
  const any = [...load("podio").ops.values()].find((o) => o.paramsUnmapped && o.kind === "read")!;
  await assert.rejects(() => plan("podio", any.id, { params: { token: "x" } }), /not allowed/);
  assert.ok(![...load("jotform").ops.values()].some((o) => o.params.some((p) => /^(key|token|secret|password)$/.test(p.name))));
});

test("review 6: a download redirect to another host carries no sign-in header of any kind; placeholder hosts are refused", async () => {
  const { call: httpCall } = await import("../core/lib/http.ts");
  setTransport({
    fetch: (async (url: any, init: any) => {
      hits.push({ url: String(url), method: init?.method ?? "GET", headers: init?.headers ?? {} });
      return hits.length === 1 ? new Response("", { status: 302, headers: { location: "https://storage.example.net/file" } }) : new Response("ok", { status: 200 });
    }) as any, sleep: async () => {}, log: () => {},
  });
  hits = [];
  await httpCall({ app: "t", hosts: ["api.vendor.com"] } as any, { method: "GET", url: "https://api.vendor.com/file", headers: { "X-Api-Key": "k1", Authorization: "Bearer k2", "PLAID-SECRET": "k3", Accept: "application/json" }, followDownloadRedirects: true } as any).catch(() => {});
  assert.equal(hits.length, 2);
  assert.deepEqual(Object.keys(hits[1].headers).map((k) => k.toLowerCase()), ["accept"]);
  fakeNetwork();
  const ota = [...load("cloudbeds").ops.values()].filter((o) => o.server.includes("your-ota"));
  assert.ok(ota.length > 0 && ota.every((o) => o.authUnsupported));
  assert.ok(!load("cloudbeds").platform.hosts.some((h) => h.includes("your-ota")));
});
