// The agent SDK runtime: one gated way to call ANY mapped endpoint of ANY platform.
//
// Each platform lives in core/sdk/platforms/<id>/ as two generated files:
//   platform.json  hosts, server variables, auth, keys, sources and status
//   ops.json       every endpoint from the vendor's official spec or docs: id, method, path, params, read/write
// and a generated index.ts of named functions that call through here.
//
// Rules, all enforced below or in core/lib/http.ts:
// - Every request goes through call() in core/lib/http.ts: https only, the platform's own hosts only,
//   no keys in URLs, no redirects, status-only errors, redacted logs.
// - Anything that is not a read needs KIT_ALLOW_WRITES=1, checked before a socket opens.
// - Keys come only from the client's secret store (environment or token store), by the names in
//   platform.json. A caller cannot pass Authorization, Cookie or Host as a parameter.
// - Inputs are checked against the mapped params: unknown names and missing required ones fail
//   before any network call. Path values are encoded and may not contain "..".
// - GraphQL: a query is a read; a mutation is a write. A caller-supplied document must be a single
//   operation of the expected type, so a read can never carry a mutation.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { call as httpCall, writesAllowed, WriteBlocked, type AppSpec, type Method, type Reply } from "../lib/http.ts";
import { secret, optional } from "../lib/secrets.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "platforms");

export interface Param { name: string; in: string; required: boolean; type: string; /** may hold "/" (Google resource names) */ reserved?: boolean; /** the vendor's pattern a reserved value must match */ pattern?: string; /** values the vendor accepts that the kit refuses (Klaviyo push tokens) */ deny?: string }
export interface Op {
  id: string; api: string; method: string; path: string; server: string; summary: string; tags: string[];
  params: Param[]; body: boolean; scopes: string[]; deprecated: boolean; doc_url: string; kind: "read" | "write";
  /** Known by name only (from the vendor's SDK); inputs go to the query for a read and the body for a write. */
  paramsUnmapped?: boolean;
  /** A POST that only reads (a search or batch read), confirmed by review; sent as a read-only POST. */
  readPost?: boolean;
  override?: string;
  /** Sends no key at all (public client endpoints). */
  noAuth?: boolean;
  /** Refused until its sign-in is mapped; the reason says why. */
  authUnsupported?: string;
  /** Headers the vendor requires on this endpoint (Graph's ConsistencyLevel for $count). */
  fixedHeaders?: Record<string, string>;
  /** Signs in with this key instead of the platform's (Slack methods that take only a user token). Set by the generator, never by a caller. */
  tokenEnv?: string;
  /** A different sign-in for this endpoint (SendGrid inside Twilio). Set by the generator, never by a caller. */
  auth?: Auth;
}
export interface Auth {
  type: "bearer" | "basic" | "header" | "path-token" | "custom" | "unsupported" | "template";
  /** template: the header value with {ENV_NAME} placeholders, each filled from the secret store (Trello, JustCall). */
  template?: string;
  env?: string; user?: string; pass?: string; passEmpty?: boolean; header?: string; prefix?: string;
  provider?: string; extraHeaders?: Record<string, string>; optionalHeaders?: Record<string, string>; note?: string;
}
export interface Platform {
  id: string; name: string; status: string; style: "rest" | "graphql" | "rpc"; hosts: string[]; hostPatterns: string[];
  serverVars: Record<string, { env: string; default?: string; pattern: string; secret?: boolean; envOnly?: boolean; callerMay?: boolean }>; auth: Auth; keys: string[];
  keyInPath?: string; sources: { url: string; official: string }[]; gaps: string[]; counts: Record<string, number>;
  /** The host is exactly the one in the secret store (WordPress): nothing else is allowed. */
  hostFromEnv?: boolean;
  /** Params whose value must be the client's own (a mailbox, an account). Filled automatically when left out. */
  pinned?: Record<string, { allow: string[]; env: string; envList?: string; fill?: string }>;
  defaultScope?: string;
}
export interface CallInput {
  /** Values for the endpoint's mapped params, by name. Each goes where the spec says (path, query, header, body). */
  params?: Record<string, unknown>;
  /** The request body, for endpoints that take one. Merged with any body-located params. */
  body?: unknown;
  /** Values for server variables a caller may set (API versions only); tenants come from the secret store. */
  server?: Record<string, string>;
  /** GraphQL: fields to select from the result, for example "id name". */
  select?: string;
  /** GraphQL index-only platforms (Shopify): the full document to send, checked against the operation. */
  document?: string;
  /** Google: the mailbox to act as (defaults to GOOGLE_MAILBOX). */
  as?: string;
  binary?: boolean;
  signal?: AbortSignal;
}
export interface Planned { method: Method; url: string; headers: Record<string, string>; json?: unknown; form?: Record<string, string>; kind: "read" | "write"; readPost: boolean }

const cache = new Map<string, { platform: Platform; ops: Map<string, Op> }>();
const SAFE_ID = /^[a-z0-9][a-z0-9-]*$/;

export function listPlatforms(): string[] {
  return fs.readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory() && fs.existsSync(path.join(ROOT, d.name, "platform.json"))).map((d) => d.name).sort();
}

export function load(id: string): { platform: Platform; ops: Map<string, Op> } {
  if (!SAFE_ID.test(id)) throw new Error(`bad platform id: ${id}`);
  const hit = cache.get(id);
  if (hit) return hit;
  const dir = path.join(ROOT, id);
  const platform = JSON.parse(fs.readFileSync(path.join(dir, "platform.json"), "utf8")) as Platform;
  const list = JSON.parse(fs.readFileSync(path.join(dir, "ops.json"), "utf8")) as Op[];
  const v = { platform, ops: new Map(list.map((o) => [o.id, o])) };
  cache.set(id, v);
  return v;
}

/** Find endpoints by words in their id, summary, path or tags. Agents use this to pick the call. */
export function search(id: string, query: string, limit = 15): Op[] {
  const words = query.toLowerCase().split(/\W+/).filter(Boolean);
  const scored: [number, Op][] = [];
  for (const o of load(id).ops.values()) {
    const hay = `${o.id} ${o.summary} ${o.path} ${o.tags.join(" ")}`.toLowerCase();
    let s = 0;
    for (const w of words) if (hay.includes(w)) s += o.id.toLowerCase().includes(w) ? 3 : o.path.toLowerCase().includes(w) ? 2 : 1;
    if (s) scored.push([s - (o.deprecated ? 1 : 0), o]);
  }
  return scored.sort((a, b) => b[0] - a[0]).slice(0, limit).map((x) => x[1]);
}

export function describe(id: string, opId: string): Op {
  const o = load(id).ops.get(opId);
  if (!o) throw new Error(`${id}: no operation ${opId}. Use search() to find one.`);
  return o;
}

const FORBIDDEN_HEADERS = /^(authorization|cookie|host|proxy-authorization|x-api-key|x-shopify-access-token)$/i;

function serverUrl(p: Platform, o: Op, input: CallInput, withKeys = true): string {
  let s = o.server.replace(/:443(?=\/|$)/, "");
  s = s.replace(/\{([A-Za-z_][A-Za-z0-9_-]*)\}/g, (_, name: string) => {
    const v = p.serverVars[name];
    if (!v) throw new Error(`${p.id}: server variable ${name} is not configured`);
    // Tenant-like variables (subdomain, shop, site, token) come only from the secret store, so a caller can never
    // send the client's key to another tenant. A caller may set only variables marked callerMay (API versions).
    const val = (v.callerMay ? input.server?.[name] : undefined) ?? optional(v.env) ?? v.default;
    if (!val && !withKeys) return `${name.toLowerCase()}-not-set`; // preview only; a real call needs the value
    if (!val) throw new Error(`${p.id}: set ${v.env} (server variable ${name})`);
    if (!new RegExp(`^(?:${v.pattern})$`).test(val)) throw new Error(`${p.id}: ${v.env} has an unexpected value`);
    return v.secret && !withKeys ? "REDACTED" : val;
  });
  return s.replace(/\/+$/, "");
}

function encodePathValue(name: string, v: unknown, reserved = false, pattern = ""): string {
  const s = String(v);
  if (s === "" || s.split(/[\\/]/).some((seg) => seg === ".." || seg === ".")) throw new Error(`path value for ${name} is not allowed`);
  if (!reserved) return encodeURIComponent(s);
  // A value that may hold "/" must match the vendor's own pattern for it, so it can never point at another endpoint.
  let rx: RegExp | null = null;
  try { rx = pattern ? new RegExp(pattern) : null; } catch { rx = null; }
  if (!rx || !pattern.startsWith("^") || !pattern.endsWith("$") || !rx.test(s)) throw new Error(`path value for ${name} does not match its pattern`);
  // A resource name such as customers/1/campaigns/2: keep its slashes, encode each segment, no empty segments.
  const segs = s.split("/");
  if (segs.some((seg) => seg === "" || /\\/.test(seg))) throw new Error(`path value for ${name} is not allowed`);
  return segs.map(encodeURIComponent).join("/");
}

function gqlType(t: string): string {
  const s = t.trim();
  if (/^[\[\]A-Za-z0-9_!]+$/.test(s) && /[A-Z!\[]/.test(s[0] + s)) return s; // already a GraphQL type
  const base = (x: string) => ({ string: "String", integer: "Int", int: "Int", number: "Float", float: "Float", boolean: "Boolean", id: "ID" } as Record<string, string>)[x.toLowerCase()] ?? x.replace(/[^A-Za-z0-9_]/g, "");
  const arr = s.match(/^array of (.+)$/i);
  return arr ? `[${base(arr[1])}]` : base(s);
}

const GQL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SELECT_OK = /^[A-Za-z0-9_\s{}():,"$.\-]*$/;

/** Split a GraphQL document into tokens the way a GraphQL server does: strings and block strings first,
 *  then comments, commas as whitespace. Anything that is not valid GraphQL lexically is refused. */
export function gqlTokens(doc: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < doc.length) {
    const c = doc[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "," || c === "\ufeff") { i++; continue; }
    if (c === "#") { while (i < doc.length && doc[i] !== "\n" && doc[i] !== "\r") i++; continue; }
    if (doc.startsWith('"""', i)) {
      let j = i + 3;
      while (j < doc.length && !(doc.startsWith('"""', j) && doc[j - 1] !== "\\")) j++;
      if (j >= doc.length) throw new Error("unterminated block string in the GraphQL document");
      out.push('"str"'); i = j + 3; continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < doc.length && doc[j] !== '"') { if (doc[j] === "\n" || doc[j] === "\r") throw new Error("line break inside a GraphQL string"); j += doc[j] === "\\" ? 2 : 1; }
      if (j >= doc.length) throw new Error("unterminated string in the GraphQL document");
      out.push('"str"'); i = j + 1; continue;
    }
    if (doc.startsWith("...", i)) { out.push("..."); i += 3; continue; }
    if ("!$&()-:=@[]{}|".includes(c) && c !== "-") { out.push(c); i++; continue; }
    const m = /^(?:[_A-Za-z][_0-9A-Za-z]*|-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(doc.slice(i, i + 256));
    if (!m) throw new Error(`unexpected character in the GraphQL document at ${i}`);
    out.push(m[0]); i += m[0].length;
  }
  return out;
}

/** A GraphQL document must hold exactly one operation, of the expected type (fragments allowed). */
export function checkDocument(doc: string, kind: "query" | "mutation", field?: string): void {
  const t = gqlTokens(doc);
  const types: string[] = [];
  let depth = 0, paren = 0, inDef = false;
  for (const tok of t) {
    if (!inDef) {  // top level: only a definition may start here
      if (tok === "{") { types.push("query"); inDef = true; depth = 1; continue; }
      if (tok === "query" || tok === "mutation" || tok === "subscription") { types.push(tok); inDef = true; continue; }
      if (tok === "fragment") { inDef = true; continue; }
      throw new Error(`unexpected ${tok} at the top level of the GraphQL document`);
    }
    if (tok === "(") paren++;
    else if (tok === ")") paren--;
    else if (tok === "{") depth++;
    else if (tok === "}") { depth--; if (depth === 0 && paren === 0) inDef = false; }
    if (depth < 0 || paren < 0) throw new Error("unbalanced GraphQL document");
  }
  if (inDef || depth !== 0 || paren !== 0) throw new Error("unbalanced GraphQL document");
  if (types.length !== 1) throw new Error("the GraphQL document must hold exactly one operation");
  if (types[0] !== kind) throw new Error(`this operation is a ${kind}; the document is a ${types[0]}`);
  if (field && !t.includes(field)) throw new Error(`the document does not use ${field}`);
}

/** What a preview shows instead of keys: where each sign-in header would come from. Reads no secret. */
function authPreview(p: Platform, o?: Op): Record<string, string> {
  if (o?.noAuth) return {};
  const a = o?.auth ?? p.auth;
  const h: Record<string, string> = {};
  for (const [k, env] of Object.entries(a.extraHeaders ?? {})) h[k] = env.startsWith("=") ? env.slice(1) : `[from ${env}]`;
  for (const [k, env] of Object.entries(a.optionalHeaders ?? {})) h[k] = `[from ${env}, if set]`;
  if (a.type === "bearer" || a.type === "basic") h.Authorization = `[from ${(a.type === "bearer" && o?.tokenEnv) || a.env || [a.user, a.pass].filter(Boolean).join(" + ")}]`;
  if (a.type === "header") h[a.header!] = `[from ${a.env}]`;
  if (a.type === "custom") h.Authorization = `[from the ${a.provider} sign-in]`;
  if (a.type === "template") h[a.header!] = `[from ${[...String(a.template).matchAll(/\{([A-Z][A-Z0-9_]+)\}/g)].map((m) => m[1]).join(" + ")}]`;
  return h;
}

async function authHeaders(p: Platform, o: Op, input: CallInput, base: { url: string }): Promise<Record<string, string>> {
  if (o.authUnsupported) throw new Error(`${p.id}: calls are not wired yet (${o.authUnsupported})`);
  if (o.noAuth) return {};
  const a = o.auth ?? p.auth;
  const h: Record<string, string> = {};
  for (const [k, env] of Object.entries(a.extraHeaders ?? {})) h[k] = env.startsWith("=") ? env.slice(1) : secret(env);
  for (const [k, env] of Object.entries(a.optionalHeaders ?? {})) { const v = optional(env); if (v) h[k] = v; }
  switch (a.type) {
    case "bearer": h.Authorization = `Bearer ${secret(o.tokenEnv ?? a.env!)}`; break;
    case "header": h[a.header!] = `${a.prefix ?? ""}${secret(a.env!)}`; break;
    case "basic": {
      const user = a.user!.split("+").map((part) => (part.startsWith("=") ? part.slice(1) : secret(part))).join("");
      const pass = a.passEmpty ? "" : secret(a.pass!);
      h.Authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
      break;
    }
    case "path-token": break; // filled into the server URL; logs redact it
    case "template": h[a.header!] = String(a.template).replace(/\{([A-Z][A-Z0-9_]+)\}/g, (_, n: string) => secret(n)); break;
    case "custom": Object.assign(h, await customAuth(a.provider!, p, o, input, base)); break;
    case "unsupported": throw new Error(`${p.id}: calls are not wired yet (${a.note ?? "auth not supported"})`);
  }
  return h;
}

async function customAuth(provider: string, p: Platform, o: Op, input: CallInput, base: { url: string }): Promise<Record<string, string>> {
  if (provider === "xero") {
    const x = await import("../connectors/xero/client.ts");
    return { Authorization: `Bearer ${await x.accessToken()}`, "Xero-Tenant-Id": secret("XERO_TENANT_ID") };
  }
  if (provider === "zoom") {
    const z = await import("../connectors/zoom/client.ts");
    return { Authorization: `Bearer ${await z.accessToken()}` };
  }
  if (provider === "google") {
    const g = await import("../connectors/google-workspace/auth.ts");
    // The mailbox is set by a person in the secret store. A caller may pick another only if it is listed there.
    const home = secret("GOOGLE_MAILBOX");
    const allowed = new Set([home, ...(optional("GOOGLE_ALLOWED_MAILBOXES") ?? "").split(",").map((x) => x.trim()).filter(Boolean)].map((x) => x.toLowerCase()));
    const mailbox = input.as ?? home;
    if (!allowed.has(mailbox.toLowerCase())) throw new Error(`${p.id}: mailbox not allowed; list it in GOOGLE_ALLOWED_MAILBOXES`);
    const scopes = o.scopes.length ? o.scopes : p.defaultScope ? [p.defaultScope] : [];
    if (!scopes.length) throw new Error(`${p.id} ${o.id}: no sign-in scope is mapped for this endpoint`);
    const scope = (o.kind === "read" && scopes.find((s) => s.includes("readonly"))) || scopes[0];
    const h: Record<string, string> = { Authorization: `Bearer ${await g.accessToken(mailbox, scope)}` };
    return h;
  }
  if (provider === "docusign") {
    const d = await import("../connectors/docusign/client.ts");
    const s = await d.session();
    // eSignature endpoints are served from the account's own base URI, not the placeholder in the spec.
    if (new URL(base.url).hostname === "www.docusign.net") base.url = base.url.replace("https://www.docusign.net", new URL(s.base).origin);
    return { Authorization: `Bearer ${s.token}` };
  }
  throw new Error(`${p.id}: unknown auth provider ${provider}`);
}

function appSpec(p: Platform, url: URL, readPost: boolean): AppSpec {
  const envHost = p.hostFromEnv ? Object.values(p.serverVars).map((v) => optional(v.env)).filter(Boolean) as string[] : [];
  return {
    app: p.id, hosts: [...p.hosts, ...envHost],
    hostPattern: p.hostPatterns.length ? new RegExp(`^(?:${p.hostPatterns.join("|")})$`) : undefined,
    readPosts: readPost ? [`${url.hostname}${url.pathname}`] : [],
    keyInPath: p.keyInPath ? new RegExp(p.keyInPath) : undefined,
  };
}

/** Build the request for an endpoint without sending it. Keys are shown as [redacted]. */
export async function plan(id: string, opId: string, input: CallInput = {}, withKeys = false): Promise<Planned> {
  const { platform: p } = load(id);
  const o = describe(id, opId);
  const params: Record<string, unknown> = { ...(input.params ?? {}) };
  for (const [name, pin] of Object.entries(p.pinned ?? {})) {
    if (!o.params.some((x) => x.name === name) && !(o.paramsUnmapped && name in params)) continue;
    let allowed = new Set([...pin.allow, optional(pin.env), ...(pin.envList ? (optional(pin.envList) ?? "").split(",") : [])]
      .map((x) => String(x ?? "").trim().toLowerCase()).filter(Boolean));
    // The Gmail user must be the mailbox that signs in: "me", or exactly the mailbox chosen with `as`.
    if (name === "userId" && input.as) allowed = new Set(["me", input.as.toLowerCase()]);
    if (params[name] === undefined) params[name] = pin.fill === "$env" ? optional(pin.env) : pin.fill;
    if (params[name] !== undefined && !allowed.has(String(params[name]).toLowerCase())) throw new Error(`${id} ${opId}: ${name} must be the client's own (set by ${pin.env})`);
  }
  // A name can appear as both a path part and a query param in some specs: the path part wins.
  const known = new Map<string, Param>();
  for (const x of o.params) if (!known.has(x.name) || x.in === "path") known.set(x.name, x);
  if (o.paramsUnmapped) for (const k of Object.keys(params)) {
    // A declared path part (keyId, code) names a record, so only an exact key name is refused there; any other input is checked in full.
    const declaredPath = o.params.some((x) => x.name === k && x.in === "path");
    if (declaredPath && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && !/^(token|access_?token|api_?key|key|secret|client_?secret|password|passwd|pwd)$/i.test(k)) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || (/token|secret|pass(word|wd)?|key|auth|credential|session|cookie|signature|jwt|bearer|refresh/i.test(k) || /(^|_)(pwd|code|sig)(_|$)/i.test(k))) throw new Error(`${id} ${opId}: param ${k} is not allowed`);
    if (!known.has(k)) known.set(k, { name: k, in: o.method === "GET" ? "query" : "body", required: false, type: "unknown" });
  }
  if (p.style !== "graphql" || o.params.length) {
    for (const k of Object.keys(params)) if (!known.has(k)) throw new Error(`${id} ${opId}: unknown param ${k}`);
  }
  for (const x of o.params) if (x.required && x.in === "path" && (params[x.name] === undefined || params[x.name] === null)) throw new Error(`${id} ${opId}: missing required ${x.name}`);
  for (const x of o.params) if (x.required && x.in !== "path" && params[x.name] === undefined && !(x.in === "body" && input.body !== undefined)) throw new Error(`${id} ${opId}: missing required ${x.name}`);

  const base = serverUrl(p, o, input, withKeys);
  if (p.style === "graphql") return planGraphql(p, o, input, base, withKeys);

  let route = o.path;
  const query: Record<string, string> = {};
  const headers: Record<string, string> = {};
  let bodyFields: Record<string, unknown> | undefined;
  let form: Record<string, string> | undefined;
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const x = known.get(k)!;
    if (x.deny && new RegExp(x.deny, "i").test(typeof v === "object" ? JSON.stringify(v) : String(v))) throw new Error(`${id} ${opId}: ${k} may not ask for that (refused by the kit)`);
    if (x.in === "path") {
      const esc = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      route = route.replace(new RegExp(`\\{${esc}\\}|:${esc}\\b`, "g"), encodePathValue(k, v, x.reserved === true, x.pattern ?? ""));
    } else if (x.in === "query") query[k] = typeof v === "object" ? JSON.stringify(v) : String(v);
    else if (x.in === "header") {
      if (FORBIDDEN_HEADERS.test(k)) throw new Error(`${id} ${opId}: ${k} comes from the secret store, not a param`);
      headers[k] = String(v);
    } else if (x.in === "formData") (form ??= {})[k] = String(v);
    else (bodyFields ??= {})[k] = v; // body, argument
  }
  if (/\{[^}]+\}/.test(route)) throw new Error(`${id} ${opId}: path still has unfilled parts: ${route}`);
  const target = { url: `${base}/${route.replace(/^\/+/, "")}` };
  const auth = withKeys ? await authHeaders(p, o, input, target) : authPreview(p, o);
  const method = (o.method === "QUERY" || o.method === "MUTATION" ? "POST" : o.method) as Method;
  let json: unknown = undefined;
  if (input.body !== undefined || bodyFields) {
    json = bodyFields && input.body && typeof input.body === "object" && !Array.isArray(input.body) ? { ...(input.body as object), ...bodyFields } : (input.body ?? bodyFields);
  }
  const u = new URL(target.url);
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  if (method === "GET" && input.body !== undefined) throw new Error(`${id} ${opId}: a GET takes no body; pass mapped params instead`);
  if (method === "GET" && bodyFields) { // mapped params some specs document as body on a GET (Meta, Telegram): send as query
    for (const [k, v] of Object.entries(bodyFields)) u.searchParams.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    json = undefined;
  }
  return {
    method, url: u.toString(), json, form, kind: o.kind, readPost: o.kind === "read" && method === "POST" && (p.style === "rpc" || o.readPost === true),
    // A vendor-required header on this endpoint (Version, ConsistencyLevel) may replace the platform default, never the key.
    headers: { ...headers, ...auth, ...Object.fromEntries(Object.entries(o.fixedHeaders ?? {}).filter(([k]) => !/^(authorization|cookie|x-api-key)$/i.test(k))) },
  };
}

async function planGraphql(p: Platform, o: Op, input: CallInput, base: string, withKeys: boolean): Promise<Planned> {
  const kind = o.method === "MUTATION" ? "mutation" : "query";
  let document = input.document;
  let variables: Record<string, unknown> = {};
  if (document) checkDocument(document, kind, o.path);
  else {
    if (!GQL_NAME.test(o.path)) throw new Error(`${p.id}: bad field ${o.path}`);
    if (!o.params.length && p.status === "index-only") throw new Error(`${p.id} ${o.id}: arguments are not mapped yet; pass a full document`);
    if (input.select && (!SELECT_OK.test(input.select) || /\b(mutation|subscription|fragment)\b/.test(input.select))) throw new Error("select may only list fields");
    const used = o.params.filter((x) => input.params?.[x.name] !== undefined);
    const decl = used.map((x) => `$${x.name}: ${gqlType(x.type)}`).join(", ");
    const args = used.map((x) => `${x.name}: $${x.name}`).join(", ");
    document = `${kind} Kit${decl ? `(${decl})` : ""} { ${o.path}${args ? `(${args})` : ""}${input.select ? ` { ${input.select} }` : ""} }`;
    variables = Object.fromEntries(used.map((x) => [x.name, input.params![x.name]]));
    checkDocument(document, kind, o.path);
  }
  const target = { url: base };
  const auth = withKeys ? await authHeaders(p, o, input, target) : authPreview(p, o);
  return {
    method: "POST", url: target.url, json: { query: document, variables }, kind: o.kind, readPost: kind === "query",
    headers: auth,
  };
}

/** Call an endpoint. Reads go straight through; writes need KIT_ALLOW_WRITES=1. */
// Only a GET or a GraphQL query can be a read, whatever the label says.
const READPOST_PATH = /(\/search$|\/batch\/read$|\/query$|\/_search$|\/search\/|\/query_)/i;
function opIsRead(p: Platform, o: Op): boolean {
  return o.kind === "read" && (o.method === "GET" || (o.method === "QUERY" && p.style === "graphql")
    || (o.method === "POST" && (p.style === "rpc" || (o.readPost === true && READPOST_PATH.test(o.path)))));
}

export async function callOperation<T = unknown>(id: string, opId: string, input: CallInput = {}): Promise<Reply<T>> {
  const { platform: p } = load(id);
  const o = describe(id, opId);
  const isRead = opIsRead(p, o);
  if (!isRead && !writesAllowed()) throw new WriteBlocked(`${p.id} ${o.method} ${o.path}`);
  if (p.auth.type === "unsupported") throw new Error(`${p.id}: calls are not wired yet (${p.auth.note ?? "auth not supported"})`);
  if (o.authUnsupported) throw new Error(`${p.id}: calls are not wired yet (${o.authUnsupported})`);
  const r = await plan(id, opId, input, true);
  const spec = appSpec(p, new URL(r.url), r.readPost);
  return httpCall<T>(spec, { method: r.method, url: r.url, headers: r.headers, json: r.json, form: r.form, binary: input.binary, signal: input.signal });
}

// A request a vendor SDK has already built (see core/sdk/vendor/). The SDK is only a front end: the
// request must match a mapped endpoint, the read or write rule is ours, the SDK's own key headers are
// dropped and ours are added, and it leaves through the same gate as every other call.
export interface Prepared { method: string; url: string; headers: Record<string, string>; body?: string | Uint8Array; signal?: AbortSignal }

const ROUTES = new Map<string, { o: Op; base: string; re: RegExp; literal: number }[]>();
const PATH_PART = /^(\{[^}]+\}|:[A-Za-z_]\w*)$/;
function routes(p: Platform, ops: Map<string, Op>) {
  let r = ROUTES.get(p.id);
  if (r) return r;
  r = [];
  for (const o of ops.values()) {
    let base: string;
    try { base = serverUrl(p, o, {}, true); } catch { continue; }
    const src = o.path.replace(/^\/+/, "").split(/(\{[^}]+\}|:[A-Za-z_]\w*)/)
      .map((s) => (PATH_PART.test(s) ? "[^/]+" : s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("");
    r.push({ o, base, re: new RegExp(`^/${src}/?$`), literal: o.path.replace(/\{[^}]+\}|:[A-Za-z_]\w*/g, "").length });
  }
  ROUTES.set(p.id, r);
  return r;
}

// Headers a vendor SDK may not choose: keys, hop-by-hop, and its own telemetry about this machine
// (Stripe tags its user agent with the AI agent it finds in the environment).
const SDK_DROP = /^(content-length|connection|keep-alive|transfer-encoding|user-agent|x-stripe-client-user-agent|x-stripe-client-telemetry|x-fern-[a-z-]+)$/i;
// Headers a vendor SDK may send, besides the endpoint's own mapped header params. Anything else is
// refused, not dropped: Stripe-Account or Stripe-Context would act on another account, and a
// method-override header could turn a read into a write.
const SDK_ALLOW = /^(accept|content-type|idempotency-key|stripe-version|square-version)$/i;

export async function sendPrepared(id: string, req: Prepared): Promise<Reply<ArrayBuffer>> {
  const { platform: p, ops } = load(id);
  if (p.style === "graphql") throw new Error(`${id}: vendor SDK requests are not routed for GraphQL platforms`);
  const method = req.method.toUpperCase();
  const u = new URL(req.url);
  const at = `${u.origin}${u.pathname}`;
  const match = routes(p, ops)
    .filter((r) => r.o.method === method && at.startsWith(r.base) && r.re.test(at.slice(r.base.length)))
    .sort((a, b) => b.literal - a.literal)[0];
  // The path is not echoed: it can hold client ids or emails.
  if (!match) throw new Error(`${id}: this ${method} is not a mapped endpoint, refused`);
  const o = match.o;
  // An id that decodes to a slash, a backslash or a dot segment could reach another endpoint once the
  // vendor decodes it, so it is refused (our own layer refuses dot segments the same way).
  for (const seg of at.slice(match.base.length).split("/").filter(Boolean)) {
    let d: string;
    try { d = decodeURIComponent(seg); } catch { throw new Error(`${id}: a path value is not allowed`); }
    if (/[\\/]/.test(d) || d === "." || d === "..") throw new Error(`${id}: a path value is not allowed`);
  }
  const read = opIsRead(p, o);
  if (!read && !writesAllowed()) throw new WriteBlocked(`${p.id} ${o.method} ${o.path}`);
  if (p.auth.type === "unsupported") throw new Error(`${p.id}: calls are not wired yet (${p.auth.note ?? "auth not supported"})`);
  const target = { url: req.url };
  const auth = await authHeaders(p, o, {}, target);
  if (target.url !== req.url) throw new Error(`${id}: this platform moves requests to an account host; not routed for vendor SDKs yet`);
  const fixed = Object.fromEntries(Object.entries(o.fixedHeaders ?? {}).filter(([k]) => !/^(authorization|cookie|x-api-key)$/i.test(k)));
  const ours = new Set([...Object.keys(auth), ...Object.keys(fixed)].map((k) => k.toLowerCase()));
  const mapped = new Set(o.params.filter((x) => x.in === "header").map((x) => x.name.toLowerCase()));
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (FORBIDDEN_HEADERS.test(k) || SDK_DROP.test(k) || ours.has(k.toLowerCase())) continue;
    if (!SDK_ALLOW.test(k) && !mapped.has(k.toLowerCase())) throw new Error(`${id}: header ${k} is not allowed from a vendor SDK`);
    headers[k.toLowerCase() === "accept" ? "Accept" : k] = v;
  }
  Object.assign(headers, fixed, auth);
  const spec = appSpec(p, u, read && method === "POST");
  // xero-node sends "{}" on a GET; real fetch refuses a GET with a body, so it is dropped here.
  const body = method === "GET" ? undefined : req.body;
  return httpCall<ArrayBuffer>(spec, { method: method as Method, url: req.url, headers, body, binary: true, signal: req.signal });
}

/** A platform handle: what each generated index.ts uses. */
export function platform(id: string) {
  return {
    id,
    call: <T = unknown>(opId: string, input?: CallInput) => callOperation<T>(id, opId, input),
    plan: (opId: string, input?: CallInput) => plan(id, opId, input),
    search: (q: string, limit?: number) => search(id, q, limit),
    describe: (opId: string) => describe(id, opId),
  };
}
