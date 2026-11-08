// The one way a helper talks to an outside app. Ported from the CAO CRM's read-only fetch gate
// (scripts/lib-read-only-fetch.ts) and its write rule (KIT_ALLOW_WRITES above every network write).
//
// Rules, enforced here so no helper can forget them:
// - https only, and only to the hosts the app declares.
// - A token in the query string is refused. Keys go in headers.
// - Redirects are not followed, so a header carrying a key is never replayed to another host.
// - Anything that changes data needs KIT_ALLOW_WRITES=1. Without it the call is refused before a
//   socket opens and a WriteBlocked error describes what would have been sent.
// - POST-shaped reads (GraphQL queries, token exchanges, free/busy) are allowed only on the exact
//   paths the app lists in readPosts.
// - Errors carry the status and path, never the response body: bodies can hold client data.
// - Logs never print query values, bodies or keys.

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface AppSpec {
  app: string;
  hosts: string[];
  /** For apps that serve from regional subdomains (Zoom downloads, DocuSign accounts). */
  hostPattern?: RegExp;
  /** host + path prefixes where a POST only reads, such as a token exchange or a GraphQL query. */
  readPosts?: string[];
  /** The API puts the key in the URL path (Telegram). Paths are redacted in logs. */
  keyInPath?: RegExp;
  /** First wait before a retry when the app gives no Retry-After. Doubles each time, capped at 60s. */
  retryBaseMs?: number;
}

export interface CallOptions {
  method?: Method;
  url: string;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined | null>;
  json?: unknown;
  /** Form fields; ordered pairs allow a repeated key (Twilio lists). */
  form?: Record<string, string> | [string, string][];
  /** A body already encoded by a vendor SDK, sent as is with the caller's Content-Type. */
  body?: string | Uint8Array;
  /** Return the body as bytes, for documents and recordings. */
  binary?: boolean;
  /**
   * File downloads only (GET): follow up to 3 redirects to the file's storage. The key stays on
   * when the redirect lands on one of the app's hosts and is dropped when it leaves them, as a
   * browser does. Every other call refuses redirects.
   */
  followDownloadRedirects?: boolean;
  /** Cancels the request, as the CRM's helpers allow (an AbortSignal). */
  signal?: AbortSignal;
  retries?: number;
}

export interface Reply<T> {
  status: number;
  headers: Headers;
  data: T;
}

export class WriteBlocked extends Error {
  planned: string;
  constructor(planned: string) {
    super(`write blocked (set KIT_ALLOW_WRITES=1 to allow): ${planned}`);
    this.name = "WriteBlocked";
    this.planned = planned;
  }
}

export class ApiError extends Error {
  status: number;
  app: string;
  constructor(app: string, status: number, where: string) {
    super(`${app} ${where} failed with status ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.app = app;
  }
}

export interface Transport {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
}

const realTransport: Transport = {
  fetch: (...a) => fetch(...a),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  log: (line) => { if (process.env.KIT_LOG !== "0") console.error(line); },
};
let transport: Transport = realTransport;

/** Tests swap the network for a fake. */
export function setTransport(t: Partial<Transport> | null): void {
  transport = t ? { ...realTransport, ...t } : realTransport;
}

export const writesAllowed = (): boolean => process.env.KIT_ALLOW_WRITES === "1";

const TOKEN_IN_QUERY = /(^|[?&])(access_token|refresh_token|id_token|token|access-token|api_key|apikey|key)=/i;
/** Key-like parameter names, compared after decoding and dropping punctuation, so access%5Ftoken and Api-Key are caught. */
const KEY_NAMES = new Set(["accesstoken", "refreshtoken", "idtoken", "sessiontoken", "token", "apikey", "key", "secret", "clientsecret", "password", "authtoken", "bearer"]);
const RETRY_STATUS = new Set([429, 502, 503, 504]);

function buildUrl(o: CallOptions): URL {
  const u = new URL(o.url);
  for (const [k, v] of Object.entries(o.query ?? {})) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  return u;
}

/** Email addresses in a path (Zoom users, calendar ids) are client data, so logs and errors show [email]. */
function redactPath(p: string): string {
  let d = p;
  try { d = decodeURIComponent(p); } catch { /* keep as is */ }
  return d.replace(/[^\s/@]+@[^\s/@]+\.[^\s/@]+/g, "[email]");
}

function where(spec: AppSpec, method: Method, u: URL): string {
  const path = spec.keyInPath ? u.pathname.replace(spec.keyInPath, "/***") : u.pathname;
  return `${method} ${u.hostname}${redactPath(path)}`;
}

/** Throws unless the URL is one this app may reach. Exported for tests and for links an API hands back. */
export function checkUrl(spec: AppSpec, u: URL): void {
  if (u.protocol !== "https:") throw new Error(`${spec.app}: ${u.protocol} refused, https only`);
  if (u.port !== "") throw new Error(`${spec.app}: port ${u.port} refused, standard https only`);
  if (u.username || u.password) throw new Error(`${spec.app}: credentials in a URL are refused`);
  if (!spec.hosts.includes(u.hostname) && !spec.hostPattern?.test(u.hostname)) throw new Error(`${spec.app}: host ${u.hostname} is not one of this app's hosts`);
  const keyish = [...u.searchParams.keys()].some((k) => KEY_NAMES.has(k.toLowerCase().replace(/[^a-z]/g, "")));
  if (TOKEN_IN_QUERY.test(u.search) || keyish) throw new Error(`${spec.app}: a key in the query string is refused, use a header`);
}

export function isRead(spec: AppSpec, method: Method, u: URL): boolean {
  if (method === "GET") return true;
  if (method !== "POST") return false;
  const target = `${u.hostname}${u.pathname}`;
  return (spec.readPosts ?? []).some((p) => target === p || target.startsWith(p.endsWith("/") ? p : `${p}/`));
}

export async function call<T = unknown>(spec: AppSpec, o: CallOptions): Promise<Reply<T>> {
  const method = o.method ?? "GET";
  const u = buildUrl(o);
  checkUrl(spec, u);
  const w = where(spec, method, u);
  if (!isRead(spec, method, u) && !writesAllowed()) throw new WriteBlocked(w);

  const headers: Record<string, string> = { Accept: o.binary ? "*/*" : "application/json", ...(o.headers ?? {}) };
  let body: string | Uint8Array | undefined;
  if (o.json !== undefined) { body = JSON.stringify(o.json); headers["Content-Type"] = "application/json"; }
  else if (o.form) { body = new URLSearchParams(o.form).toString(); headers["Content-Type"] = "application/x-www-form-urlencoded"; }
  else if (o.body !== undefined) body = o.body;

  const write = !isRead(spec, method, u);
  const max = o.retries ?? 3;
  for (let attempt = 0; ; attempt++) {
    const t0 = Date.now();
    let res = await transport.fetch(u.toString(), { method, headers, body, redirect: "manual", signal: o.signal });
    transport.log(`[${spec.app}] ${w} ${res.status} ${Date.now() - t0}ms`);
    if (o.followDownloadRedirects && method === "GET") {
      let at = u;
      for (let hop = 0; hop < 3 && res.status >= 300 && res.status < 400; hop++) {
        const loc = res.headers.get("location");
        if (!loc) break;
        const next = new URL(loc, at);
        if (next.protocol !== "https:") throw new Error(`${spec.app}: redirect to ${next.protocol} refused`);
        const own = spec.hosts.includes(next.hostname) || !!spec.hostPattern?.test(next.hostname);
        // Another host gets only harmless headers: every sign-in header (Authorization, X-Api-Key, any vendor key header) stays behind.
        const h2 = own ? headers : Object.fromEntries(Object.entries(headers).filter(([k]) => /^(accept|accept-encoding|accept-language|user-agent|range|if-none-match|if-modified-since)$/i.test(k)));
        res = await transport.fetch(next.toString(), { method: "GET", headers: h2, redirect: "manual", signal: o.signal });
        transport.log(`[${spec.app}] redirect to ${own ? next.hostname : "storage host"} ${res.status}`);
        at = next;
      }
    }
    // A write is retried only when the app said it did not process it (429). Retrying a write on a
    // 5xx could do it twice.
    const retryable = write ? res.status === 429 : RETRY_STATUS.has(res.status);
    if (retryable && attempt < max) {
      const after = Number(res.headers.get("retry-after"));
      await transport.sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 60) * 1000 : Math.min((spec.retryBaseMs ?? 1000) * 2 ** attempt, 60_000));
      continue;
    }
    if (res.status >= 300) throw new ApiError(spec.app, res.status, w);
    let data: unknown;
    if (o.binary) data = await res.arrayBuffer();
    else if (res.status === 204) data = null;
    else {
      const text = await res.text();
      const type = res.headers.get("content-type") ?? "";
      data = type.includes("json") || /^\s*[[{]/.test(text) ? safeJson(text) : text;
    }
    return { status: res.status, headers: res.headers, data: data as T };
  }
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}

/** Describe a write without sending it, for dry runs and plans. */
export function plan(spec: AppSpec, o: CallOptions): string {
  const method = o.method ?? "GET";
  const u = buildUrl(o);
  checkUrl(spec, u);
  return where(spec, method, u);
}
