import { createRequire } from "node:module";
import { vendorRequire } from "./load.ts";
import { PLACEHOLDER_KEY } from "./gate.ts";
import { axiosAdapter } from "./axios.ts";
function containsToken(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return false;
  if (typeof value !== "object") throw new Error("Meta SDK body must contain only JSON data");
  if (seen.has(value)) throw new Error("Meta SDK body must not be cyclic");
  const proto = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) throw new Error("Meta SDK body must contain only plain data");
  seen.add(value);
  return Object.entries(value).some(([key, child]) => key.toLowerCase() === "access_token" || containsToken(child, seen));
}
export function metaAds() {
  const req = vendorRequire("meta-ads"), mod = req("facebook-nodejs-business-sdk");
  if (process.env.META_GRAPH_VERSION !== mod.FacebookAdsApi.VERSION) throw new Error(`Set META_GRAPH_VERSION=${mod.FacebookAdsApi.VERSION} to match the pinned Meta SDK`);
  const axios = createRequire(req.resolve("facebook-nodejs-business-sdk"))("axios");
  const gate = axiosAdapter("meta-ads", axios);
  const adapter = (config: any) => {
    const url = new URL(axios.getUri(config));
    const token = url.searchParams.get("access_token");
    if (token !== null && token !== PLACEHOLDER_KEY) throw new Error("Meta SDK credentials belong to the kit secret store");
    url.searchParams.delete("access_token");
    return gate({ ...config, url: url.href, baseURL: undefined, params: undefined });
  };
  axios.interceptors.request.use((config: any) => {
    if (config.data != null && typeof config.data !== "object") throw new Error("Meta SDK body must be structured data");
    if (config.data != null && containsToken(config.data)) throw new Error("Meta SDK credentials belong to the kit secret store");
    config.adapter = adapter;
    return config;
  });
  const api = new mod.FacebookAdsApi(PLACEHOLDER_KEY, "en_US", false);
  return { api, object(name: string, id: string) {
    if (!/^[A-Z][A-Za-z0-9]+$/.test(name) || typeof mod[name] !== "function" || !mod[name].Fields) throw new Error("unknown Meta resource");
    return new mod[name](id, undefined, undefined, api);
  } };
}
