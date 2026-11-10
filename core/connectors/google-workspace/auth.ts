// Source, from the reference CRM at commit 28aa5d91 unless marked NEW:
//   delegated login    scripts/lib-google-dwd.ts getDWDToken, scripts/crm-email-drafter.ts getGoogleAccessToken
//   OAuth refresh mode NEW: from Google's OAuth docs, not yet run in production
//
// Google login, two ways:
// 1. Workspace domain-wide delegation (GOOGLE_SERVICE_ACCOUNT_JSON, raw or base64): a service
//    account acts as one mailbox. This is how the reference CRM reads and drafts (scripts/lib-google-dwd.ts).
// 2. A user's OAuth refresh token (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and the token saved in the
//    token store as google.refresh_token.<mailbox with @ as _>), for businesses without Workspace admin access.
// Ask for the narrowest scope a workflow needs. DWD scope matching is exact, so the admin console
// must list the same scope string.

import { call, type AppSpec } from "../../lib/http.ts";
import { optional, secret, tokenStore } from "../../lib/secrets.ts";
import { jsonKey, pem, signJwt } from "../../lib/jwt.ts";

export const spec: AppSpec = {
  app: "google",
  hosts: ["oauth2.googleapis.com", "gmail.googleapis.com", "www.googleapis.com", "sheets.googleapis.com"],
  readPosts: ["oauth2.googleapis.com/token", "www.googleapis.com/calendar/v3/freeBusy"],
};

export const SCOPES = {
  gmailRead: "https://www.googleapis.com/auth/gmail.readonly",
  gmailDraft: "https://www.googleapis.com/auth/gmail.compose",
  calendarRead: "https://www.googleapis.com/auth/calendar.readonly",
  calendarWrite: "https://www.googleapis.com/auth/calendar.events",
  sheetsRead: "https://www.googleapis.com/auth/spreadsheets.readonly",
  sheetsWrite: "https://www.googleapis.com/auth/spreadsheets",
} as const;

const cache = new Map<string, { token: string; until: number }>();

/** Token store key for a mailbox. An email address is not a safe file name, so "@" and other characters become "_". */
export const refreshKey = (mailbox: string): string => `google.refresh_token.${mailbox.toLowerCase().replace(/[^a-z0-9._-]/g, "_")}`;

export async function accessToken(mailbox: string, scope: string): Promise<string> {
  const key = `${mailbox}|${scope}`;
  const hit = cache.get(key);
  if (hit && hit.until > Date.now() + 60_000) return hit.token;
  const sa = optional("GOOGLE_SERVICE_ACCOUNT_JSON");
  let data: { access_token?: string; expires_in?: number };
  if (sa) {
    const acct = jsonKey<{ client_email: string; private_key: string }>(sa);
    const now = Math.floor(Date.now() / 1000);
    const assertion = signJwt({ iss: acct.client_email, sub: mailbox, scope, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }, pem(acct.private_key));
    data = (await call<any>(spec, { method: "POST", url: "https://oauth2.googleapis.com/token", json: { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }, retries: 1 })).data;
  } else {
    const refresh = await tokenStore().get(refreshKey(mailbox));
    if (!refresh) throw new Error(`No Google login for ${mailbox}: set GOOGLE_SERVICE_ACCOUNT_JSON for Workspace, or save that user's refresh token.`);
    data = (await call<any>(spec, {
      method: "POST", url: "https://oauth2.googleapis.com/token",
      form: { grant_type: "refresh_token", refresh_token: refresh, client_id: secret("GOOGLE_CLIENT_ID"), client_secret: secret("GOOGLE_CLIENT_SECRET") },
      retries: 1,
    })).data;
  }
  if (!data?.access_token) throw new Error(`Google login failed for ${mailbox}. Check the scope is allowed for this account.`);
  cache.set(key, { token: data.access_token, until: Date.now() + (data.expires_in ?? 3600) * 1000 });
  return data.access_token;
}

export function clearTokenCache(): void { cache.clear(); }
