import { createRequire } from "node:module";
import { vendorRequire } from "./load.ts";
import { PLACEHOLDER_KEY } from "./gate.ts";
import { axiosAdapter } from "./axios.ts";
export function klaviyo(apiName: string) {
  const req = vendorRequire("klaviyo"), mod = req("klaviyo-api");
  if (!/^[A-Z][A-Za-z]+Api$/.test(apiName) || typeof mod[apiName] !== "function" || apiName === "OAuthApi") throw new Error("unknown Klaviyo resource API");
  const axios = createRequire(req.resolve("klaviyo-api"))("axios");
  const adapter = axiosAdapter("klaviyo", axios);
  const session = new mod.ApiKeySession(PLACEHOLDER_KEY, new mod.RetryWithExponentialBackoff({numRetries: 0}));
  session.requestWithRetry = (config: any) => axios.request({ ...config, adapter });
  return new mod[apiName](session);
}
