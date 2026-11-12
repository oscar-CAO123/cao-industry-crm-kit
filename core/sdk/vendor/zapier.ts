import { vendorRequire } from "./load.ts";
import { gatedFetch, PLACEHOLDER_KEY } from "./gate.ts";

// The SDK also supports arbitrary relay and action execution. This facade deliberately
// exposes only its own account and catalog reads; those other surfaces stay unavailable.
export function zapierFetch(): typeof globalThis.fetch {
  const send = gatedFetch("zapier");
  const allowed = new Set(["/api/v0/sdk/zapier/api/v4/profile/", "/api/v0/sdk/zapier/api/v4/implementations/", "/api/v0/sdk/zapier/api/v4/implementations-meta/lookup/", "/api/v0/sdk/zapier/api/v4/implementations-meta/search/"]);
  const fetch: typeof globalThis.fetch = (input, init = {}) => {
    const u = new URL(input instanceof Request ? input.url : String(input));
    const method = (init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (u.origin !== "https://sdkapi.zapier.com" || !allowed.has(u.pathname) || method !== "GET" || init.body != null || (input instanceof Request && input.body)) throw new Error("Zapier SDK route refused: only current-account profile and catalog GETs are supported");
    return send(u, { method, headers: { accept: "application/json" }, signal: init.signal });
  };
  return fetch;
}
export function zapier() {
  const { createZapierSdk } = vendorRequire("zapier")("@zapier/zapier-sdk");
  const client = createZapierSdk({ credentials: PLACEHOLDER_KEY, fetch: zapierFetch(), eventEmission: { enabled: false } });
  return Object.freeze({ getProfile: () => client.getProfile(), listApps: (options?: any) => client.listApps(options), listActions: (options: any) => client.listActions(options) });
}
