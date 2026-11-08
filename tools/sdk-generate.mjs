#!/usr/bin/env node
// Generate the agent SDK from the endpoint map. One package per platform in core/sdk/platforms/<id>/.
// Usage: node tools/sdk-generate.mjs <endpoint-map/endpoints dir>
// The endpoint map is built and verified outside this repo (official sources only, scrubbed in and out).
// This script re-checks every string it writes for secrets, emails, hidden characters and em dashes.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = process.argv[2];
if (!src || !fs.existsSync(src)) { console.error("usage: node tools/sdk-generate.mjs <endpoints dir>"); process.exit(2); }
const OUT = path.join(root, "core/sdk/platforms");

const SUB = "[a-z0-9-]+";
// Sign-in per platform. env names are what the client puts in their secret store.
// "crm" = the same sign-in our CRM runs in production; "docs" = from the vendor's docs, unproven until a sandbox run.
const P = {
  "xero": { name: "Xero", auth: { type: "custom", provider: "xero" }, keys: ["XERO_CLIENT_ID", "XERO_CLIENT_SECRET", "XERO_TENANT_ID", "XERO_REFRESH_TOKEN"], proof: "crm" },
  "zoom": { name: "Zoom", auth: { type: "custom", provider: "zoom" }, keys: ["ZOOM_ACCOUNT_ID", "ZOOM_CLIENT_ID", "ZOOM_CLIENT_SECRET"], proof: "crm",
    serverVars: { keyConnectorLb: { env: "ZOOM_KEY_CONNECTOR_HOST", pattern: "[a-z0-9-]+(\\.[a-z0-9-]+)+", envOnly: true } } },
  "google-workspace": { name: "Google Workspace", auth: { type: "custom", provider: "google" },
    pinned: { userId: { allow: ["me"], env: "GOOGLE_MAILBOX", envList: "GOOGLE_ALLOWED_MAILBOXES", fill: "me" } }, keys: ["GOOGLE_MAILBOX", "GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET"], proof: "crm" },
  "google-ads": { name: "Google Ads", defaultScope: "https://www.googleapis.com/auth/adwords", auth: { type: "custom", provider: "google", extraHeaders: { "developer-token": "GOOGLE_ADS_DEVELOPER_TOKEN" }, optionalHeaders: { "login-customer-id": "GOOGLE_ADS_LOGIN_CUSTOMER_ID" } }, keys: ["GOOGLE_MAILBOX", "GOOGLE_ADS_DEVELOPER_TOKEN", "GOOGLE_ADS_LOGIN_CUSTOMER_ID (optional)"], proof: "docs" },
  "docusign": { name: "DocuSign", auth: { type: "custom", provider: "docusign" },
    pinned: { accountId: { allow: [], env: "DOCUSIGN_ACCOUNT_ID", fill: "$env" } }, keys: ["DOCUSIGN_INTEGRATION_KEY", "DOCUSIGN_USER_ID", "DOCUSIGN_ACCOUNT_ID", "DOCUSIGN_PRIVATE_KEY", "DOCUSIGN_ENV (optional)"], proof: "crm", hostPatterns: [`${SUB}\\.docusign\\.(net|com)`] },
  "aircall": { name: "Aircall", auth: { type: "basic", user: "AIRCALL_API_ID", pass: "AIRCALL_API_TOKEN" }, keys: ["AIRCALL_API_ID", "AIRCALL_API_TOKEN"], proof: "crm" },
  "calendly": { name: "Calendly", auth: { type: "bearer", env: "CALENDLY_API_TOKEN" }, keys: ["CALENDLY_API_TOKEN"], proof: "crm" },
  "fireflies": { name: "Fireflies", style: "graphql", auth: { type: "bearer", env: "FIREFLIES_API_KEY" }, keys: ["FIREFLIES_API_KEY"], proof: "crm" },
  "telegram": { name: "Telegram Bot API", auth: { type: "path-token" }, keys: ["TELEGRAM_BOT_TOKEN"], proof: "crm", keyInPath: "/bot[^/]+",
    serverVars: { token: { env: "TELEGRAM_BOT_TOKEN", pattern: "[0-9]+:[A-Za-z0-9_-]+", secret: true, envOnly: true } } },
  "meta-ads": { name: "Meta (Marketing and Graph API)", auth: { type: "bearer", env: "META_ADS_TOKEN" }, keys: ["META_ADS_TOKEN", "META_GRAPH_VERSION (optional)"], proof: "crm",
    serverVars: { version: { env: "META_GRAPH_VERSION", default: "v21.0", pattern: "v[0-9]+\\.[0-9]+", callerMay: true } } },
  "whatsapp": { name: "WhatsApp Business Platform", auth: { type: "bearer", env: "WHATSAPP_ACCESS_TOKEN" }, keys: ["WHATSAPP_ACCESS_TOKEN"], proof: "docs" },
  "hubspot": { name: "HubSpot", auth: { type: "bearer", env: "HUBSPOT_ACCESS_TOKEN" }, keys: ["HUBSPOT_ACCESS_TOKEN"], proof: "docs" },
  "microsoft-365": { name: "Microsoft 365 (Graph)", auth: { type: "bearer", env: "M365_ACCESS_TOKEN", note: "token flow not built yet: supply a Graph access token" }, keys: ["M365_ACCESS_TOKEN"], proof: "docs" },
  "gohighlevel": { name: "GoHighLevel", auth: { type: "bearer", env: "GHL_ACCESS_TOKEN", extraHeaders: { Version: "=2021-07-28" } }, keys: ["GHL_ACCESS_TOKEN"], proof: "docs" },
  "slack": { name: "Slack", auth: { type: "bearer", env: "SLACK_BOT_TOKEN" }, keys: ["SLACK_BOT_TOKEN", "SLACK_USER_TOKEN (for methods that take only a user token)"], proof: "docs" },
  "asana": { name: "Asana", auth: { type: "bearer", env: "ASANA_ACCESS_TOKEN" }, keys: ["ASANA_ACCESS_TOKEN"], proof: "docs" },
  "klaviyo": { name: "Klaviyo", auth: { type: "header", header: "Authorization", prefix: "Klaviyo-API-Key ", env: "KLAVIYO_API_KEY" }, keys: ["KLAVIYO_API_KEY"], proof: "docs" },
  "zendesk": { name: "Zendesk", server: "https://{subdomain}.{domain}.com", auth: { type: "basic", user: "ZENDESK_EMAIL+=/token", pass: "ZENDESK_API_TOKEN" }, keys: ["ZENDESK_SUBDOMAIN", "ZENDESK_EMAIL", "ZENDESK_API_TOKEN"], proof: "docs",
    serverVars: { subdomain: { env: "ZENDESK_SUBDOMAIN", pattern: SUB }, domain: { env: "ZENDESK_DOMAIN", default: "zendesk", pattern: "zendesk" } } },
  "monday": { name: "monday.com", style: "graphql", auth: { type: "header", header: "Authorization", env: "MONDAY_API_TOKEN" }, keys: ["MONDAY_API_TOKEN"], proof: "docs" },
  "servicem8": { name: "ServiceM8", auth: { type: "header", header: "X-API-Key", env: "SERVICEM8_API_KEY" }, keys: ["SERVICEM8_API_KEY"], proof: "docs" },
  "deputy": { name: "Deputy", auth: { type: "bearer", env: "DEPUTY_ACCESS_TOKEN" }, keys: ["DEPUTY_ACCESS_TOKEN", "DEPUTY_SUBDOMAIN", "DEPUTY_REGION"], proof: "docs",
    serverVars: { subdomain: { env: "DEPUTY_SUBDOMAIN", pattern: SUB }, region: { env: "DEPUTY_REGION", pattern: "[a-z]{2,6}" }, install: { env: "DEPUTY_SUBDOMAIN", pattern: SUB }, geo: { env: "DEPUTY_REGION", pattern: "[a-z]{2,6}" } } },
  "smokeball": { name: "Smokeball", server: "https://api.smokeball.{tld}", forceServer: true,
    // The spec's servers list the US, AU and UK production hosts; the client's region picks one (staging hosts are left out).
    serverVars: { tld: { env: "SMOKEBALL_REGION_TLD", default: "com.au", pattern: "com|com\\.au|co\\.uk" } }, auth: { type: "bearer", env: "SMOKEBALL_ACCESS_TOKEN", extraHeaders: { "x-api-key": "SMOKEBALL_API_KEY" } }, keys: ["SMOKEBALL_ACCESS_TOKEN", "SMOKEBALL_API_KEY", "SMOKEBALL_REGION_TLD (optional: com.au default, com, co.uk)"], proof: "docs" },
  "canva": { name: "Canva Connect", auth: { type: "bearer", env: "CANVA_ACCESS_TOKEN" }, keys: ["CANVA_ACCESS_TOKEN"], proof: "docs" },
  "fergus": { name: "Fergus", auth: { type: "bearer", env: "FERGUS_ACCESS_TOKEN" }, keys: ["FERGUS_ACCESS_TOKEN"], proof: "docs" },
  "aroflo": { name: "AroFlo", auth: { type: "custom", provider: "aroflo" }, keys: ["AROFLO_SECRET_KEY", "AROFLO_UENCODED", "AROFLO_PENCODED", "AROFLO_ORGENCODED", "AROFLO_HOST_IP (optional)"], queryArrays: "repeat", proof: "docs", server: "https://api.aroflo.com" },
  "bluebeam": { name: "Bluebeam Studio", auth: { type: "bearer", env: "BLUEBEAM_ACCESS_TOKEN", extraHeaders: { client_id: "BLUEBEAM_CLIENT_ID" } }, keys: ["BLUEBEAM_ACCESS_TOKEN", "BLUEBEAM_CLIENT_ID"], proof: "docs",
    gaps: ["Australian Studio host not confirmed: developers.bluebeam.com renders in the browser and gives no readable host to a plain fetch (8 Nov 2026); only the US host api.bluebeam.com is mapped"] },
  "cliniko": { name: "Cliniko", server: "https://api.{shard}.cliniko.com/v1", forceServer: true, serverVars: { shard: { env: "CLINIKO_SHARD", default: "au1", pattern: "[a-z]{2}[0-9]" } }, auth: { type: "basic", user: "CLINIKO_API_KEY", passEmpty: true, extraHeaders: { "User-Agent": "CLINIKO_USER_AGENT" } }, keys: ["CLINIKO_API_KEY", "CLINIKO_USER_AGENT"], proof: "docs" },
  "dropbox": { name: "Dropbox", style: "rpc", auth: { type: "bearer", env: "DROPBOX_ACCESS_TOKEN" }, keys: ["DROPBOX_ACCESS_TOKEN"], proof: "docs" },
  "wordpress": { name: "WordPress (core REST API)", auth: { type: "basic", user: "WORDPRESS_USER", pass: "WORDPRESS_APP_PASSWORD" }, keys: ["WORDPRESS_SITE", "WORDPRESS_USER", "WORDPRESS_APP_PASSWORD"], proof: "docs",
    server: "https://{site}/wp-json", hostFromEnv: true, serverVars: { site: { env: "WORDPRESS_SITE", pattern: "[a-z0-9-]+(\\.[a-z0-9-]+)+", envOnly: true } } },
  "agentbox": { name: "AgentBox (Reapit Foundations)", auth: { type: "bearer", env: "REAPIT_ACCESS_TOKEN", extraHeaders: { "api-version": "=2020-01-31" } }, keys: ["REAPIT_ACCESS_TOKEN"], proof: "docs" },
  "buildxact": { name: "Buildxact", auth: { type: "bearer", env: "BUILDXACT_ACCESS_TOKEN", extraHeaders: { "Ocp-Apim-Subscription-Key": "BUILDXACT_SUBSCRIPTION_KEY" } }, keys: ["BUILDXACT_ACCESS_TOKEN", "BUILDXACT_SUBSCRIPTION_KEY"], proof: "docs" },
  "shopify": { name: "Shopify Admin (GraphQL)", style: "graphql", auth: { type: "header", header: "X-Shopify-Access-Token", env: "SHOPIFY_ACCESS_TOKEN" }, keys: ["SHOPIFY_SHOP", "SHOPIFY_ACCESS_TOKEN", "SHOPIFY_API_VERSION (optional)"], proof: "docs",
    serverVars: { shop: { env: "SHOPIFY_SHOP", pattern: SUB }, version: { env: "SHOPIFY_API_VERSION", default: "2026-10", pattern: "[0-9]{4}-[0-9]{2}", callerMay: true } } },
};

// Wave 3 platforms (8 Nov): their sign-in and hosts live in their own file.
import { W3 } from "./sdk-platforms-wave3.mjs";
for (const [k, v] of Object.entries(W3)) if (!P[k]) P[k] = v;
// Every key a platform reads, for platforms that do not list them by hand.
function autoKeys(cfg) {
  const names = new Set();
  const a = cfg.auth ?? {};
  for (const x of [a.env, a.user, a.pass, ...Object.values(a.extraHeaders ?? {}), ...Object.values(a.optionalHeaders ?? {})]) if (x && !String(x).startsWith("=")) for (const n of String(x).split("+")) if (/^[A-Z][A-Z0-9_]+$/.test(n)) names.add(n);
  for (const m of String(a.template ?? "").matchAll(/\{([A-Z][A-Z0-9_]+)\}/g)) names.add(m[1]);
  for (const r of cfg.opRules ?? []) if (r.auth?.env) names.add(`${r.auth.env} (for ${r.server})`);
  for (const v of Object.values(cfg.serverVars ?? {})) names.add(v.default !== undefined ? `${v.env} (optional: ${v.default || "empty"} default)` : v.env);
  return [...names];
}

const HIDDEN = /[­​-‏‪-‮⁠-⁯﻿\u{e0000}-\u{e0fff}]/u;
const SECRET = /AKIA[0-9A-Z]{16}|\bgh[pousr]_[A-Za-z0-9]{30,}|\bxox[abposr]-[A-Za-z0-9-]{10,}|\b(sk|rk)_(live|test)_[A-Za-z0-9]{16,}|\bsk-(ant-)?[A-Za-z0-9_-]{24,}|\bAIza[0-9A-Za-z_-]{35}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.|PRIVATE KEY-----/;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
const RESERVED = new Set("break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface package private protected public await".split(" "));

// Read or write. The network gate reads only GET (and mapped GraphQL queries and RPC reads). On top of that:
// - Slack and Telegram name actions rather than following HTTP, so their endpoints are reads only when the name says so.
// - Dropbox is RPC over POST: its list, get and search routes are reads (sent as read-only POSTs); the rest are writes.
// - Anything whose id, path or summary points to a credential is gated as a write on every platform, even as a GET.
// - A GET is otherwise the vendor's own statement that the call reads (HTTP's safe method). It is a write only when the
//   endpoint's OWN name is an action: the first word of its last path segment (Deputy's GET /tasks/{id}/do) or the first
//   word of the vendor's summary ("Send ...", "Creates ..."). Words elsewhere in the id or path name the resource, not
//   the call (backupRestore, AdSet, bulk-update-jobs), so they no longer make a read a write (8 Nov 2026: 1,936 GETs
//   were mislabelled that way). Every GET left as a write carries its reason in `override`, so an agent sees why.
const SLACK_READ = /^(list|info|history|replies|test)$|^(get|lookup)/;
const CREDENTIAL = /token|secret|password|passcode|private[ _-]?key|access[ _-]?keys?|recovery[ _-]?keys?|signing[ _-]?keys?|temporary[ _-]?link|signed[ _-]?url|download[ _-]?url|data[ _-]?pack|credential|verification[ _-]?codes?|auth(?:orization)?[ _-]?code|oauth|authori[sz]e|hmac|api[ _-]?keys?|presign/i;
const ACTION = /(^|[^a-z])(unsubscribe|resubscribe|resume|pause|generate|publish|revoke|upload|send|trigger|execute|restore|retry|reset|cancel|approve|reject|enable|disable|start|stop|clone|duplicate|sync|refresh|rotate|archive|unarchive|delete|create|update|mark|move|copy|import|invite|accept|decline|assign|unassign|lock|unlock|activate|deactivate|terminate|submit|confirm|verify|redeem|purge|wipe|remove|add|set|resend|finalize|finalise|void|pay|charge|refund|capture|notify|dispatch|deliver|transfer|withdraw|merge|book|checkout|subscribe|sign|authorise|authorize)(?=[^a-z]|$)/i;  // resend..authorize added 8 Nov 2026 after the security review
// A reviewed POST may be a read only if its own path says search, batch read or query.
const READPOST_PATH = /(\/search$|\/batch\/read$|\/query$|\/_search$|\/search\/|\/query_)/i;
const SECRET_HEADER = /(^|[-_])(api[-_]?key|secret|password|customer[-_]?token|proposal[-_]?token|z?csrf[-_]?token|access[-_]?token|auth[-_]?token|session[-_]?token)$/i;
const STRONG =/secret|private[ _-]?key|password|credential|verification code|hmac|signed url|presigned|temporary link|download link|upload (url|link|path)|recovery key|access key/i;  // upload links added 8 Nov 2026 (Smokeball, Trackunit)  // summaries: only clear credential words
function words(s) { return String(s).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_./{}-]+/g, " "); }
// DocuSign API families: production host (developers.docusign.com/platform/api-endpoint-base-paths) and, where the
// family's own spec names no per-endpoint scope, the scopes DocuSign lists for it (/platform/auth/reference/scopes).
// Both pages read 8 Nov 2026 through endpoint-map/model_guard.py; watcher models found them clean. Families whose specs
// carry per-endpoint scopes (Admin, Workspaces, Web Forms, Maestro, Workflow Builder, Navigator, Agreement Manager,
// Connected Fields) keep those. Click runs on the account's own server, like eSignature (rewritten at call time).
const ROOMS_READ = ["dtr.rooms.read", "dtr.documents.read", "dtr.profile.read", "dtr.company.read"];
const ROOMS_WRITE = ["dtr.rooms.write", "dtr.documents.write", "dtr.profile.write", "dtr.company.write"];
const DOCUSIGN = {
  rooms: { from: "https://demo.rooms.docusign.com/restapi", to: "https://rooms.docusign.com/restapi", scopes: (o) => (o.method === "GET" ? ROOMS_READ : ROOMS_WRITE) },
  workspaces: { from: "https://api-d.docusign.com", to: "https://api.docusign.com" },
  "connected-fields": { from: "https://api-d.docusign.com", to: "https://api.docusign.com" },
  click: { from: "https://www.demo.docusign.net/clickapi", to: "https://www.docusign.net/clickapi", scopes: () => ["click.manage"] },
  webforms: { from: "https://apps-d.docusign.com", to: "https://apps.docusign.com" },
  admin: {}, maestro: {}, workflowbuilder: {}, navigator: {}, agreementmanager: {},
  monitor: { scopes: () => ["signature", "impersonation"] },
};
// The body encoding the vendor's own spec requires, when it does not accept JSON (endpoint map body_types).
function bodyType(o) {
  if (String(o.method).toUpperCase() === "GET") return null;  // a GET sends no body, whatever a docs page lists for it
  // OAuth token and revoke endpoints take form encoding by the OAuth standard (RFC 6749 4.1.3, RFC 7009), even when
  // the spec (or an SDK-added endpoint) records no content type.
  if (o.body && !(o.body_types ?? []).length && /\/oauth2?\/(token|deauthorize|revoke)$/i.test(String(o.path))) return "form";
  const t = (o.body && Array.isArray(o.body_types)) ? o.body_types : [];
  if (!t.length || t.some((x) => x === "application/json" || x === "text/json" || x.endsWith("+json") || x === "*/*")) return null;
  if (t.includes("application/x-www-form-urlencoded")) return "form";
  if (t.includes("multipart/form-data")) return "multipart";
  return null;
}
// How each platform's own SDK writes form-encoded lists (twilio-node: qs arrayFormat "repeat"); the default is a[0]=x.
const FORM_ARRAYS = { twilio: "repeat" };
const firstWord = (s) => (words(String(s ?? "")).replace(/[^A-Za-z ]+/g, " ").trim().split(/\s+/)[0] ?? "").toLowerCase();
// The call's own name: the last path segment that is not a parameter ({id}, :id) or an OData parenthesis.
function ownName(path) {
  const segs = String(path).split("/").map((s) => s.replace(/\(.*$/, "").replace(/^\$/, "")).filter((s) => s && !/^\{.*\}$/.test(s) && !/^:/.test(s));
  return segs[segs.length - 1] ?? "";
}
const isAction = (w) => ACTION.test(w) && w.length > 0;
const READ_VERB = /^(get|gets|list|lists|retrieve|retrieves|return|returns|show|shows|read|reads|fetch|fetches|view|views|find|finds|search|searches|count|counts|lookup|describe|describes)$/;
// Returns [kind, reason]. The reason is set for every GET or QUERY that ends up a write.
function readKind(platform, o) {
  const method = String(o.method).toUpperCase();
  const name = words(`${o.id} ${o.path}`);
  const summary = String(o.summary ?? "").trim().replace(/^(\[[^\]]*\]\s*)+/, "");  // "[BETA] View ..." reads as "View ..."
  if (CREDENTIAL.test(name)) return ["write", `sensitive: its name points to a credential (${(name.match(CREDENTIAL) ?? [""])[0]})`];
  if (STRONG.test(summary)) return ["write", `sensitive: the vendor's summary mentions ${(summary.match(STRONG) ?? [""])[0]}`];
  if (platform === "dropbox") {
    const segs = String(o.path).split("/");
    const last = segs[segs.length - 1] === "continue" ? segs[segs.length - 2] : segs[segs.length - 1];  // list_folder/continue pages a read
    return /^(list|get|search|count|check)/.test(last) && !ACTION.test(words(last)) ? ["read", ""] : ["write", ""];
  }
  if (!["GET", "QUERY"].includes(method)) return ["write", ""];
  if (o.kind !== "read") return ["write", "the endpoint map labels it a write"];
  if (platform === "slack") {
    const segs = String(o.path).replace(/^\//, "").split(".");
    return segs[0] === "search" || SLACK_READ.test(segs[segs.length - 1]) ? ["read", ""] : ["write", "a Slack method whose name is not a read"];
  }
  if (platform === "telegram") return /^\/?get[A-Z]/.test(String(o.path)) && !/^\/?getUpdates$/.test(String(o.path)) ? ["read", ""] : ["write", "a Telegram method whose name is not a read"];
  const own = firstWord(ownName(o.path));
  const sw = firstWord(summary);
  // A compound name can start with an action word and still name a thing (a term "set", sync_status, refreshSchedule);
  // the vendor's own summary decides: "Get set from groups" reads. OData functions ("Invoke function ...") may not
  // have side effects under the OData standard, so they read too.
  const summaryReads = READ_VERB.test(sw) || /^invoke function\b/i.test(summary);
  // A GraphQL query cannot change data (mutations are separate), so only the credential checks above apply to it.
  if (method === "QUERY") return ["read", ""];
  if ((isAction(own) || own === "do" || own === "run") && !summaryReads) return ["write", `its own name is an action (${own})`];
  if (isAction(sw) || isAction(sw.replace(/s$/, ""))) return ["write", `the vendor's summary starts with an action (${sw})`];
  return ["read", ""];
}

function clean(s) { return String(s ?? "").replace(/\u2014/g, ", ").replace(/\s+/g, " ").trim(); }
function camel(id) {
  const parts = String(id).split(/[^A-Za-z0-9]+/).filter(Boolean);
  let n = parts.map((p, i) => (i ? p[0].toUpperCase() + p.slice(1) : p[0].toLowerCase() + p.slice(1))).join("") || "op";
  if (/^[0-9]/.test(n)) n = "op" + n;
  return RESERVED.has(n) ? n + "Op" : n;
}
function tsType(t) {
  const s = String(t || "").toLowerCase();
  if (/^(integer|int|number|float|double|int32|int64)/.test(s) || s === "int!" || s === "float!") return "number";
  if (/^bool/.test(s)) return "boolean";
  if (/^(array|\[)/.test(s)) return "unknown[]";
  if (/^(string|id|date|uri|email|uuid)/.test(s)) return "string";
  return "unknown";
}
function hostRules(servers, vars) {
  const hosts = new Set(), patterns = new Set();
  for (const s of servers) {
    let u = s.replace(/:443(?=\/|$)/, "");
    const host = u.replace(/^https:\/\//, "").split("/")[0];
    if (!host) continue;
    if (!host.includes("{")) hosts.add(host);
    else patterns.add(host.replace(/\./g, "\\.").replace(/\{([A-Za-z_][A-Za-z0-9_-]*)\}/g, (_, n) => `(?:${vars?.[n]?.pattern ?? SUB})`));
  }
  return { hosts: [...hosts].sort(), patterns: [...patterns].sort() };
}

// Reviewed per-endpoint corrections from the assessment workers (endpoint-map/assess_merge.py).
const OVERRIDES = fs.existsSync(path.join(root, "tools/sdk-overrides.json")) ? JSON.parse(fs.readFileSync(path.join(root, "tools/sdk-overrides.json"), "utf8")) : {};

fs.mkdirSync(OUT, { recursive: true });
const summary = [];
for (const file of fs.readdirSync(src).filter((f) => f.endsWith(".json")).sort()) {
  const m = JSON.parse(fs.readFileSync(path.join(src, file), "utf8"));
  const id = m.connector;
  if (!m.operations.length) { summary.push({ id, ops: 0, status: m.status, note: "nothing public to map" }); continue; }
  const cfg = P[id];
  if (!cfg) { console.error(`no SDK config for ${id}; add it to tools/sdk-generate.mjs`); process.exit(1); }
  const apis = [...new Set(m.operations.map((o) => o.api))];
  const cleanApi = (api) => {
    let x = String(api);
    const mk = x.match(/_(?:master|main|HEAD|latest)_(.+)$/);
    if (mk) x = mk[1];
    else if (/\.(com|dev|io|ai|org|net)_/.test(x)) {
      // A generic file name (Zendesk's <product>/oas.yaml) takes its name from the folder, so files never share an api name.
      const g = x.replace(/^.*?\.(com|dev|io|ai|org|net)_/, "").match(/^(.+)_(oas|openapi|swagger|spec)\.(ya?ml|json)$/i);
      x = g ? (g[1].toLowerCase() === id ? "core" : g[1]) : x.split("_").pop();
    }
    x = x.replace(/\.(ya?ml|json)$/i, "");
    x = x.replace(new RegExp(`^(${id.split("-")[0]})[-_]`, "i"), "");
    if (/\.rest\.|swagger/.test(x)) x = x.split(".")[0];
    x = x.replace(/^api-reference-?/, "") || "core";
    return x.replace(/[^A-Za-z0-9_-]+/g, "-");
  };
  const ops = m.operations.map((o) => {
    const oldApi = String(o.api);
    const bare = String(o.id).startsWith(oldApi + ".") ? String(o.id).slice(oldApi.length + 1) : String(o.id);
    o = { ...o, api: apis.length > 1 ? cleanApi(oldApi) : "", id: apis.length > 1 ? `${cleanApi(oldApi)}.${bare}` : bare };
    let server = cfg.server && (cfg.forceServer || !o.server || /^https:\/\/\s/.test(o.server) || o.server === "") ? cfg.server : (o.server || cfg.server || "");
    for (const [from, to] of Object.entries(cfg.rewrite ?? {})) if (server.startsWith(from)) server = to + server.slice(from.length);
    server = server.replace(/:443(?=\/|$)/, "");
    // Headers the sign-in layer supplies are never caller inputs (several specs list them as required params).
    const authHeaders = new Set(["authorization", "cookie", "x-api-key", "x-shopify-access-token", "xero-tenant-id",
      ...Object.keys(cfg.auth.extraHeaders ?? {}), ...Object.keys(cfg.auth.optionalHeaders ?? {}),
      ...(cfg.auth.header ? [cfg.auth.header] : []), ...(cfg.opRules ?? []).map((r) => r.auth?.header).filter(Boolean)].map((h) => h.toLowerCase()));
    // Keys never travel in a URL: query params that are keys (Slack's old token param, Meta's access_token) are dropped;
    // the sign-in layer sends the key in a header instead.
    const keyLike = (n) => ["token", "accesstoken", "apikey", "key", "secret", "clientsecret", "password"].includes(String(n).toLowerCase().replace(/[^a-z]/g, ""));
    // A header the vendor's spec lists as an input but that carries a credential (SiteMinder's x-sm-api-key, Yotpo's
    // X-Customer-Token, Zoho's CSRF token) is never a caller input: dropped here, and the endpoint is refused below
    // unless the platform's sign-in supplies that header.
    const secretHeader = (p) => String(p.in).toLowerCase() === "header" && !authHeaders.has(String(p.name).toLowerCase())
      && SECRET_HEADER.test(String(p.name));
    const dropped = (o.params ?? []).filter((p) => p && p.name && secretHeader(p)).map((p) => String(p.name));
    const params = (o.params ?? []).filter((p) => p && p.name && !(String(p.in).toLowerCase() === "header" && authHeaders.has(String(p.name).toLowerCase()))
      && !(["query", "header"].includes(String(p.in).toLowerCase()) && keyLike(p.name)) && !secretHeader(p))
      .map((p) => ({ name: clean(p.name), in: clean(p.in), required: String(p.in) === "path" ? true : !!p.required, type: clean(p.type), ...(p.reserved ? { reserved: true, pattern: String(p.pattern ?? "") } : {}) }));
    const have = new Set(params.map((p) => p.name));
    for (const mm of String(o.path).matchAll(/\{([^}]+)\}/g)) if (!have.has(mm[1])) { params.push({ name: mm[1], in: "path", required: true, type: "string" }); have.add(mm[1]); }
    return { id: clean(o.id), api: clean(o.api), method: clean(o.method).toUpperCase(), path: clean(o.path), server, summary: clean(o.summary).slice(0, 200),
             tags: (o.tags ?? []).map(clean), params, body: !!o.body, scopes: o.scopes ?? [], deprecated: !!o.deprecated, doc_url: clean(o.doc_url),
             ...(o.paramsUnmapped ? { paramsUnmapped: true } : {}), ...(dropped.length ? { secretHeaders: dropped } : {}), ...(bodyType(o) ? { bodyType: bodyType(o) } : {}), ...(Array.isArray(o.tokens) ? { tokens: o.tokens.map(clean) } : {}),
             ...(() => { const [kind, why] = readKind(id, o); return why ? { kind, override: `write: ${why}` } : { kind }; })() };
  });
  // Endpoints that must not carry the platform key, or whose sign-in is not mapped yet.
  // Dropbox routes its own spec marks host="content"/"notify" or style upload/download (endpoint-map/raw/dropbox/spec/*.stone).
  const DROPBOX_SPECIAL = new Set(["/account/get_photo", "/files/download", "/files/download_zip", "/files/export", "/files/list_folder/longpoll",
    "/files/paper/create", "/files/paper/update", "/files/get_preview", "/files/get_thumbnail", "/files/get_thumbnail_batch", "/files/get_thumbnail_v2",
    "/files/upload", "/files/upload_session/start", "/files/upload_session/append", "/files/upload_session/append_v2", "/files/upload_session/append_batch",
    "/files/upload_session/finish", "/files/alpha/upload", "/paper/docs/download", "/paper/docs/create", "/paper/docs/update",
    "/riviera/download_transform_output", "/sharing/get_shared_link_file"]);
  for (const o of ops) {
    if (id === "dropbox" && DROPBOX_SPECIAL.has(o.path))
      o.authUnsupported = "Dropbox content or notify route: needs content.dropboxapi.com or notify.dropboxapi.com and the Dropbox-API-Arg header; not wired yet";
    if (id === "servicem8" && (o.api === "addon-sdk-api" || /AddonDiary/i.test(o.id)))
      o.authUnsupported = "ServiceM8 add-on route: needs an OAuth add-on token, not the API key; not wired yet";
    // Slack lists the token types each method takes: user-only methods sign in with the user token, and methods that
    // take only an app configuration token are refused until that sign-in is mapped.
    if (id === "slack" && o.tokens?.includes("user") && !o.tokens.includes("bot")) o.tokenEnv = "SLACK_USER_TOKEN";
    if (id === "slack" && o.tokens?.length && o.tokens.every((t) => t === "configuration"))
      o.authUnsupported = "Slack app configuration method: needs an app configuration token, not the bot or user token; not wired yet";
    // Klaviyo profile reads can include raw device push tokens; the kit never asks for them.
    if (id === "klaviyo") {
      o.params = o.params.filter((p) => p.name !== "fields[push-token]");
      for (const p of o.params) if (p.name === "include") p.deny = "push[-_ ]?token";
    }
    // A placeholder host from a spec's example (api.your-ota.com, example.com) is never called or allowlisted.
    if (/(^|[.\/])(your[-_.]|example\.(com|org|net)\b|placeholder|sample)/i.test(o.server.replace(/\{[^}]*\}/g, "")))
      o.authUnsupported = "the published spec names a placeholder host for this endpoint";
    // A published server that is not a public https host (a vendor's localhost or dev box) is never called.
    if (!/^https:\/\/[^/\s]+/i.test(o.server) || /^https:\/\/(localhost|127\.|0\.0\.0\.0|\[|10\.|192\.168\.|[^/]*\.local(\/|:|$))/i.test(o.server))
      o.authUnsupported = "the published spec names no public production host for this endpoint";
    for (const r of cfg.opRules ?? []) {  // a different sign-in, or a refusal, for endpoints on one server
      if (!o.server.startsWith(r.server)) continue;
      if (r.unsupported) o.authUnsupported = r.unsupported;
      if (r.auth) o.auth = r.auth;
    }
    if (o.secretHeaders) {
      const a = o.auth ?? cfg.auth;
      const supplied = new Set([a.header, ...Object.keys(a.extraHeaders ?? {}), ...Object.keys(a.optionalHeaders ?? {})].filter(Boolean).map((h) => h.toLowerCase()));
      const missing = o.secretHeaders.filter((h) => !supplied.has(h.toLowerCase()));
      if (missing.length && !o.authUnsupported) o.authUnsupported = `needs ${missing.join(", ")} from the secret store, which this platform's sign-in does not map yet`;
      delete o.secretHeaders;
    }
    if (id === "zoom" && o.server.includes("{keyConnectorLb}"))
      o.authUnsupported = "Zoom customer-managed key route: runs on the client's own key connector and decrypts key material; never called by the kit";
    if (id === "microsoft-365" && o.path.includes("/$count")) o.fixedHeaders = { ConsistencyLevel: "eventual" };  // Graph needs it for $count
    if (id === "gohighlevel" && /^(v3__|index-v3)/.test(o.api)) o.fixedHeaders = { Version: "v3" };  // v3 endpoints need their version header
    if (id === "klaviyo" && o.path.startsWith("/client/")) o.noAuth = true;  // public client API: company_id, never the private key
    if (id === "docusign" && !["esignature", "sdk"].includes(o.api)) {
      const f = DOCUSIGN[o.api];
      if (!f) o.authUnsupported = `DocuSign ${o.api}: its production host and scopes are not mapped yet`;
      else {
        if (f.from && o.server.startsWith(f.from)) o.server = f.to + o.server.slice(f.from.length);
        if (!(o.scopes ?? []).length && f.scopes) o.scopes = f.scopes(o);
      }
    }
  }
  if (id === "aroflo") {
    const zf = path.join(src, "..", "aroflo-zones.json");
    const zones = fs.existsSync(zf) ? JSON.parse(fs.readFileSync(zf, "utf8")) : [];
    const byName = new Map(zones.map((z) => [`${z.method} ${z.name}`, z]));
    for (const o of ops) {
      const z = byName.get(`${o.method} ${o.summary}`);
      if (!z?.zone) { o.authUnsupported = "AroFlo example with no zone in the official collection"; continue; }
      o.path = "/";
      delete o.paramsUnmapped;
      if (o.method === "GET") {
        o.fixedQuery = { zone: z.zone };
        o.params = ["where", "join", "order", "page", "pageSize"].map((n) => ({ name: n, in: "query", required: false, type: n === "where" ? "string or list (repeats where=)" : "string" }));
      } else {
        o.fixedForm = { zone: z.zone };
        o.params = [{ name: "postxml", in: "formData", required: true, type: "string (XML)" }];
        o.body = true; o.bodyType = "form";
      }
    }
  }
  // A path the docs give with unbalanced placeholders ("/entity{Entity}EditHistory/{comma-separated") cannot be filled.
  for (const o of ops) {
    const p = String(o.path);
    if ((p.match(/\{/g) ?? []).length !== (p.match(/\}/g) ?? []).length && !o.authUnsupported)
      o.authUnsupported = "the vendor's docs give a malformed path for this endpoint; not callable until its inputs are mapped";
  }
  // Overrides are keyed by the endpoint id the assessment saw. The api prefix on an id comes and goes as a platform
  // gains or loses spec files, so a key matches the full id or the bare id (api prefix removed), and must match exactly one.
  const ov = OVERRIDES[id] ?? {};
  const bareId = (o) => (o.api && o.id.startsWith(o.api + ".") ? o.id.slice(o.api.length + 1) : o.id);
  const resolve = (kind) => {
    const hit = new Map();
    for (const [k, why] of Object.entries(ov[kind] ?? {})) {
      const pre = k.split(".")[0];
      const kb = k.includes(".") && (pre === "core" || ops.some((o) => o.api === pre)) ? k.slice(pre.length + 1) : k;
      let m = ops.filter((o) => o.id === k);
      if (!m.length) m = ops.filter((o) => bareId(o) === k || bareId(o) === kb);
      if (m.length > 1) { console.error(`${id}: override ${kind} "${k}" matches ${m.length} endpoints`); process.exit(1); }
      if (!m.length) {
        // A gate that matches nothing is a gate silently not applied: fail. A stale drop or read-only POST is only noted.
        if (kind === "forceWrite") { console.error(`${id}: forceWrite override "${k}" matches no endpoint`); process.exit(1); }
        console.warn(`${id}: ${kind} override "${k}" matches no endpoint (ignored)`);
        continue;
      }
      hit.set(m[0], why);
    }
    return hit;
  };
  const drops = resolve("drop");
  for (let i = ops.length - 1; i >= 0; i--) if (drops.has(ops[i])) ops.splice(i, 1);
  const gates = resolve("forceWrite"), readPosts = resolve("readPost");
  for (const o of ops) {
    if (gates.has(o)) { o.kind = "write"; o.override = `gated: ${clean(gates.get(o))}`; }
    else if (readPosts.has(o) && o.method === "POST" && READPOST_PATH.test(o.path) && !CREDENTIAL.test(words(`${o.id} ${o.path}`))) { o.kind = "read"; o.readPost = true; o.override = `read-only POST: ${clean(readPosts.get(o))}`; }
  }
  const seenIds = new Map();
  for (const o of ops) {  // every id unique, so no endpoint is shadowed
    const n = seenIds.get(o.id) ?? 0;
    seenIds.set(o.id, n + 1);
    if (n) o.id = `${o.id}.${o.method.toLowerCase()}${n > 1 ? n : ""}`;
  }
  if (new Set(ops.map((o) => o.id)).size !== ops.length) { console.error(`${id}: duplicate operation ids remain`); process.exit(1); }
  const servers = [...new Set(ops.map((o) => o.server))];
  const vars = { ...(cfg.serverVars ?? {}) };
  for (const s of servers) for (const mm of s.matchAll(/\{([A-Za-z_][A-Za-z0-9_-]*)\}/g)) if (!vars[mm[1]]) { console.error(`${id}: server variable ${mm[1]} has no config`); process.exit(1); }
  // Only routes the kit can call add to the host allowlist; a refused route's host (a client's own server) never does.
  const { hosts, patterns } = hostRules([...new Set(ops.filter((o) => !o.authUnsupported).map((o) => o.server))], vars);
  // A host rule never holds an unfilled variable: a broken host would match its own broken rule.
  if ([...hosts, ...patterns].some((h) => /[{}]/.test(h.replace(/\{\d+(,\d*)?\}/g, "")))) { console.error(`${id}: a host rule still holds a variable: ${[...hosts, ...patterns].join(" ")}`); process.exit(1); }
  const platform = {
    id, name: cfg.name, status: m.status, tested: "offline only (fake network); not yet run against a real account",
    authProof: cfg.proof, style: cfg.style ?? "rest", hosts: cfg.hostFromEnv ? [] : hosts, hostFromEnv: !!cfg.hostFromEnv,
    hostPatterns: cfg.hostFromEnv ? [] : [...new Set([...patterns, ...(cfg.hostPatterns ?? [])])],
    pinned: cfg.pinned ?? {}, defaultScope: cfg.defaultScope, ...(FORM_ARRAYS[id] ? { formArrays: FORM_ARRAYS[id] } : {}), ...(cfg.queryArrays ? { queryArrays: cfg.queryArrays } : {}),
    serverVars: vars, auth: cfg.auth, keys: cfg.keys ?? autoKeys(cfg), keyInPath: cfg.keyInPath,
    sources: m.sources.map((s) => ({ url: s.url, official: s.official })), gaps: [...(m.gaps ?? []), ...(cfg.gaps ?? [])],
    counts: { operations: ops.length, read: ops.filter((o) => o.kind === "read").length, write: ops.filter((o) => o.kind === "write").length },
  };
  // index.ts: one named function per endpoint
  const used = new Set(["sdk"]);
  const lines = [
    `// Generated by tools/sdk-generate.mjs from the endpoint map. Do not edit by hand.`,
    `// ${cfg.name}: ${ops.length} endpoints (${platform.counts.read} read, ${platform.counts.write} write). Source status: ${m.status}. Sign-in: ${cfg.proof === "crm" ? "same as our CRM" : "from vendor docs, unproven"}.`,
    `import { platform, type CallInput } from "../../call.ts";`,
    `export const sdk = platform(${JSON.stringify(id)});`,
  ];
  for (const o of ops) {
    let n = camel(o.id);
    for (let i = 2; used.has(n); i++) n = camel(o.id) + i;
    used.add(n);
    const fields = o.params.map((p) => `${JSON.stringify(p.name)}${p.required ? "" : "?"}: ${tsType(p.type)}`).join("; ");
    const doc = `${o.method} ${o.path}: ${o.summary || o.id}`.replace(/\*\//g, "* /");
    lines.push(`/** ${doc} [${o.kind}] */`);
    lines.push(`export const ${n} = (input: CallInput & { params?: { ${fields} } } = {}) => sdk.call(${JSON.stringify(o.id)}, input);`);
  }
  const dir = path.join(OUT, id);
  fs.mkdirSync(dir, { recursive: true });
  const outs = { "platform.json": JSON.stringify(platform, null, 1) + "\n", "ops.json": JSON.stringify(ops) + "\n", "index.ts": lines.join("\n") + "\n" };
  for (const [f, text] of Object.entries(outs)) {
    if (HIDDEN.test(text) || SECRET.test(text) || EMAIL.test(text) || text.includes("\u2014")) { console.error(`${id}/${f}: output check failed`); process.exit(1); }
    fs.writeFileSync(path.join(dir, f), text);
  }
  summary.push({ id, ops: ops.length, status: m.status, auth: cfg.proof });
}
fs.writeFileSync(path.join(OUT, "index.json"), JSON.stringify({ generated: new Date().toISOString().slice(0, 10), platforms: summary }, null, 1) + "\n");
const total = summary.reduce((a, s) => a + s.ops, 0);
console.log(`${summary.filter((s) => s.ops).length} platforms, ${total} endpoints; nothing public for: ${summary.filter((s) => !s.ops).map((s) => s.id).join(", ")}`);
