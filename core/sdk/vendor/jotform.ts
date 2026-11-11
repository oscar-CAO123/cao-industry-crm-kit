import { createRequire } from "node:module";
import { vendorRequire } from "./load.ts";
import { PLACEHOLDER_KEY } from "./gate.ts";
import { axiosAdapter } from "./axios.ts";
export function jotform() {
  const req = vendorRequire("jotform"), pkg = req("jotform");
  const client = new pkg.default(PLACEHOLDER_KEY);
  const inner = client.user.client.inner;
  delete inner.defaults.params.apiKey;
  const axios = createRequire(req.resolve("jotform"))("axios");
  const adapter = axiosAdapter("jotform", axios);
  inner.interceptors.request.use((config: any) => { config.adapter = adapter; return config; });
  return client;
}
