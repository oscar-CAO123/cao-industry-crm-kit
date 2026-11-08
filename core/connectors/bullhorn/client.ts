// Bullhorn sign-in (NEW, 8 Nov 2026). From Bullhorn's own docs, read through endpoint-map/model_guard.py with a watcher
// model: bullhorn.github.io/rest-api-docs and bullhorn.github.io/Getting-Started-with-REST (bullhorn.com links them).
//
//   1. Data centre: GET https://rest.bullhornstaffing.com/rest-services/loginInfo?username={API username}. Its answer
//      holds the user's OAuth and REST URLs. The kit takes them by shape (https://auth-*.bullhornstaffing.com/oauth and
//      https://rest*.bullhornstaffing.com/rest-services) and refuses any other host, so a wrong data centre never needs
//      Bullhorn's 307 redirect (the gate refuses redirects).
//   2. Access token: POST {oauth}/token with grant_type=refresh_token as a FORM body ("keeps your client_secret out of the
//      URL"). The answer may hold a new refresh token, which is saved at once. The access token lasts 10 minutes.
//   3. Session: POST {rest}/login?version=*&access_token=... ("The login call is an HTTP POST request", Getting Started;
//      the reference page's curl example omits the method) returns BhRestToken and the session's restUrl. It is
//      Bullhorn's only supported production login, so the gate allows a key in the query on exactly that path, and
//      treats that POST as a read (it opens a session; it changes no data).
//   4. Calls go to restUrl with the BhRestToken header. The session is reused until a 401, then steps 2 and 3 repeat
//      (Bullhorn rate-limits logins and says never to log in per request).
//
// Keys: BULLHORN_CLIENT_ID, BULLHORN_CLIENT_SECRET, BULLHORN_USERNAME (the API user), and a first BULLHORN_REFRESH_TOKEN
// from the one-time browser authorisation. No password is held by the kit.

import { call, type AppSpec } from "../../lib/http.ts";
import { secret, tokenStore } from "../../lib/secrets.ts";

const HOST = /^(rest|auth)[a-z0-9-]*\.bullhornstaffing\.com$/;
const LOGIN_PATH = /^rest[a-z0-9-]*\.bullhornstaffing\.com\/rest-services\/login$/;
const STORE_KEY = "bullhorn.refresh_token";

export const spec: AppSpec = { app: "bullhorn", hosts: ["rest.bullhornstaffing.com"], hostPattern: HOST, keyInQueryAt: LOGIN_PATH };

let centre: { oauth: string; rest: string } | null = null;
let session: { token: string; restUrl: string } | null = null;

function strings(x: unknown, out: string[] = []): string[] {
  if (typeof x === "string") out.push(x);
  else if (x && typeof x === "object") for (const v of Object.values(x)) strings(v, out);
  return out;
}

function bullhornUrl(s: string, suffix: RegExp): string | null {
  try {
    const u = new URL(s);
    return u.protocol === "https:" && HOST.test(u.hostname) && suffix.test(u.pathname) ? `${u.origin}${u.pathname.replace(/\/+$/, "")}` : null;
  } catch { return null; }
}

async function dataCentre(): Promise<{ oauth: string; rest: string }> {
  if (centre) return centre;
  const r = await call<unknown>(spec, { url: "https://rest.bullhornstaffing.com/rest-services/loginInfo", query: { username: secret("BULLHORN_USERNAME") } });
  const all = strings(r.data);
  const oauth = all.map((s) => bullhornUrl(s, /^\/oauth\/?$/)).find(Boolean);
  const rest = all.map((s) => bullhornUrl(s, /^\/rest-services\/?$/)).find(Boolean);
  if (!oauth || !rest || !new URL(oauth).hostname.startsWith("auth")) throw new Error("bullhorn: loginInfo did not return a Bullhorn OAuth and REST URL");
  centre = { oauth, rest };
  return centre;
}

async function accessToken(): Promise<string> {
  const { oauth } = await dataCentre();
  const store = tokenStore();
  const refresh = (await store.get(STORE_KEY)) ?? secret("BULLHORN_REFRESH_TOKEN");
  const tokenUrl = `${oauth}/token`;
  const r = await call<any>({ ...spec, readPosts: [`${new URL(tokenUrl).hostname}${new URL(tokenUrl).pathname}`] }, {
    method: "POST", url: tokenUrl, retries: 0,
    form: { grant_type: "refresh_token", refresh_token: refresh, client_id: secret("BULLHORN_CLIENT_ID"), client_secret: secret("BULLHORN_CLIENT_SECRET") },
  });
  if (r.data?.refresh_token) await store.set(STORE_KEY, String(r.data.refresh_token));
  if (!r.data?.access_token) throw new Error("bullhorn: no access token returned; the refresh token may need a new one-time authorisation");
  return String(r.data.access_token);
}

/** The current REST session, logging in only when there is none (Bullhorn rate-limits logins). */
export async function login(): Promise<{ token: string; restUrl: string }> {
  if (session) return session;
  const { rest } = await dataCentre();
  const loginUrl = new URL(`${rest}/login`);
  const r = await call<any>({ ...spec, readPosts: [`${loginUrl.hostname}${loginUrl.pathname}`] }, { method: "POST", url: loginUrl.toString(), query: { version: "*", access_token: await accessToken() }, retries: 0 });
  const restUrl = bullhornUrl(String(r.data?.restUrl ?? ""), /^\/rest-services\/[^/]+\/?$/);
  if (!r.data?.BhRestToken || !restUrl) throw new Error("bullhorn: login did not return a session token and a Bullhorn REST URL");
  session = { token: String(r.data.BhRestToken), restUrl };
  return session;
}

/** Drop the session after a 401, so the next call refreshes and logs in again. */
export function invalidate(): void { session = null; }
export function clearForTests(): void { session = null; centre = null; }
