import { createRequire } from "node:module";
import { vendorRequire } from "./load.ts";
import { PLACEHOLDER_KEY } from "./gate.ts";
import { axiosAdapter } from "./axios.ts";

export function gohighlevel() {
  const req = vendorRequire("gohighlevel");
  const { HighLevel } = req("@gohighlevel/api-client");
  const client = new HighLevel({ privateIntegrationToken: PLACEHOLDER_KEY, logLevel: "silent" });
  const axios = createRequire(req.resolve("@gohighlevel/api-client"))("axios");
  const adapter = axiosAdapter("gohighlevel", axios);
  // SDK methods accept per-call Axios options, including adapter. Force the gate after
  // those options have been merged, so an alternate adapter cannot be supplied per call.
  client.httpClient.interceptors.request.use((config: any) => { config.headers.delete("x-sdk-version"); config.adapter = adapter; return config; });
  return client;
}
