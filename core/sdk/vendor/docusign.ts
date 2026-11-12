// Only eSignature resource classes are exposed. Authentication stays in the kit.
// The SDK's isolated axios copy is permanently routed through the mapped endpoint gate.
import { createRequire } from "node:module";
import { vendorRequire } from "./load.ts";
import { axiosAdapter } from "./axios.ts";
import { PLACEHOLDER_KEY } from "./gate.ts";

let loaded: any;
export function docusign(apiName: string) {
  if (!loaded) {
    const req = vendorRequire("docusign");
    const mod = req("docusign-esign");
    const axios = createRequire(req.resolve("docusign-esign"))("axios");
    const adapter = axiosAdapter("docusign", axios);
    axios.defaults.adapter = (config: any) => {
      for (const key of Object.keys(config.headers ?? {})) if (/^(node-ver|x-docusign-sdk)$/i.test(key)) delete config.headers[key];
      return adapter(config);
    };
    loaded = mod;
  }
  if (!/^[A-Z][A-Za-z]+Api$/.test(apiName) || typeof loaded[apiName] !== "function") throw new Error("unknown DocuSign resource API");
  const client = new loaded.ApiClient();
  client.setBasePath("https://www.docusign.net/restapi");
  client.addDefaultHeader("Authorization", `Bearer ${PLACEHOLDER_KEY}`);
  return new loaded[apiName](client);
}
