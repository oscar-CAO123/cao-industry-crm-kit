import { microsoftInput } from "./microsoft-scope.ts";
import { composioEnabled, composioHttpCall } from "./composio.ts";
import { encodeMultipart, type UploadPart } from "./multipart.ts";
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
import { createHmac } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { call as httpCall, writesAllowed, WriteBlocked, ApiError, type AppSpec, type Method, type Reply } from "../lib/http.ts";
import { secret, optional } from "../lib/secrets.ts";
import { encodeForm, type FormArrays } from "../lib/form.ts";

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
  /** The vendor's spec accepts only this body encoding (no JSON): "form" (Stripe v1, Twilio) or "multipart" (uploads). */
  bodyType?: "form" | "multipart";
  /** Query or form fields the endpoint always sends (AroFlo's zone), set by the generator, first in order. */
  fixedQuery?: Record<string, string>;
  fixedForm?: Record<string, string>;
  dropboxContent?: "upload" | "download";
  msadsRest?: boolean;
}
export interface Auth {
  type: "bearer" | "basic" | "header" | "path-token" | "custom" | "unsupported" | "template" | "body-key";
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
  /** How form-encoded lists are written: a[0]=x (default, Stripe) or a=x&a=y (Twilio). */
  formArrays?: FormArrays;
  /** How a list value goes in the query. repeat: key=a&key=b (AroFlo). brackets: key[]=a&key[]=b, for params the vendor names with [] (Cliniko q[]).
   *  comma: key=a,b in one value (Productive include, sort). Unset: the value is sent as one JSON string. */
  queryArrays?: "repeat" | "brackets" | "comma";
  /** An object value for a query param is flattened the deepObject way: key[field]=v, key[field][op]=v (Productive filter). Unset: one JSON string. */
  queryObjects?: "deepObject";
}
export interface CallInput {
  /** Explicit vendor field names with text or base64 file data; safe to persist for approval. */
  multipart?: UploadPart[];
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
  /** Base64 file bytes for a mapped Dropbox content upload. */
  contentBase64?: string;
  signal?: AbortSignal;
}
export interface Planned { method: Method; url: string; headers: Record<string, string>; json?: unknown; form?: Record<string, string> | [string, string][]; body?: string | Uint8Array; multipart?: { name: string; bytes: number; filename?: string; contentType?: string }[]; kind: "read" | "write"; readPost: boolean }

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
// Acting as another user or overriding the method is never a caller param: that is a decision for the secret store, not an agent.
// (A vendor SDK that sends one of these is refused loudly in sendPrepared, which is why this list is separate.)
const FORBIDDEN_PARAM_HEADERS = /^(x-impersonate-[a-z-]+|on-behalf-of|stripe-account|stripe-context|x-http-method-override|x-method-override|x-http-method)$/i;

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
/** Braces and brackets must close in order and never close more than they opened, so a select cannot end the field it sits in and start a new root field. */
export function balanced(s: string): boolean {
  let brace = 0, paren = 0, inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (c === "\\") i++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") brace++;
    else if (c === "}") { if (--brace < 0) return false; }
    else if (c === "(") paren++;
    else if (c === ")") { if (--paren < 0) return false; }
  }
  return brace === 0 && paren === 0 && !inStr;
}
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
  if (a.type === "custom" && a.provider === "bullhorn") h.BhRestToken = "[from the Bullhorn session login]";
  else if (a.type === "custom" && !["unleashed", "aroflo"].includes(a.provider ?? "")) h.Authorization = `[from the ${a.provider} sign-in]`;
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
    case "body-key": break; // injected into the JSON body after caller inputs are checked
    case "path-token": break; // filled into the server URL; logs redact it
    case "template": h[a.header!] = String(a.template).replace(/\{([A-Z][A-Z0-9_]+)\}/g, (_, n: string) => secret(n)); break;
    case "custom": Object.assign(h, await customAuth(a.provider!, p, o, input, base)); break;
    case "unsupported": throw new Error(`${p.id}: calls are not wired yet (${a.note ?? "auth not supported"})`);
  }
  return h;
}

async function customAuth(provider: string, p: Platform, o: Op, input: CallInput, base: { url: string }): Promise<Record<string, string>> {
  // Request-signing schemes sign the final URL, so their headers are added by signRequest() once the query is set.
  if (provider === "unleashed" || provider === "aroflo") return {};
  if (provider === "bullhorn") {
    // Calls go to the session's own restUrl (swimlane host and corpToken) with the BhRestToken header.
    const b = await import("../connectors/bullhorn/client.ts");
    const s = await b.login();
    const generic = "https://rest.bullhornstaffing.com/rest-services";
    if (base.url.startsWith(generic)) base.url = s.restUrl + base.url.slice(generic.length);
    return { BhRestToken: s.token };
  }
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
    const s = await d.session(o.scopes ?? []);
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

/** A list sent as repeated or comma-joined values: each item must be a plain value; with noComma, no item may hold a comma. */
function listValues(id: string, opId: string, name: string, v: unknown[], noComma = false): string[] {
  return v.map((x) => {
    if (x === null || (typeof x !== "string" && typeof x !== "number" && typeof x !== "boolean")) throw new Error(`${id} ${opId}: ${name} takes plain values only`);
    const s = String(x);
    if (noComma && s.includes(",")) throw new Error(`${id} ${opId}: a ${name} value may not hold a comma`);
    return s;
  });
}

const DEEP_FIELD = /^[A-Za-z0-9_.-]{1,64}$/;
/** deepObject query: name[field][sub]=value for each nested field. A list at the end is one comma-separated value. */
function deepPairs(id: string, opId: string, name: string, v: unknown, depth = 0): [string, string][] {
  if (v === undefined || v === null) return [];
  if (depth > 4) throw new Error(`${id} ${opId}: ${name} nests too deeply`);
  if (Array.isArray(v)) return [[name, listValues(id, opId, name, v, true).join(",")]];
  if (typeof v === "object") {
    return Object.entries(v as Record<string, unknown>).flatMap(([field, x]) => {
      if (!DEEP_FIELD.test(field)) throw new Error(`${id} ${opId}: ${name} has a field name that is not allowed`);
      return deepPairs(id, opId, `${name}[${field}]`, x, depth + 1);
    });
  }
  return [[name, String(v)]];
}

/** Build the request for an endpoint without sending it. Keys are shown as [redacted]. */
export async function plan(id: string, opId: string, input: CallInput = {}, withKeys = false, managed = false): Promise<Planned> {
  const { platform: p } = load(id);
  const o = describe(id, opId);
  if (id === "microsoft-advertising" && o.msadsRest) input = microsoftInput(o, input);
  if (input.contentBase64 !== undefined && o.dropboxContent !== "upload") throw new Error(`${id} ${opId}: file content is not accepted`);
  if (input.multipart !== undefined && o.bodyType !== "multipart") throw new Error(`${id} ${opId}: this operation is not mapped as multipart`);
  if (o.bodyType === "multipart" && (input.multipart === undefined || input.body !== undefined)) throw new Error(`${id} ${opId}: supply multipart parts instead of a JSON body`);
  const params: Record<string, unknown> = { ...(input.params ?? {}) };
  for (const [name, pin] of Object.entries(p.pinned ?? {})) {
    if (!o.params.some((x) => x.name === name) && !(o.paramsUnmapped && name in params)) continue;
    let allowed = new Set([...pin.allow, optional(pin.env), ...(pin.envList ? (optional(pin.envList) ?? "").split(",") : [])]
      .map((x) => String(x ?? "").trim().toLowerCase()).filter(Boolean));
    if (managed && id === "google-workspace" && name === "userId") allowed = new Set(["me", secret("KIT_GOOGLE_WORKSPACE_COMPOSIO_MAILBOX").trim().toLowerCase()]);
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
  for (const x of o.params) if (x.required && x.in !== "path" && params[x.name] === undefined && !(x.in === "body" && input.body !== undefined) && !(o.bodyType === "multipart" && ["body", "form", "formData"].includes(x.in) && input.multipart?.some((part) => part.name === x.name))) throw new Error(`${id} ${opId}: missing required ${x.name}`);

  const base = serverUrl(p, o, input, withKeys || managed);
  if (p.style === "graphql") return planGraphql(p, o, input, base, withKeys, managed);

  let route = o.path;
  const query: Record<string, string> = {};
  const headers: Record<string, string> = {};
  let bodyFields: Record<string, unknown> | undefined;
  let form: Record<string, string> | undefined;
  const repeats: [string, string][] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const x = known.get(k)!;
    if (x.deny && new RegExp(x.deny, "i").test(typeof v === "object" ? JSON.stringify(v) : String(v))) throw new Error(`${id} ${opId}: ${k} may not ask for that (refused by the kit)`);
    if (x.in === "path") {
      const esc = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      route = route.replace(new RegExp(`\\{${esc}\\}|:${esc}\\b`, "g"), encodePathValue(k, v, x.reserved === true, x.pattern ?? ""));
    } else if (x.in === "query") {
      if (Array.isArray(v) && p.queryArrays === "repeat") repeats.push(...v.map((s) => [k, String(s)] as [string, string]));
      else if (Array.isArray(v) && p.queryArrays === "brackets" && k.endsWith("[]")) repeats.push(...listValues(id, opId, k, v).map((s) => [k, s] as [string, string]));
      else if (Array.isArray(v) && p.queryArrays === "comma") query[k] = listValues(id, opId, k, v, true).join(",");
      else if (v && typeof v === "object" && p.queryObjects === "deepObject") repeats.push(...deepPairs(id, opId, k, v));
      else query[k] = typeof v === "object" ? JSON.stringify(v) : String(v);
    }
    else if (x.in === "header") {
      if (FORBIDDEN_HEADERS.test(k) || FORBIDDEN_PARAM_HEADERS.test(k)) throw new Error(`${id} ${opId}: ${k} comes from the secret store, not a param`);
      headers[k] = String(v);
    } else if (x.in === "formData") (form ??= {})[k] = String(v);
    else (bodyFields ??= {})[k] = v; // body, argument
  }
  if (/[{}]/.test(route)) throw new Error(`${id} ${opId}: path still has unfilled parts: ${route}`);
  // Some vendor specs put the base path in both the server and every op path (Productive /api/v2, Cin7 /api,
  // Supermetrics /enterprise/v2). Join them once, never twice.
  const basePath = new URL(base).pathname.replace(/\/+$/, "");
  if (basePath && route.startsWith(basePath + "/")) route = route.slice(basePath.length);
  // A dot segment in an operation path would let a declared route resolve to a different one on the same host.
  if (route.split("/").some((seg) => seg === "." || seg === ".." || /^%2e/i.test(seg))) throw new Error(`${id} ${opId}: dot segments in the path are refused`);
  const target = { url: `${base}/${route.replace(/^\/+/, "")}` };
  const auth = managed ? {} : withKeys ? await authHeaders(p, o, input, target) : authPreview(p, o);
  if (managed && id === "docusign" && new URL(target.url).hostname === "www.docusign.net") {
    const session = await (await import("../connectors/docusign/client.ts")).session(o.scopes ?? []);
    target.url = target.url.replace("https://www.docusign.net", new URL(session.base).origin);
  }
  const method = (o.method === "QUERY" || o.method === "MUTATION" ? "POST" : o.method) as Method;
  let json: unknown = undefined;
  if (input.body !== undefined || bodyFields) {
    json = bodyFields && input.body && typeof input.body === "object" && !Array.isArray(input.body) ? { ...(input.body as object), ...bodyFields } : (input.body ?? bodyFields);
  }
  const scheme = o.auth ?? p.auth;
  if (scheme.type === "body-key") {
    if (method !== "POST" || (json !== undefined && (!json || typeof json !== "object" || Array.isArray(json)))) throw new Error(`${id} ${opId}: expected a JSON object`);
    if (json && Object.keys(json).some((k) => k.toLowerCase() === "key")) throw new Error(`${id} ${opId}: key comes from the secret store`);
    json = { ...(json as Record<string, unknown> ?? {}), key: withKeys ? secret(scheme.env!) : `[from ${scheme.env}]` };
  }
  let dropboxBytes: Uint8Array | undefined;
  if (o.dropboxContent) {
    if (input.body !== undefined || (json !== undefined && (!json || typeof json !== "object" || Array.isArray(json)))) throw new Error(`${id} ${opId}: supply mapped file arguments as params`);
    const arg = JSON.stringify(json ?? {}).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
    headers["Dropbox-API-Arg"] = arg;
    json = undefined;
    if (o.dropboxContent === "upload") {
      const b = input.contentBase64;
      if (b === undefined || b.length > 13981016 || b.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b)) throw new Error(`${id} ${opId}: supply valid base64 content up to 10 MiB`);
      dropboxBytes = Buffer.from(b, "base64");
      if (Buffer.from(dropboxBytes).toString("base64") !== b || dropboxBytes.byteLength > 10 * 1024 * 1024) throw new Error(`${id} ${opId}: content exceeds 10 MiB`);
      headers["Content-Type"] = "application/octet-stream";
    }
  }
  const u = new URL(target.url);
  for (const [k, v] of Object.entries(o.fixedQuery ?? {})) u.searchParams.set(k, v);
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  for (const [k, v] of repeats) u.searchParams.append(k, v);
  if (method === "GET" && input.body !== undefined) throw new Error(`${id} ${opId}: a GET takes no body; pass mapped params instead`);
  if (method === "GET" && bodyFields) { // mapped params some specs document as body on a GET (Meta, Telegram): send as query
    for (const [k, v] of Object.entries(bodyFields)) u.searchParams.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    json = undefined;
  }
  // The vendor accepts only form encoding for this body (Stripe v1, Twilio): encode it the way its own SDK does.
  let formOut: Record<string, string> | [string, string][] | undefined = form;
  if (o.bodyType === "form" && method !== "GET" && json !== undefined) {
    formOut = [...Object.entries(form ?? {}), ...encodeForm(json, p.formArrays ?? "indices")];
    json = undefined;
  }
  // AroFlo signs the exact query or form string, built as its reference script does (encodeURIComponent per value).
  let rawBody: string | undefined;
  if ((o.auth ?? p.auth).provider === "aroflo") {
    // AroFlo signs only the query or the form string it builds itself; a caller body would go unsigned, so refuse it.
    if (input.body !== undefined) throw new Error(`${id} ${opId}: AroFlo takes its fields as params (postxml), not a body`);
    const enc = (pairs: [string, string][]) => pairs.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
    const q = enc([...u.searchParams]);
    u.search = q ? `?${q}` : "";
    if (method !== "GET") { rawBody = enc([...Object.entries(o.fixedForm ?? {}), ...Object.entries((formOut as Record<string, string>) ?? {})]); formOut = undefined; }
  }
  let upload: Awaited<ReturnType<typeof encodeMultipart>> | undefined;
  if (o.bodyType === "multipart") {
    if (json !== undefined || formOut !== undefined || rawBody !== undefined) throw new Error(`${id} ${opId}: upload fields must be explicit multipart parts`);
    upload = await encodeMultipart(input.multipart!);
  }
  return {
    method, url: u.toString(), json, form: formOut, body: upload ? (withKeys ? upload.body : undefined) : (dropboxBytes ? (withKeys ? dropboxBytes : undefined) : rawBody), ...(upload ? { multipart: upload.summary } : dropboxBytes ? { multipart: [{ name: "content", bytes: dropboxBytes.byteLength }] } : {}), kind: o.kind, readPost: o.kind === "read" && method === "POST" && (p.style === "rpc" || o.readPost === true),
    // A vendor-required header on this endpoint (Version, ConsistencyLevel) may replace the platform default, never the key.
    headers: { ...headers, ...auth, ...Object.fromEntries(Object.entries(o.fixedHeaders ?? {}).filter(([k]) => !/^(authorization|cookie|x-api-key)$/i.test(k))), ...(managed ? {} : withKeys ? signRequest(p, o, u, rawBody) : signPreview(p, o)), ...(upload ? { "Content-Type": upload.contentType } : {}) },
  };
}

// Schemes that sign each request over its final URL (8 Nov 2026, each from the vendor's own docs):
// - Unleashed (apidocs.unleashedsoftware.com/AuthenticationHelp): api-auth-signature = base64 HMAC-SHA256 of the query
//   string only (no "?", empty when there is none) keyed with the API key, plus api-auth-id, client-type, and JSON
//   Content-Type and Accept on every request.
// - AroFlo (apidocs.aroflo.com collection, its pre-request script "that you must replicate"): Authentication = "HMAC " +
//   hex HMAC-SHA512, keyed with the secret key, of [method, HostIP if used, urlPath "", accept, Authorization, ISO UTC
//   timestamp, the query string (GET) or form string (POST)] joined with "+"; Authorization = uencoded, pencoded and
//   orgEncoded, each URI-encoded; afdatetimeutc = the same timestamp. Hex is CryptoJS's default toString().
function signRequest(p: Platform, o: Op, u: URL, rawBody?: string): Record<string, string> {
  const a = o.auth ?? p.auth;
  if (a.type === "custom" && a.provider === "aroflo") {
    const method = o.method.toUpperCase();
    const accept = "text/json";
    const authorization = `uencoded=${encodeURIComponent(secret("AROFLO_UENCODED"))}&pencoded=${encodeURIComponent(secret("AROFLO_PENCODED"))}&orgEncoded=${encodeURIComponent(secret("AROFLO_ORGENCODED"))}`;
    const ts = new Date().toISOString();
    const hostIp = optional("AROFLO_HOST_IP");
    const varString = method === "GET" ? u.search.replace(/^\?/, "") : rawBody ?? "";
    const payload = [method, ...(hostIp ? [hostIp] : []), "", accept, authorization, ts, varString].join("+");
    return {
      Authentication: `HMAC ${createHmac("sha512", secret("AROFLO_SECRET_KEY")).update(payload, "utf8").digest("hex")}`,
      Authorization: authorization, Accept: accept, afdatetimeutc: ts, ...(hostIp ? { HostIP: hostIp } : {}),
      ...(method !== "GET" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    };
  }
  if (a.type === "custom" && a.provider === "unleashed") {
    const query = u.search.replace(/^\?/, "");
    return {
      "api-auth-id": secret("UNLEASHED_API_ID"),
      "api-auth-signature": createHmac("sha256", secret("UNLEASHED_API_KEY")).update(query, "utf8").digest("base64"),
      "client-type": secret("UNLEASHED_CLIENT_TYPE"), Accept: "application/json", "Content-Type": "application/json",
    };
  }
  return {};
}
function signPreview(p: Platform, o: Op): Record<string, string> {
  const a = o.auth ?? p.auth;
  if (a.type === "custom" && a.provider === "aroflo") return { Authentication: "[HMAC-SHA512 with AROFLO_SECRET_KEY]", Authorization: "[from AROFLO_UENCODED + AROFLO_PENCODED + AROFLO_ORGENCODED]", afdatetimeutc: "[now, ISO UTC]" };
  if (a.type === "custom" && a.provider === "unleashed") return { "api-auth-id": "[from UNLEASHED_API_ID]", "api-auth-signature": "[HMAC-SHA256 of the query string with UNLEASHED_API_KEY]", "client-type": "[from UNLEASHED_CLIENT_TYPE]" };
  return {};
}

async function planGraphql(p: Platform, o: Op, input: CallInput, base: string, withKeys: boolean, managed = false): Promise<Planned> {
  const kind = o.method === "MUTATION" ? "mutation" : "query";
  let document = input.document;
  let variables: Record<string, unknown> = {};
  if (document) checkDocument(document, kind, o.path);
  else {
    if (!GQL_NAME.test(o.path)) throw new Error(`${p.id}: bad field ${o.path}`);
    if (!o.params.length && p.status === "index-only") throw new Error(`${p.id} ${o.id}: arguments are not mapped yet; pass a full document`);
    if (input.select && (!SELECT_OK.test(input.select) || /\b(mutation|subscription|fragment)\b/.test(input.select) || !balanced(input.select))) throw new Error("select may only list fields");
    const used = o.params.filter((x) => input.params?.[x.name] !== undefined);
    const decl = used.map((x) => `$${x.name}: ${gqlType(x.type)}`).join(", ");
    const args = used.map((x) => `${x.name}: $${x.name}`).join(", ");
    document = `${kind} Kit${decl ? `(${decl})` : ""} { ${o.path}${args ? `(${args})` : ""}${input.select ? ` { ${input.select} }` : ""} }`;
    variables = Object.fromEntries(used.map((x) => [x.name, input.params![x.name]]));
    checkDocument(document, kind, o.path);
  }
  const target = { url: base };
  const auth = managed ? {} : withKeys ? await authHeaders(p, o, input, target) : authPreview(p, o);
  return {
    method: "POST", url: target.url, json: { query: document, variables }, kind: o.kind, readPost: kind === "query",
    headers: auth,
  };
}

/** Call an endpoint. Reads go straight through; writes need KIT_ALLOW_WRITES=1. */
// Only a GET or a GraphQL query can be a read, whatever the label says.
// Square names its searches /search-catalog-items and its batch reads /batch-retrieve or /bulk-retrieve (9 Nov 2026).
// Microsoft Advertising REST reads are POSTs: Gets, and report requests that only queue a report file for the configured account.
const MSADS_READ = /^(campaign-management\.Get|customer-management\.Get|reporting\.(Submit|Poll)GenerateReport$)/;
export const READPOST_PATH = /(\/search$|\/batch\/read$|\/query$|\/_search$|\/search\/|\/query_|\/search-[a-z-]+$|-retrieve$)/i;
function opIsRead(p: Platform, o: Op): boolean {
  return o.kind === "read" && (o.method === "GET" || (o.method === "QUERY" && p.style === "graphql")
    || (o.method === "POST" && (p.style === "rpc" || (o.readPost === true && (READPOST_PATH.test(o.path) || (p.id === "microsoft-advertising" && o.msadsRest === true && MSADS_READ.test(o.id)))))));
}

// Only ordinary OAuth/bearer-style sign-ins can be replaced by a managed connection.
// Tenant headers are configuration, not credentials; keep this allowlist deliberately narrow.
function managedHeaders(p: Platform, o: Op, input?: CallInput): Record<string, string> {
  const a = o.auth ?? p.auth;
  if (p.id === "google-workspace") secret("KIT_GOOGLE_WORKSPACE_COMPOSIO_MAILBOX");
  if (["body-key", "path-token", "template", "unsupported"].includes(a.type) ||
      (a.type === "custom" && !["google", "xero", "zoom", "docusign"].includes(a.provider ?? "")) || p.keyInPath ||
      Object.values(p.serverVars).some((v) => v.secret) || input?.as ||
      Object.keys(a.optionalHeaders ?? {}).length)
    throw new Error(`${p.id}: this operation or authentication is not supported by Composio transport`);
  const allowed = /^(api-version|version|notion-version|x-myobapi-version|procore-company-id|x-organization-id|account_id|x-tenant)$/i;
  const headers: Record<string, string> = {};
  if (a.type === "custom" && a.provider === "xero") headers["Xero-Tenant-Id"] = secret("XERO_TENANT_ID");
  for (const [name, env] of Object.entries(a.extraHeaders ?? {})) {
    if (!allowed.test(name)) throw new Error(`${p.id}: required header ${name} is not supported by Composio transport`);
    headers[name] = env.startsWith("=") ? env.slice(1) : secret(env);
  }
  return headers;
}

export async function callOperation<T = unknown>(id: string, opId: string, input: CallInput = {}): Promise<Reply<T>> {
  const { platform: p } = load(id);
  const o = describe(id, opId);
  const isRead = opIsRead(p, o);
  if (!isRead && !writesAllowed()) throw new WriteBlocked(`${p.id} ${o.method} ${o.path}`);
  if (p.auth.type === "unsupported") throw new Error(`${p.id}: calls are not wired yet (${p.auth.note ?? "auth not supported"})`);
  if (o.authUnsupported) throw new Error(`${p.id}: calls are not wired yet (${o.authUnsupported})`);
  if (composioEnabled(id)) {
    const extra = managedHeaders(p, o, input);
    const request = await plan(id, opId, input, true, true);
    const managedNames = new Set(Object.keys(extra).map((name) => name.toLowerCase()));
    request.headers = { ...Object.fromEntries(Object.entries(request.headers).filter(([name]) => !managedNames.has(name.toLowerCase()))), ...extra };
    return composioHttpCall<T>(appSpec(p, new URL(request.url), request.readPost), { method: request.method, url: request.url, headers: request.headers, json: request.json, form: request.form, body: request.body, binary: input.binary || o.dropboxContent === "download", signal: input.signal }, isRead);
  }
  const r = await plan(id, opId, input, true);
  const spec = appSpec(p, new URL(r.url), r.readPost);
  const send = (q: Planned) => httpCall<T>(appSpec(p, new URL(q.url), q.readPost), { method: q.method, url: q.url, headers: q.headers, json: q.json, form: q.form, body: q.body, binary: input.binary || describe(id, opId).dropboxContent === "download", signal: input.signal });
  try {
    return await send(r);
  } catch (e) {
    // Bullhorn: an expired session answers 401; refresh and log in once more, then retry this call once.
    if ((o.auth ?? p.auth).provider === "bullhorn" && e instanceof ApiError && e.status === 401) {
      (await import("../connectors/bullhorn/client.ts")).invalidate();
      return send(await plan(id, opId, input, true));
    }
    throw e;
  }
}

// A request a vendor SDK has already built (see core/sdk/vendor/). The SDK is only a front end: the
// request must match a mapped endpoint, the read or write rule is ours, the SDK's own key headers are
// dropped and ours are added, and it leaves through the same gate as every other call.
export interface Prepared { method: string; url: string; headers: Record<string, string>; body?: string | Uint8Array; signal?: AbortSignal }

const ROUTES = new Map<string, { o: Op; base: string; re: RegExp; literal: number }[]>();
const PATH_PART = /^(\{[^}]+\}|:[A-Za-z_]\w*)$/;
function routePattern(o: Op): string {
  return o.path.split(/(\{[^}]+\}|:[A-Za-z_]\w*)/).map((part) => {
    if (!PATH_PART.test(part)) return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const name = part[0] === "{" ? part.slice(1, -1) : part.slice(1);
    return o.params.some((p) => p.in === "path" && p.name === name && p.reserved) ? "(.+?)" : "([^/]+)";
  }).join("");
}
function routes(p: Platform, ops: Map<string, Op>) {
  let r = ROUTES.get(p.id);
  if (r) return r;
  r = [];
  for (const o of ops.values()) {
    let base: string;
    try { base = serverUrl(p, o, {}, true).replace(/\/+$/, ""); } catch { continue; }
    const src = routePattern(o).replace(/^\/+/, "");
    r.push({ o, base, re: new RegExp(`^/${src}/?$`), literal: o.path.replace(/\{[^}]+\}|:[A-Za-z_]\w*/g, "").length });
  }
  ROUTES.set(p.id, r);
  return r;
}

// Headers a vendor SDK may not choose: keys, hop-by-hop, and its own telemetry about this machine
// (Stripe tags its user agent with the AI agent it finds in the environment).
const SDK_DROP = /^(content-length|connection|keep-alive|transfer-encoding|user-agent|x-stripe-client-user-agent|x-stripe-client-telemetry|x-fern-[a-z-]+|x-goog-api-client|accept-charset|accept-encoding|x-goog-request-params)$/i;
// Headers a vendor SDK may send, besides the endpoint's own mapped header params. Anything else is
// refused, not dropped: Stripe-Account or Stripe-Context would act on another account, and a
// method-override header could turn a read into a write.
const SDK_ALLOW = /^(accept|content-type|idempotency-key|stripe-version|square-version)$/i;

export async function sendPrepared(id: string, req: Prepared): Promise<Reply<ArrayBuffer>> {
  const { platform: p, ops } = load(id);
  if (id === "microsoft-advertising") throw new Error(`${id}: vendor SDK requests are not routed until account scope can be validated`);
  const managed = composioEnabled(id);
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
  if (o.dropboxContent) throw new Error(`${id}: vendor SDK content requests are not routed`);
  if ((o.auth ?? p.auth).type === "body-key") throw new Error(`${id}: vendor SDK requests with body-key authentication are not routed`);
  // An id that decodes to a slash, a backslash or a dot segment could reach another endpoint once the
  // vendor decodes it, so it is refused (our own layer refuses dot segments the same way).
  for (const seg of at.slice(match.base.length).split("/").filter(Boolean)) {
    let d: string;
    try { d = decodeURIComponent(seg); } catch { throw new Error(`${id}: a path value is not allowed`); }
    if (/[\\/]/.test(d) || d === "." || d === "..") throw new Error(`${id}: a path value is not allowed`);
  }
  // Recover named path values to apply the same client-account pins as plan().
  const names: string[] = [];
  for (const part of o.path.matchAll(/\{([^}]+)\}|:([A-Za-z_]\w*)/g)) names.push(part[1] ?? part[2]);
  const captures = new RegExp(`^${routePattern(o)}/?$`).exec(at.slice(match.base.length));
  if (!captures) throw new Error(`${id}: a path value is not allowed`);
  names.forEach((name, i) => {
    const param = o.params.find((x) => x.in === "path" && x.name === name);
    if (!param?.reserved) return;
    let value: string;
    try { value = captures[i + 1].split("/").map(decodeURIComponent).join("/"); }
    catch { throw new Error(`${id}: a path value is not allowed`); }
    encodePathValue(name, value, true, param.pattern ?? "");
  });
  for (const [name, pin] of Object.entries(p.pinned ?? {})) {
    const ix = names.indexOf(name);
    const values = [...(ix >= 0 && captures ? [decodeURIComponent(captures[ix + 1])] : []), ...u.searchParams.getAll(name)];
    const allowed = managed && id === "google-workspace" && name === "userId"
      ? new Set(["me", secret("KIT_GOOGLE_WORKSPACE_COMPOSIO_MAILBOX").trim().toLowerCase()])
      : new Set([...pin.allow, optional(pin.env), ...(pin.envList ? (optional(pin.envList) ?? "").split(",") : [])].map((x) => String(x ?? "").trim().toLowerCase()).filter(Boolean));
    if (values.some((value) => !allowed.has(value.toLowerCase()))) throw new Error(`${id}: ${name} must be the client's own (set by ${pin.env})`);
  }
  const read = opIsRead(p, o);
  if (!read && !writesAllowed()) throw new WriteBlocked(`${p.id} ${o.method} ${o.path}`);
  if (p.auth.type === "unsupported") throw new Error(`${p.id}: calls are not wired yet (${p.auth.note ?? "auth not supported"})`);
  if (o.authUnsupported) throw new Error(`${p.id}: calls are not wired yet (${o.authUnsupported})`);
  const target = { url: req.url };
  const auth = managed ? managedHeaders(p, o) : await authHeaders(p, o, {}, target);
  if (managed && id === "docusign" && u.origin === "https://www.docusign.net") {
    const session = await (await import("../connectors/docusign/client.ts")).session(o.scopes ?? []);
    target.url = req.url.replace("https://www.docusign.net", new URL(session.base).origin);
  }
  const resolved = new URL(target.url);
  const permittedDocuSignRewrite = id === "docusign" && u.origin === "https://www.docusign.net" && resolved.protocol === "https:" && !resolved.port && !resolved.username && !resolved.password && /^[a-z0-9-]+\.docusign\.net$/.test(resolved.hostname) && resolved.pathname === u.pathname && resolved.search === u.search && resolved.hash === u.hash;
  if (target.url !== req.url && !permittedDocuSignRewrite) throw new Error(`${id}: this platform moves requests to an account host; not routed for vendor SDKs yet`);
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
  const spec = appSpec(p, new URL(target.url), read && method === "POST");
  // xero-node sends "{}" on a GET; real fetch refuses a GET with a body, so it is dropped here.
  const body = method === "GET" ? undefined : req.body;
  return httpCall<ArrayBuffer>(spec, { method: method as Method, url: target.url, headers, body, binary: true, signal: req.signal });
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
