import path from "node:path";
import { vendorRequire } from "./load.ts";
import { gatedFetch } from "./gate.ts";
// Use generated resource APIs with their documented httpApi configuration. The root OAuth client is excluded.
export function hubspotLegacy(group: string, apiName: string) {
  if (!/^[a-z]+(?:\/[a-z]+)*$/.test(group) || !/^[A-Z][A-Za-z]+Api$/.test(apiName) || group === "oauth") throw new Error("unknown HubSpot resource API");
  const req = vendorRequire("hubspot-api-client");
  const dir = path.join(path.dirname(req.resolve("@hubspot/api-client")), "codegen", group);
  const { createConfiguration } = req(path.join(dir, "configuration.js"));
  const { ResponseContext } = req(path.join(dir, "http/http.js"));
  const { from } = req(path.join(dir, "rxjsStub.js"));
  const { [apiName]: Api } = req(path.join(dir, "index.js"));
  if (typeof Api !== "function") throw new Error("unknown HubSpot resource API");
  const send = gatedFetch("hubspot");
  const httpApi = { send(request: any) { return from(send(request.getUrl(), { method: request.getHttpMethod(), headers: request.getHeaders(), body: request.getBody() }).then((r) => new ResponseContext(r.status, Object.fromEntries(r.headers), { text: () => r.text(), binary: async () => Buffer.from(await r.arrayBuffer()) }))); } };
  return new Api(createConfiguration({ httpApi }));
}
