import { vendorRequire } from "./load.ts";
import { gatedFetch, PLACEHOLDER_KEY } from "./gate.ts";
export function hubspotAlpha() {
  const { HubSpot } = vendorRequire("hubspot-sdk")("@hubspot/sdk");
  const send = gatedFetch("hubspot");
  const fetch: typeof globalThis.fetch = (input, init = {}) => {
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
    for (const name of [...headers.keys()]) if (name.startsWith("x-stainless-")) headers.delete(name);
    return send(input, { ...init, headers });
  };
  return new HubSpot({ baseURL: "https://api.hubapi.com", accessToken: PLACEHOLDER_KEY, fetch, maxRetries: 0, logLevel: "off" });
}
