import { createRequire } from "node:module";
import { vendorRequire } from "./load.ts";
import { PLACEHOLDER_KEY } from "./gate.ts";
import { axiosAdapter } from "./axios.ts";
export function woocommerce() {
  const site = process.env.WOOCOMMERCE_SITE ?? "";
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(site)) throw new Error("WOOCOMMERCE_SITE must be a hostname");
  const req = vendorRequire("woocommerce"), mod = req("@woocommerce/woocommerce-rest-api");
  const axios = createRequire(req.resolve("@woocommerce/woocommerce-rest-api"))("axios");
  const config = Object.freeze({ adapter: axiosAdapter("woocommerce", axios) });
  const client = new (mod.default ?? mod)({ url: `https://${site}`, consumerKey: PLACEHOLDER_KEY, consumerSecret: PLACEHOLDER_KEY, version: "wc/v3", queryStringAuth: false, axiosConfig: config });
  return Object.freeze(client);
}
