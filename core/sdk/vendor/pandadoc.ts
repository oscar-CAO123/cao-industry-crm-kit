import path from "node:path";
import { vendorRequire } from "./load.ts";
import { gatedFetch } from "./gate.ts";
export function pandadoc(apiName: string) {
  const req = vendorRequire("pandadoc"), mod = req("pandadoc-node-client");
  if (!/^[A-Z][A-Za-z]+Api$/.test(apiName) || typeof mod[apiName] !== "function") throw new Error("unknown PandaDoc API");
  const dir = path.dirname(req.resolve("pandadoc-node-client"));
  const { ResponseContext } = req(path.join(dir, "http/http.js"));
  const { from } = req(path.join(dir, "rxjsStub.js"));
  const send = gatedFetch("pandadoc");
  const httpApi = { send(request: any) { return from(send(request.getUrl(), { method: request.getHttpMethod(), headers: request.getHeaders(), body: request.getBody() }).then((r) => new ResponseContext(r.status, Object.fromEntries(r.headers), { text: () => r.text(), binary: async () => Buffer.from(await r.arrayBuffer()) }))); } };
  return new mod[apiName](mod.createConfiguration({ httpApi }));
}
