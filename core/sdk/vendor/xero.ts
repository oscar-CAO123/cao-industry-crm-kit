// Xero's official SDK (xero-node, pinned 20.1.0, audited 8 Nov 2026) running behind the kit's gate.
//
// xero-node takes no custom client: its API classes call the shared axios instance directly. So this
// file swaps that axios instance's adapter for the gate, which covers every request the API classes make.
// Only the API classes are exported. XeroClient is never used: its consent, callback, refresh and revoke
// go through openid-client on Node's own http, which would bypass the gate. Sign-in stays in
// core/connectors/xero/client.ts, and the tenant header is always ours.

import { createRequire } from "node:module";
import { gatedFetch, PLACEHOLDER_KEY } from "./gate.ts";

const require = createRequire(import.meta.url);
const xero = require("xero-node");
// The exact axios copy xero-node loads (its CommonJS build), not the ESM one an import would give.
const axios = createRequire(require.resolve("xero-node"))("axios");
const send = gatedFetch("xero");

async function adapter(config: any) {
  const url = axios.getUri(config);
  const raw = typeof config.headers?.toJSON === "function" ? config.headers.toJSON() : { ...(config.headers ?? {}) };
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) if (v !== undefined && v !== null && v !== false) headers[k] = String(v);
  const res = await send(url, { method: String(config.method ?? "get").toUpperCase(), headers, body: config.data ?? undefined, signal: config.signal });
  const bytes = Buffer.from(await res.arrayBuffer());
  const response = {
    data: config.responseType === "arraybuffer" ? bytes : bytes.toString("utf8"),
    status: res.status, statusText: res.statusText, headers: Object.fromEntries(res.headers), config, request: {},
  };
  if (!config.validateStatus || config.validateStatus(res.status)) return response;
  throw new axios.AxiosError(`Request failed with status code ${res.status}`, axios.AxiosError.ERR_BAD_RESPONSE, config, {}, response);
}
axios.defaults.adapter = adapter;

function api<T>(Api: new () => T): T {
  const a: any = new Api();
  a.accessToken = PLACEHOLDER_KEY;
  return a as T;
}

export function xeroApis() {
  return {
    accounting: api(xero.AccountingApi), assets: api(xero.AssetApi), projects: api(xero.ProjectApi), files: api(xero.FilesApi),
    payrollAU: api(xero.PayrollAuApi), payrollNZ: api(xero.PayrollNzApi), payrollUK: api(xero.PayrollUkApi),
    bankFeeds: api(xero.BankFeedsApi), finance: api(xero.FinanceApi), appStore: api(xero.AppStoreApi),
  };
}
