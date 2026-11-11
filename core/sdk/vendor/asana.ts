import { vendorRequire } from "./load.ts";
import { PLACEHOLDER_KEY } from "./gate.ts";
import { gateSuperagent } from "./superagent.ts";
export function asana(apiName: string) {
  const req = vendorRequire("asana");
  gateSuperagent("asana", req, "asana");
  const mod = req("asana");
  if (!/^[A-Z][A-Za-z]+Api$/.test(apiName) || typeof mod[apiName] !== "function") throw new Error("unknown Asana resource API");
  const client = new mod.ApiClient();
  client.authentications.token.accessToken = PLACEHOLDER_KEY;
  return new mod[apiName](client);
}
