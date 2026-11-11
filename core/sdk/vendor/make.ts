import { vendorRequire } from "./load.ts";
import { gatedFetch, PLACEHOLDER_KEY } from "./gate.ts";
export function make() {
  const { Make } = vendorRequire("make")("@makehq/sdk");
  const zone = process.env.MAKE_ZONE || "eu1";
  if (!/^(eu1|eu2|us1|us2)$/.test(zone)) throw new Error("MAKE_ZONE is not an allowed Make zone");
  const send = gatedFetch("make");
  class GatedMake extends Make {
    handleRequest(url: string, options: RequestInit) {
      const u = new URL(url);
      if (u.protocol !== "https:" || u.hostname !== `${zone}.make.com`) throw new Error("Make SDK requests must use the client's configured zone");
      return send(url, options);
    }
  }
  return new GatedMake(PLACEHOLDER_KEY, `${zone}.make.com`, { retry: { maxRetries: 0 } });
}
