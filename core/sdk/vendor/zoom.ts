import { createRequire } from "node:module";
import { vendorRequire } from "./load.ts";
import { PLACEHOLDER_KEY } from "./gate.ts";
import { axiosAdapter } from "./axios.ts";
const products = { meetings: "Meetings", users: "Users", phone: "Phone", accounts: "Accounts", teamchat: "TeamChat", videosdk: "VideoSdk", marketplace: "Marketplace", commerce: "Commerce", chatbot: "Chatbot" } as const;
export function zoom(product: keyof typeof products = "meetings") {
  if (!Object.hasOwn(products, product)) throw new Error("unknown Zoom product");
  const req = vendorRequire("zoom"), name = `@zoom/rivet/${product}`, mod = req(name);
  const axios = createRequire(req.resolve(name))("axios");
  const adapter = axiosAdapter("zoom", axios);
  axios.interceptors.request.use((config: any) => { config.adapter = adapter; return config; });
  const Api = mod[`${products[product]}Endpoints`];
  if (!Api) throw new Error("this Zoom product has no resource endpoints");
  return new Api({ auth: { getToken: () => PLACEHOLDER_KEY } });
}
