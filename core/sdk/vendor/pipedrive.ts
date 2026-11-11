import { createRequire } from "node:module";
import { vendorRequire } from "./load.ts";
import { PLACEHOLDER_KEY } from "./gate.ts";
import { axiosAdapter } from "./axios.ts";
export function pipedrive(apiName: string, version: "v1" | "v2" = "v2") {
  if (!["v1", "v2"].includes(version) || !/^[A-Z][A-Za-z]+Api$/.test(apiName)) throw new Error("unknown Pipedrive API");
  const req = vendorRequire("pipedrive"), mod = req(`pipedrive/${version}`);
  if (typeof mod[apiName] !== "function") throw new Error("unknown Pipedrive API");
  const client = new mod[apiName](new mod.Configuration({ accessToken: PLACEHOLDER_KEY }));
  const axios = createRequire(req.resolve("pipedrive"))("axios");
  const adapter = axiosAdapter("pipedrive", axios);
  client.axios.interceptors.request.use((config: any) => { config.adapter = adapter; return config; });
  return client;
}
