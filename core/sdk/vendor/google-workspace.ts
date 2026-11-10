// Google's discovery clients construct requests; the kit owns authentication and transport.
import { createRequire } from "node:module";
import { vendorRequire } from "./load.ts";
import { gatedFetch } from "./gate.ts";
const versions = { admin: "directory_v1", calendar: "v3", docs: "v1", drive: "v3", gmail: "v1", sheets: "v4" } as const;
export function googleWorkspace(service: keyof typeof versions) {
  if (!Object.hasOwn(versions, service)) throw new Error("unknown Google Workspace SDK");
  const req = vendorRequire(`googleapis-${service}`);
  const pkg = `@googleapis/${service}`;
  const mod = req(pkg);
  const common = createRequire(req.resolve(pkg));
  const { Gaxios } = createRequire(common.resolve("googleapis-common"))("gaxios");
  const transport = new Gaxios();
  const send = gatedFetch("google-workspace");
  const auth = {
    request(options: any) { return transport.request({ ...options, retry: false, fetchImplementation: send }); },
    getRequestHeaders() { throw new Error("Google SDK HTTP/2 is not supported by the kit gate"); },
  };
  return mod[service]({ version: versions[service], auth });
}
