// Agent SDK tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import fs from "node:fs";
import assert from "node:assert/strict";
import { setTransport, WriteBlocked } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { listPlatforms, load, search, describe, plan, callOperation, checkDocument, type Op } from "../core/sdk/call.ts";

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
  GHL_ACCESS_TOKEN: "gh", SLACK_BOT_TOKEN: "sl", ASANA_ACCESS_TOKEN: "as", KLAVIYO_API_KEY: "kl", SERVICEM8_API_KEY: "s8",
  SMOKEBALL_ACCESS_TOKEN: "sb", SMOKEBALL_API_KEY: "sbk", CANVA_ACCESS_TOKEN: "cv", FERGUS_ACCESS_TOKEN: "fg", BLUEBEAM_ACCESS_TOKEN: "bb",
  BLUEBEAM_CLIENT_ID: "bc", CLINIKO_API_KEY: "ck", CLINIKO_USER_AGENT: "Kit test", DROPBOX_ACCESS_TOKEN: "db", REAPIT_ACCESS_TOKEN: "rp",
  BUILDXACT_ACCESS_TOKEN: "bx", BUILDXACT_SUBSCRIPTION_KEY: "bxk",
};

beforeEach(async () => {
  fakeNetwork();
  for (const [k, v] of Object.entries(ENV)) process.env[k] = v;
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
  assert.equal(ids.length, 32);
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
  const a = firstOp("aroflo", (x) => x.kind === "read");
  await assert.rejects(() => callOperation("aroflo", a.id), /not wired yet/);
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
    const hostOk = (h: string) => (platform.hostFromEnv && h === process.env.WORDPRESS_SITE) || platform.hosts.includes(h) || platform.hostPatterns.some((p) => new RegExp(`^(?:${p})$`).test(h)) || /(^|\.)docusign\.net$/.test(h) && id === "docusign";
    for (const o of ops.values()) {
      const sample = (p: { pattern?: string; type: string; reserved?: boolean }) => p.reserved && p.pattern
        ? p.pattern.replace(/^\^|\$$/g, "").replace(/\[\^\/\]\+/g, "x1").replace(/\.\*|\.\+/g, "x1").replace(/\\/g, "")
        : dummy(p.type);
      const params = Object.fromEntries(o.params.filter((p) => p.required && !(platform.pinned ?? {})[p.name]).map((p) => [p.name, sample(p)]));
      const input = platform.status === "index-only" ? { document: `${o.method === "MUTATION" ? "mutation" : "query"} { ${o.path} { __typename } }` } : { params, body: o.body && o.method !== "GET" ? {} : undefined };
      hits = [];
      try {
        await callOperation(id, o.id, input);
        if (o.kind === "write") { problems.push(`${id} ${o.id}: write was not blocked`); continue; }
        const AUTH_HOSTS = new Set(["identity.xero.com", "zoom.us", "oauth2.googleapis.com", "account.docusign.com", "account-d.docusign.com"]);
        const api = hits.filter((h) => !AUTH_HOSTS.has(new URL(h.url).hostname));
        if (api.length !== 1) { problems.push(`${id} ${o.id}: ${api.length} api calls`); continue; }
        const u = new URL(api[0].url);
        if (!hostOk(u.hostname)) problems.push(`${id} ${o.id}: host ${u.hostname}`);
        if (/[{}]/.test(decodeURIComponent(u.pathname))) problems.push(`${id} ${o.id}: unfilled path ${u.pathname}`);
        reads++;
      } catch (e: any) {
        if (e instanceof WriteBlocked && o.kind === "write") { if (hits.length) problems.push(`${id} ${o.id}: write touched the network`); writes++; continue; }
        if (/not wired yet/.test(e.message) && (id === "aroflo" || o.authUnsupported)) { refused++; continue; }
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
    ["hubspot", (o) => /unsubscribe-all/.test(o.path) && o.method === "GET"],
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
